import path from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { OpenCodeBridge } from "./client.js"
import { readServiceFile, OPENCODE_SERVICE_PATHS } from "./discovery.js"
import { setRuntimeConfig } from "./config.js"
import { log, registerSecret } from "./log.js"
import { registerTools, type ToolProfile } from "./tools/index.js"
import type { ServerContext } from "./tools/shared.js"

declare const __APP_VERSION__: string

const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0"

interface CliOptions {
  command: "serve" | "configure" | "status" | "help" | "version"
  http: boolean
  host: string
  port: number
  url?: string
  password?: string
  directory?: string
  allowRemoteUrl: boolean
  readOnly: boolean
  allowFullHistory: boolean
  profile: ToolProfile
  discover: boolean
  json: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "serve",
    http: false,
    host: "127.0.0.1",
    port: 7777,
    allowRemoteUrl: false,
    readOnly: false,
    allowFullHistory: /^(1|true|yes)$/i.test(process.env.OPENCODE_MCP_ALLOW_FULL_HISTORY ?? ""),
    profile: "full",
    discover: false,
    json: false,
  }

  const args = [...argv]
  for (const command of ["configure", "status", "help", "serve"] as const) {
    const index = args.indexOf(command)
    if (index >= 0) {
      options.command = command
      args.splice(index, 1)
      break
    }
  }

  while (args.length > 0) {
    const arg = args.shift()!
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const next = () => inline ?? args.shift()
    switch (flag) {
      case "--http":
        options.http = true
        break
      case "--host":
        options.host = next() ?? options.host
        break
      case "--port":
        options.port = Number(next() ?? options.port)
        break
      case "--url":
        options.url = next()
        break
      case "--password":
        options.password = next()
        break
      case "--directory":
        options.directory = next()
        break
      case "--allow-remote-url":
        options.allowRemoteUrl = true
        break
      case "--read-only":
        options.readOnly = true
        break
      case "--allow-full-history":
        options.allowFullHistory = true
        break
      case "--profile": {
        const value = next()
        options.profile = value === "minimal" ? "minimal" : "full"
        break
      }
      case "--discover":
        options.discover = true
        break
      case "--json":
        options.json = true
        break
      case "-h":
      case "--help":
        options.command = "help"
        break
      case "-v":
      case "--version":
        options.command = "version"
        break
      default:
        if (arg.startsWith("-")) {
          process.stderr.write(`Unknown option: ${arg}\n`)
          options.command = "help"
        }
    }
  }
  return options
}

