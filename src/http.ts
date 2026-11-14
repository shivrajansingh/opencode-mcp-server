import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomUUID, timingSafeEqual, randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { log } from "./log.js"

export interface HttpOptions {
  host: string
  port: number
  configure?: (input: { url?: string; password?: string; persist?: boolean; test?: boolean }) => Promise<unknown>
  clearConfig?: (options: { includeFile?: boolean }) => Promise<unknown>
}

const TOKEN_PATH = path.join(os.homedir(), ".config", "opencode-mcp", "http-token")

async function resolveToken(): Promise<string> {
  if (process.env.OPENCODE_MCP_TOKEN) return process.env.OPENCODE_MCP_TOKEN
  try {
    const existing = (await fs.readFile(TOKEN_PATH, "utf8")).trim()
    if (existing) return existing
  } catch {
    // fall through and create one
  }
  const token = randomBytes(32).toString("base64url")
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true, mode: 0o700 })
  await fs.writeFile(TOKEN_PATH, token + "\n", { mode: 0o600 })
  log.warn(`Generated a bridge token at ${TOKEN_PATH}`)
  return token
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export async function startHttpServer(factory: () => McpServer, options: HttpOptions): Promise<void> {
  const token = await resolveToken()
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const http = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)

      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (url.pathname === "/configure") {
        if (!authorized(req, token)) {
          res.writeHead(401, { "www-authenticate": 'Bearer realm="opencode-mcp"' })
          res.end(JSON.stringify({ error: "unauthorized" }))
          return
        }
        if (req.method === "POST" && options.configure) {
          const body = (await readJsonBody(req)) as { url?: string; password?: string; persist?: boolean; test?: boolean } | undefined
          const state = await options.configure(body ?? {})
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(state))
          return
        }
        if (req.method === "DELETE" && options.clearConfig) {
          const state = await options.clearConfig({})
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(state))
          return
        }
        res.writeHead(405).end()
        return
      }

      if (url.pathname !== "/mcp") {
        res.writeHead(404).end("Not found")
        return
      }

      if (!authorized(req, token)) {
        res.writeHead(401, { "www-authenticate": 'Bearer realm="opencode-mcp"' })
        res.end(JSON.stringify({ error: "unauthorized" }))
        return
      }

      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        res.writeHead(405).end()
        return
      }

      const sessionID = headerValue(req.headers["mcp-session-id"])
      let transport = sessionID ? transports.get(sessionID) : undefined

      if (!transport) {
        if (req.method !== "POST") {
          res.writeHead(400).end(JSON.stringify({ error: "missing mcp-session-id" }))
          return
        }
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, created)
            log.info(`HTTP session ${id} opened`)
          },
        })
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId)
        }
        const server = factory()
        await server.connect(created)
        transport = created
      }

      const body = req.method === "POST" ? await readJsonBody(req) : undefined
      await transport.handleRequest(req as IncomingMessage, res as ServerResponse, body)
    } catch (error) {
      log.error("HTTP request failed", { error: error instanceof Error ? error.message : String(error) })
      if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: "internal_error" }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject)
    http.listen(options.port, options.host, () => resolve())
  })
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = headerValue(req.headers.authorization)
  if (!header) return false
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return false
  return safeEqual(match[1] ?? "", token)
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > 25 * 1024 * 1024) throw new Error("Request body too large")
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : undefined
}
