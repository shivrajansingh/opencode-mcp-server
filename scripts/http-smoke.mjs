#!/usr/bin/env node
/** HTTP transport smoke test: auth rejection + a real MCP handshake over Streamable HTTP. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

const base = process.env.OPENCODE_MCP_HTTP_URL ?? "http://127.0.0.1:7777"
const tokenPath =
  process.env.OPENCODE_MCP_TOKEN_PATH ?? path.join(os.homedir(), ".config", "opencode-mcp", "http-token")
const token = process.env.OPENCODE_MCP_TOKEN ?? (await fs.readFile(tokenPath, "utf8")).trim()

let failures = 0
const check = (name, condition, detail) => {
  console.log(`${condition ? "  ok  " : "FAIL  "}${name}${condition || !detail ? "" : ` — ${detail}`}`)
  if (!condition) failures += 1
}

const unauthorized = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
})
check("rejects missing token", unauthorized.status === 401, `status ${unauthorized.status}`)

const health = await fetch(`${base}/healthz`)
check("healthz responds", health.ok, `status ${health.status}`)

const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
})
const client = new Client({ name: "http-smoke", version: "0.0.1" })
await client.connect(transport)
try {
  const tools = await client.listTools()
  check("lists 18 tools over HTTP", tools.tools.length === 18, `${tools.tools.length}`)
  const status = await client.callTool({ name: "opencode_status", arguments: {} })
  const text = (status.content ?? []).map((part) => part.text ?? "").join("")
  check("status reachable over HTTP", text.includes('"connected": true'), text.slice(0, 160))
} finally {
  await client.close().catch(() => {})
}

console.log(failures === 0 ? "\nHTTP smoke passed." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
