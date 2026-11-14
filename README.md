# opencode-mcp-server

An MCP server that exposes a running **OpenCode v2** instance to any MCP client — Codex, Claude Code,
Claude Desktop, Anti-Gravity, Cursor, or your own agent. Sessions, inference, agents, files, MCP
servers and history all become tools in the client's chat.

The bridge does not reimplement anything: it translates MCP tool calls into OpenCode v2 API calls
through the official `@opencode/client` SDK.

```
Codex / Claude / Anti-Gravity  ──MCP──▶  opencode-mcp-server  ──@opencode/client──▶  OpenCode v2 (:4096)
```

## Requirements

- Node.js ≥ 20
- A running OpenCode **v2** server (`opencode serve`, or the TUI) — v1 is rejected on purpose
- The server address and password (username is always `opencode`)

## Setup

The bridge needs two values:

```
OPENCODE_URL       e.g. http://127.0.0.1:4096
OPENCODE_PASSWORD  the OpenCode Basic-auth password
```

Find the password in `~/.config/opencode/service.json` (or `~/.local/state/opencode/service.json`).

### Install / run

No npm release required — this runs straight from GitHub:

```sh
npx -y github:shivrajansingh/opencode-mcp-server --help
```

Pin to a release or commit for stability: `github:shivrajansingh/opencode-mcp-server#v0.1.0`.

### Option A — configure once, from the terminal

```sh
npx -y github:shivrajansingh/opencode-mcp-server configure --url http://127.0.0.1:4096
# prompts for the password without echoing it, validates it, writes ~/.config/opencode-mcp/config.json (0600)
```

Check it:

```sh
npx -y github:shivrajansingh/opencode-mcp-server status
```

### Option B — configure in the MCP client

```toml
# ~/.codex/config.toml
[mcp_servers.opencode]
command = "npx"
args = ["-y", "github:shivrajansingh/opencode-mcp-server"]
env = { OPENCODE_URL = "http://127.0.0.1:4096", OPENCODE_PASSWORD = "…" }
```

```sh
# Claude Code
claude mcp add opencode -e OPENCODE_URL=http://127.0.0.1:4096 -e OPENCODE_PASSWORD=… \
  -- npx -y github:shivrajansingh/opencode-mcp-server
```

```json
// Claude Desktop / Anti-Gravity MCP config
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "github:shivrajansingh/opencode-mcp-server"],
      "env": { "OPENCODE_URL": "http://127.0.0.1:4096", "OPENCODE_PASSWORD": "…" }
    }
  }
}
```

### Option C — configure from the chat

Start the server with no credentials. It still lists its tools and `opencode_status` explains what is
missing. Then ask the model to call:

```json
opencode_configure({ "url": "http://127.0.0.1:4096", "password": "…" })
```

Values are validated before they are applied, the password is never echoed, and nothing is written to
disk unless you pass `persist: true`.

### Precedence

`runtime (opencode_configure)` → `environment` → `~/.config/opencode-mcp/config.json` → unconfigured.
There is no silent auto-discovery; `--discover` exists for development only.

## Tools (19)

| Tool | What it does |
|---|---|
| `opencode_status` | Health, version, workspace, agents, default model. Works while unconfigured. |
| `opencode_configure` | Validate and apply URL + password in-chat. |
| `opencode_workspace` | Show/persist the working directory, list MCP roots. |
| `opencode_session_create` | New session in a directory (agent, model, parent, permissions). |
| `opencode_session_list` | List sessions by directory/search/archive/parent. |
| `opencode_session_get` | Session metadata, tokens, cost. |
| `opencode_session_move` | Change a session's directory. |
| `opencode_session_delete` | Delete a session. |
| `opencode_session_interrupt` | Stop the current run. |
| `opencode_session_compact` | Summarize history to free context. |
| `opencode_session_prompt` | Prompt with text + files, wait for the answer, return tools/usage. |
| `opencode_session_history` | Audit a session. `detail: "summary"` (default) returns prompts + answers + tool counts; `"tools"` adds per-step names; `"full"` returns raw inputs/outputs. |
| `opencode_model` | List models, read the default, assign at session/project/global/agent scope. |
| `opencode_agent` | List agents, switch agent, delegate to a subagent. |
| `opencode_task` | One-shot delegation: create session → prompt → wait → return **summary only**. `background: true` returns a jobID immediately. |
| `opencode_job` | Collect the summary of a background task (`status` / `list` / `cancel`). |
| `opencode_file_attach` | Attach a path or base64 bytes to a session (optionally prompt immediately). |
| `opencode_mcp` | Inspect/add/connect/remove OpenCode's own MCP servers. |
| `opencode_permission` | List/reply to permission requests (required for headless runs). |

`--profile minimal` registers 10 tools: status, configure, workspace, session create/prompt/history,
model, task, job, permission.

## Model assignment

Four levels, all through `opencode_model`:

| Scope | Call | Effect | Storage |
|---|---|---|---|
| **Session** | `{ action:"set", sessionID, model }` | immediate switch for that conversation | OpenCode DB |
| **Project** | `{ action:"set", scope:"project", directory, model }` | default for new sessions in that workspace | `opencode.json` (comments preserved) |
| **Global** | `{ action:"set", scope:"global", model }` | default everywhere | `~/.config/opencode/opencode.json` |
| **Agent** | `{ action:"set", scope:"agent", agent:"build", model }` | model for that agent's runs | `agents.<id>.model` in the nearest config |

Precedence: session → agent → project → global. `scope` defaults to `session` when `sessionID` is
given, otherwise `project`.

Project/global writes use a JSONC-aware editor (comments and unrelated keys survive), then trigger an
OpenCode config reload and verify the result against `model/default`. Agent-level writes are verified
by reading the file back, because OpenCode does not expose the resolved per-agent model through the
API.

