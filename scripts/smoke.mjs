#!/usr/bin/env node
/**
 * End-to-end smoke test: spawns the built server over stdio and exercises the MCP surface.
 * Requires a running OpenCode v2 server (OPENCODE_URL / OPENCODE_PASSWORD) for the live half.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import path from "node:path"
import process from "node:process"

const entry = path.resolve("dist/index.js")
const cwd = process.cwd()
let failures = 0

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

async function withClient(env, fn, extraArgs = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, ...extraArgs],
    cwd,
    env: { ...process.env, ...env },
    stderr: "inherit",
  })
  const client = new Client({ name: "smoke-test", version: "0.0.1" })
  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => {})
  }
}

function text(result) {
  return (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

const url = process.env.OPENCODE_URL
const password = process.env.OPENCODE_PASSWORD
const live = Boolean(url && password)
const MODEL = process.env.SMOKE_MODEL ? (([providerID, id]) => ({ providerID, id }))(process.env.SMOKE_MODEL.split("/")) : undefined

console.log("1. unconfigured server")
await withClient({ OPENCODE_URL: "", OPENCODE_PASSWORD: "" }, async (client) => {
  const tools = await client.listTools()
  check("lists 19 tools", tools.tools.length === 19, `got ${tools.tools.length}`)
  check(
    "tool names are prefixed",
    tools.tools.every((tool) => tool.name.startsWith("opencode_")),
  )

  const status = await client.callTool({ name: "opencode_status", arguments: {} })
  const statusText = text(status)
  check("status reports not configured", statusText.includes('"configured": false'), statusText.slice(0, 200))

  const create = await client.callTool({
    name: "opencode_session_create",
    arguments: { directory: cwd },
  })
  check("session_create fails cleanly", create.isError === true && text(create).includes("not configured"), text(create).slice(0, 200))
})

console.log("\n1b. minimal profile")
await withClient({ OPENCODE_URL: "", OPENCODE_PASSWORD: "" }, async (client) => {
  const tools = await client.listTools()
  check("minimal profile lists 10 tools", tools.tools.length === 10, `got ${tools.tools.length}`)
  check("minimal profile excludes mcp admin", !tools.tools.some((tool) => tool.name === "opencode_mcp"))
}, ["--profile", "minimal"])

console.log("\n1c. read-only mode")
if (live) {
  await withClient({ OPENCODE_URL: url, OPENCODE_PASSWORD: password }, async (client) => {
    const blocked = await client.callTool({
      name: "opencode_session_prompt",
      arguments: { sessionID: "ses_does_not_matter", text: "this should be refused" },
    })
    check(
      "read-only refuses prompts",
      blocked.isError === true && text(blocked).includes("read-only"),
      text(blocked).slice(0, 160),
    )
  }, ["--read-only"])
} else {
  console.log("  skip  read-only (needs OPENCODE_URL/PASSWORD)")
}

if (!live) {
  console.log("\nSkipping live tests: set OPENCODE_URL and OPENCODE_PASSWORD.")
  console.log(failures === 0 ? "\nSmoke test passed (offline)." : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

console.log("\n2. live server")
await withClient({ OPENCODE_URL: url, OPENCODE_PASSWORD: password }, async (client) => {
  const status = JSON.parse(text(await client.callTool({ name: "opencode_status", arguments: {} })))
  check("connected", status.connected === true, JSON.stringify(status).slice(0, 300))
  check("v2 version", /^2\./.test(status.version ?? ""), status.version)
  check("workspace resolved", typeof status.directory === "string" && status.directory.length > 0, status.directory)

  const workspace = JSON.parse(text(await client.callTool({ name: "opencode_workspace", arguments: { action: "info" } })))
  check("workspace source reported", typeof workspace.source === "string", JSON.stringify(workspace))

  const models = JSON.parse(
    text(await client.callTool({ name: "opencode_model", arguments: { action: "list", type: "chat" } })),
  )
  check("models listed", Array.isArray(models.models) && models.models.length > 0, `${models.models?.length} models`)

  const sessions = JSON.parse(
    text(await client.callTool({ name: "opencode_session_list", arguments: { directory: cwd, limit: 5 } })),
  )
  check("sessions listed", Array.isArray(sessions.sessions), `${sessions.sessions?.length}`)

  const agents = JSON.parse(text(await client.callTool({ name: "opencode_agent", arguments: { action: "list" } })))
  check("agents listed", agents.agents?.some((agent) => agent.id === "build"), JSON.stringify(agents).slice(0, 160))

  const mcps = JSON.parse(text(await client.callTool({ name: "opencode_mcp", arguments: { action: "list" } })))
  check("mcp servers listed", Array.isArray(mcps.servers), `${mcps.servers?.length}`)

  const permissions = JSON.parse(text(await client.callTool({ name: "opencode_permission", arguments: { action: "list" } })))
  check("permission queue readable", Array.isArray(permissions.requests), `${permissions.requests?.length}`)

  const created = JSON.parse(
    text(
      await client.callTool({
        name: "opencode_session_create",
        arguments: { title: "mcp smoke test", directory: cwd, ...(MODEL ? { model: MODEL } : {}) },
      }),
    ),
  )
  check("session created", typeof created.sessionID === "string", JSON.stringify(created).slice(0, 300))

  try {
    const started = Date.now()
    const prompt = JSON.parse(
      text(
        await client.callTool(
          {
            name: "opencode_session_prompt",
            arguments: {
              sessionID: created.sessionID,
              text: "Reply with exactly one word: pong",
              timeoutMs: 120000,
            },
          },
          undefined,
          { timeout: 200000 },
        ),
      ),
    )
    check("prompt completed", prompt.status === "idle", prompt.status)
    check("summary returned", typeof prompt.summary === "string" && prompt.summary.length > 0, prompt.summary?.slice(0, 120))
    check("no tool calls leaked to the client", prompt.tools === undefined && prompt.messages === undefined)
    console.log(`      (${Math.round((Date.now() - started) / 1000)}s, ${prompt.durationMs}ms)`)

    const history = JSON.parse(
      text(
        await client.callTool({
          name: "opencode_session_history",
          arguments: { sessionID: created.sessionID, format: "markdown", limit: 20 },
        }),
      ),
    )
    check("history has messages", Array.isArray(history.messages) && history.messages.length >= 2, `${history.messages?.length}`)
    check("markdown rendered", typeof history.markdown === "string" && history.markdown.includes("## "), "")

    const compact = JSON.parse(
      text(await client.callTool({ name: "opencode_session_compact", arguments: { sessionID: created.sessionID, wait: true } })),
    )
    check("compact ran", compact.ok === true, JSON.stringify(compact).slice(0, 200))
  } finally {
    const deleted = await client.callTool({ name: "opencode_session_delete", arguments: { sessionID: created.sessionID } })
    check("session deleted", deleted.isError !== true, text(deleted).slice(0, 200))
  }
})

console.log("\n3. configure from chat, delegate, attach")
await withClient({ OPENCODE_URL: "", OPENCODE_PASSWORD: "" }, async (client) => {
  const tested = JSON.parse(
    text(await client.callTool({ name: "opencode_configure", arguments: { url, password, test: true } })),
  )
  check("configure test validates", tested.connected === true, JSON.stringify(tested).slice(0, 200))
  check("test mode does not persist", tested.persisted === false, String(tested.persisted))

  const applied = JSON.parse(
    text(await client.callTool({ name: "opencode_configure", arguments: { url, password } })),
  )
  check("configure applies", applied.connected === true, JSON.stringify(applied).slice(0, 200))
  check("runtime config is not persisted", applied.persisted === false, String(applied.persisted))

  const status = JSON.parse(text(await client.callTool({ name: "opencode_status", arguments: {} })))
  check("status healthy after configure", status.connected === true && status.version?.startsWith("2."), JSON.stringify(status).slice(0, 200))

  const bad = await client.callTool({ name: "opencode_configure", arguments: { url, password: "definitely-wrong" } })
  check("wrong password rejected", bad.isError === true, text(bad).slice(0, 160))

  const statusAfterBad = JSON.parse(text(await client.callTool({ name: "opencode_status", arguments: {} })))
  check("failed configure keeps working state", statusAfterBad.connected === true, JSON.stringify(statusAfterBad).slice(0, 200))

  const remote = await client.callTool({ name: "opencode_configure", arguments: { url: "http://93.184.216.34:4096", password } })
  check("remote host refused by default", remote.isError === true && text(remote).includes("loopback"), text(remote).slice(0, 160))

  const task = JSON.parse(
    text(
      await client.callTool(
        {
          name: "opencode_task",
          arguments: { directory: cwd, prompt: "Reply with exactly: delegated", agent: "general", timeoutMs: 180000, ...(MODEL ? { model: MODEL } : {}) },
        },
        undefined,
        { timeout: 200000 },
      ),
    ),
  )
  check("task delegate returned", task.status === "idle" && task.agent === "general", JSON.stringify(task).slice(0, 200))
  check("task returns only a summary", typeof task.summary === "string" && task.summary.length > 0, task.summary?.slice(0, 120))
  check("task hides transcript by default", task.messages === undefined && task.tools === undefined)
  await client.callTool({ name: "opencode_session_delete", arguments: { sessionID: task.sessionID } }).catch(() => {})

  const background = JSON.parse(
    text(
      await client.callTool(
        {
          name: "opencode_task",
          arguments: {
            directory: cwd,
            prompt: "Reply with exactly: background-done",
            agent: "general",
            background: true,
            ...(MODEL ? { model: MODEL } : {}),
          },
        },
        undefined,
        { timeout: 60000 },
      ),
    ),
  )
  check("background task acknowledges immediately", background.status === "working" && Boolean(background.jobID))
  let job = background
  for (let attempt = 0; attempt < 60 && job.status === "working"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    job = JSON.parse(
      text(await client.callTool({ name: "opencode_job", arguments: { jobID: background.jobID } }, undefined, { timeout: 60000 })),
    )
  }
  check("background job finishes", job.status === "done", JSON.stringify(job).slice(0, 200))
  check("background job returns the summary", typeof job.summary === "string" && job.summary.length > 0, job.summary?.slice(0, 120))
  await client.callTool({ name: "opencode_session_delete", arguments: { sessionID: background.sessionID } }).catch(() => {})

  const session = JSON.parse(
    text(await client.callTool({ name: "opencode_session_create", arguments: { directory: cwd, title: "attachment test", ...(MODEL ? { model: MODEL } : {}) } })),
  )
  const filePath = path.join(cwd, "scripts", "attachment-fixture.txt")
  const attached = JSON.parse(
    text(
      await client.callTool({
        name: "opencode_file_attach",
        arguments: {
          sessionID: session.sessionID,
          path: filePath,
          text: "Reply with the exact content of the attached file and nothing else.",
          wait: true,
        },
      }),
    ),
  )
  check("attachment uploaded", attached.ok === true && attached.attachment?.size > 0, JSON.stringify(attached).slice(0, 200))
  check("attachment prompt answered", attached.result?.status === "idle" && Boolean(attached.result?.summary), attached.result?.status)
  await client.callTool({ name: "opencode_session_delete", arguments: { sessionID: session.sessionID } }).catch(() => {})
})

console.log(failures === 0 ? "\nSmoke test passed." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
