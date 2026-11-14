#!/usr/bin/env node
/**
 * Agentic smoke test: proves an MCP client can make OpenCode *do work* — not just reply.
 * Creates a temp workspace, asks the build agent to write a file and run a shell command,
 * then verifies the file on disk and the tool calls in the transcript.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

const url = process.env.OPENCODE_URL
const password = process.env.OPENCODE_PASSWORD
if (!url || !password) {
  console.log("Set OPENCODE_URL and OPENCODE_PASSWORD to run this test.")
  process.exit(1)
}

const MODEL = process.env.SMOKE_MODEL ? (([providerID, id]) => ({ providerID, id }))(process.env.SMOKE_MODEL.split("/")) : undefined

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-agentic-"))
let failures = 0
const check = (name, condition, detail) => {
  console.log(`${condition ? "  ok  " : "FAIL  "}${name}${condition || !detail ? "" : ` — ${detail}`}`)
  if (!condition) failures += 1
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/index.js")],
  cwd: workspace,
  env: { ...process.env, OPENCODE_URL: url, OPENCODE_PASSWORD: password },
  stderr: "inherit",
})
const client = new Client({ name: "agentic-smoke", version: "0.0.1" })
await client.connect(transport)

const call = async (name, args, timeout = 300_000) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout })
  const text = (result.content ?? []).map((part) => part.text ?? "").join("")
  if (result.isError) console.log(`      ${name} error: ${text.slice(0, 240)}`)
  return JSON.parse(text)
}

try {
  const started = Date.now()
  const task = await call("opencode_task", {
    directory: workspace,
    agent: "build",
    ...(MODEL ? { model: MODEL } : {}),
    prompt:
      "Create a file named hello.txt in the current directory containing exactly the line: hello from opencode. " +
      "Then run `cat hello.txt` and report what you saw.",
    timeoutMs: 250_000,
  })
  const seconds = Math.round((Date.now() - started) / 1000)
  console.log(`      finished in ${seconds}s`)

  check("run completed", task.status === "idle", task.status)
  check("summary returned, no transcript", typeof task.summary === "string" && task.summary.length > 0, task.summary?.slice(0, 120))
  check("tool calls hidden from the client", task.tools === undefined && task.messages === undefined)

  const written = await fs.readFile(path.join(workspace, "hello.txt"), "utf8").catch(() => null)
  check("file exists on disk", written !== null, "hello.txt missing")
  check("file has the requested content", written?.trim() === "hello from opencode", JSON.stringify(written))

  await client.callTool({ name: "opencode_session_delete", arguments: { sessionID: task.sessionID } }).catch(() => {})
} finally {
  await client.close().catch(() => {})
  await fs.rm(workspace, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nAgentic smoke passed." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