```jsonc
// opencode.json
{
  "model": { "providerID": "opencode", "model": "iceman-free" },
  "agents": { "build": { "model": { "providerID": "opencode", "model": "inkling-2-small-free" } } }
}
```

A model can also be passed at creation time: `opencode_session_create({ model: { providerID, id, variant? } })`.

## How a client actually runs OpenCode

The orchestrator assigns work; OpenCode does it; **only the final summary crosses the MCP boundary**.

```js
// one-shot delegation (recommended for orchestrators)
const r = await opencode_task({
  directory: "/repo",
  agent: "build",
  prompt: "Add a /health endpoint and run the tests",
})
// → { status: "idle", summary: "Added /health … all 42 tests pass", durationMs: 18342 }
```

While the run is in flight the client sees a generic progress message (`OpenCode is working… 12s`),
never tool calls, intermediate output, or reasoning.

For long tasks, return immediately and collect the result later:

```js
const { jobID } = await opencode_task({ directory, prompt, background: true })
// → { jobID: "job_…", status: "working" }

const job = await opencode_job({ jobID })
// → { status: "working" }  … later …
// → { status: "done", summary: "…" }
```

The same happens automatically: if an inline call exceeds the client timeout and the run is still
going, the response is `{ status: "working", jobID }` instead of a lost result — poll it with
`opencode_job`.

**Persistent conversations** work the same way:

```js
const s = await opencode_session_create({ directory })
await opencode_session_prompt({ sessionID: s.sessionID, text: "Fix the failing test" })
// → { status: "idle", summary: "Fixed the import in src/auth.ts …" }
```

### What is hidden, and how to opt out

| Data | Default | Opt-in |
|---|---|---|
| Tool calls (`write`, `shell`, …) | hidden | `verbosity: "full"` |
| Intermediate assistant turns | hidden | `verbosity: "full"` |
| Reasoning blocks | never returned by prompt/task | `opencode_session_history { includeReasoning: true, detail: "full" }` |
| Token/cost usage | hidden | `verbosity: "full"` |
| Provider errors | **always surfaced** as `status: "error"` + `error.message` | — |
| Session audit | payload of ~2.8 KB | `detail: "tools"` / `"full"` |

`opencode_session_history` remains the explicit audit tool. It defaults to `detail: "summary"`
(prompts, answers, tool **counts**); `detail: "tools"` adds one line per step (name, status, target);
`detail: "full"` returns raw inputs/outputs. On a real 15-message Playwright run, the default shrinks
the payload from 18 KB / 433 lines to ~2.8 KB / 1 line.

Large tool results are also emitted as compact JSON (no indentation); results under 2 KB stay
pretty-printed for readability.

The MCP client never touches the model. OpenCode runs inference through its own providers and runs
the agentic loop with its own tools, skills, MCP servers and permissions; the bridge translates
requests and returns summaries.

If OpenCode asks for permission mid-run, the run blocks; use `opencode_permission { action: "list" }`
and `{ action: "reply" }` to approve or reject headlessly.

**Verified end to end:** `npm run agentic-smoke` asks the `build` agent to write a file and run
`cat`, asserts the file exists on disk, and asserts the response contains **no** tool calls or
messages.

## Workspace resolution

Sessions are created in, in order: the tool's `directory` argument → MCP `roots` → `CLAUDE_PROJECT_DIR` /
`OPENCODE_MCP_DIRECTORY` / `INIT_CWD` → configured `defaultDirectory` → process cwd. The home directory
and `/` are never used as a silent fallback; the bridge returns an actionable error instead.

## HTTP transport

```sh
OPENCODE_MCP_TOKEN=… npx opencode-mcp-server --http --port 7777
# POST http://127.0.0.1:7777/mcp  with  Authorization: Bearer <token>
```

If `OPENCODE_MCP_TOKEN` is unset, a token is generated at `~/.config/opencode-mcp/http-token` (0600).
Health check: `GET /healthz`. The same token protects a settings endpoint:

```sh
curl -X POST http://127.0.0.1:7777/configure \
  -H "Authorization: Bearer $OPENCODE_MCP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:4096","password":"…"}'
```

## Security notes

- The bridge can run an agent with shell access — treat it as remote code execution by design.
- Loopback binding, bearer token, and loopback-only OpenCode URLs by default.
- `--read-only` disables prompts, compaction, deletes, moves, uploads and permission replies.
- `allowedRoots` (config file or `OPENCODE_MCP_ALLOWED_ROOTS`) blocks path escapes, symlink-safe.
- Passwords never appear in logs, errors, or tool output; the audit-friendly paths redact them.
- `opencode_configure` cannot change `allowedRoots` or the permission profile.

## Development

```sh
npm install
npm run typecheck
npm test              # unit tests (vitest)
npm run build
# live tests need a working model; pass SMOKE_MODEL if the default is rate-limited
SMOKE_MODEL=opencode-go/hy4 OPENCODE_URL=… OPENCODE_PASSWORD=… npm run smoke
SMOKE_MODEL=opencode-go/hy4 OPENCODE_URL=… OPENCODE_PASSWORD=… npm run agentic-smoke
node scripts/http-smoke.mjs                        # live end-to-end (HTTP, after starting --http)
```

## Status

Working: all 19 tools, stdio + HTTP transports, config/status/configure, workspace resolution,
model assignment at session/project/global/agent scope, summary-only task output with background
jobs, attachments, delegation, compaction, permissions, MCP administration.

Not yet implemented from `docs/plan.md`: audit log file, OS keychain storage, artifact resources
(`opencode://…`), progress notifications, and per-client smoke tests against Codex/Anti-Gravity.