const HELP = `opencode-mcp-server ${VERSION}

Expose an OpenCode v2 server to any MCP client (Codex, Claude, Anti-Gravity, ...).

Usage:
  opencode-mcp-server                      Run over stdio (default)
  opencode-mcp-server --http --port 7777   Run the Streamable HTTP transport
  opencode-mcp-server configure --url http://127.0.0.1:4096
  opencode-mcp-server status [--json]

Configuration (required):
  OPENCODE_URL         OpenCode server address, e.g. http://127.0.0.1:4096
  OPENCODE_PASSWORD    OpenCode Basic-auth password (username is fixed to "opencode")

Options:
  --url <url>            Set the server address for this process
  --password <pw>        Set the password for this process
  --directory <path>     Default workspace directory
  --profile <full|minimal>  Tool surface (default full, 18 tools)
  --read-only            Disable tools that mutate sessions or files
  --allow-full-history   Admin-only: allow detail='full' on opencode_session_history
                         (raw tool inputs/outputs, redacted). Off by default.
  --allow-remote-url     Permit non-loopback OpenCode addresses
  --discover             Read credentials from the local OpenCode service file
  --host <host>          HTTP bind address (default 127.0.0.1)
  --port <port>          HTTP port (default 7777)
  --json                 Machine-readable output for "status"
`

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (options.command === "help") {
    process.stdout.write(HELP)
    return
  }
  if (options.command === "version") {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  const runtime: Record<string, unknown> = {}
  if (options.url) runtime.url = options.url
  if (options.password) {
    registerSecret(options.password)
    runtime.password = options.password
  }
  if (options.directory) runtime.defaultDirectory = path.resolve(options.directory)
  if (Object.keys(runtime).length > 0) setRuntimeConfig(runtime as any)

  if (options.discover) {
    const discovered = await readServiceFile()
    if (discovered) {
      registerSecret(discovered.password)
      setRuntimeConfig({ url: discovered.url, password: discovered.password })
      log.info(`Discovered OpenCode service at ${discovered.url}`)
    } else {
      log.warn(`--discover: no service file found (looked in ${OPENCODE_SERVICE_PATHS.join(", ")})`)
    }
  }

  const bridge = new OpenCodeBridge({ allowRemoteUrl: options.allowRemoteUrl })

  if (options.command === "configure") {
    const state = await runConfigure(bridge, options)
    printState(state, options.json)
    if (!state.connected) process.exitCode = 1
    return
  }

  if (options.command === "status") {
    const state = await bridge.probe()
    printState(state, options.json)
    if (!state.connected) process.exitCode = 1
    return
  }

  await bridge.reload()
  const context: ServerContext = {
    bridge,
    readOnly: options.readOnly,
    allowRemoteUrl: options.allowRemoteUrl,
    allowFullHistory: options.allowFullHistory,
    rootsProvider: async () => [],
  }

  if (options.http) {
    const { startHttpServer } = await import("./http.js")
    await startHttpServer(() => createServer(context, options), {
      host: options.host,
      port: options.port,
      configure: (input) => bridge.configure(input, { allowRemoteUrl: options.allowRemoteUrl }),
      clearConfig: (input) => bridge.clear(input),
    })
    log.info(`HTTP transport listening on http://${options.host}:${options.port}/mcp`)
    return
  }

  const server = createServer(context, options)
  context.rootsProvider = async () => {
    try {
      const result = await server.server.listRoots()
      return (result.roots ?? []).map((root) => root.uri)
    } catch {
      return []
    }
  }
  await server.connect(new StdioServerTransport())
  log.info(`stdio transport ready (profile=${options.profile}, readOnly=${options.readOnly})`)
}

function createServer(context: ServerContext, options: CliOptions): McpServer {
  const server = new McpServer(
    { name: "opencode-mcp-server", version: VERSION },
    {
      instructions:
        "This server drives a local OpenCode v2 instance. Start with opencode_status; if it is not configured, " +
        "call opencode_configure with the server address and password. Sessions are created in the client's " +
        "workspace by default. Use opencode_task for one-shot delegated work and opencode_session_* for " +
        "persistent conversations.",
    },
  )
  registerTools(server, context, options.profile)
  return server
}

async function runConfigure(bridge: OpenCodeBridge, options: CliOptions) {
  const current = bridge.configuration ?? (await bridge.reload())
  const promptedUrl =
    options.url ??
    current?.url ??
    (await promptText("OpenCode server URL [http://127.0.0.1:4096]: ").catch(() => ""))
  const url = promptedUrl || "http://127.0.0.1:4096"
  const password = options.password ?? current?.password ?? (await promptHidden("OpenCode password: "))
  const state = await bridge.configure({ url, password, persist: true }, { allowRemoteUrl: options.allowRemoteUrl })
  return state
}

function printState(state: unknown, json: boolean): void {
  process.stdout.write(JSON.stringify(state, null, json ? 0 : 2) + "\n")
}

async function promptText(question: string): Promise<string> {
  const readline = await import("node:readline/promises")
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stderr.write(prompt)
    let value = ""
    const finish = () => {
      stdin.off("data", onData)
      if (stdin.isTTY) stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write("\n")
    }
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          finish()
          resolve(value)
          return
        }
        if (char === "\u0003") {
          finish()
          process.exit(130)
        }
        if (char === "\u007f") {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    stdin.on("data", onData)
  })
}

process.on("SIGINT", () => process.exit(130))
process.on("SIGTERM", () => process.exit(143))

main().catch((error) => {
  log.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
