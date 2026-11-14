# OpenCode MCP Server — Implementation Plan

> **Goal:** expose the full OpenCode system (sessions, inference, agents, files, MCP, history) as a
> standard **MCP server**, so that *any* MCP-capable client — Codex, Claude Code / Claude Desktop,
> Anti-Gravity, Cursor, or a custom agent — can drive OpenCode directly from its own chat.

**Status:** implemented (v0.1, see `README.md`) · **Target:** OpenCode **v2 only** (verified against
`2.2.5`) · **Stack:** Node.js + TypeScript + `@opencode/client` · **Repo:** `opencode-mcp-server/`

---

## Implementation status (v0.1)

Shipped and verified against a live OpenCode 2.2.5 server:

- All 19 tools registered over both **stdio** and **Streamable HTTP** (bearer token), plus an
  authenticated `POST /configure` settings endpoint on the HTTP transport.
- Config precedence (runtime → env → file), 0600 config file, `configure` CLI, `opencode_configure` tool.
- Unconfigured start-up with actionable `opencode_status` and clean tool errors.
- v2 version gate, 401/unreachable differentiation, credential redaction.
- **Live end-to-end**: create → prompt → answer → history → compact → delete; delegation via
  `opencode_task`; `data:` attachment round-trip; in-chat configure (including wrong-password and
  remote-host rejection); model assignment at session, project, global and agent scope (JSONC-safe).
- **Agentic end-to-end**: `scripts/agentic-smoke.mjs` has the `build` agent write a file and run a
  shell command through `opencode_task`, then asserts the file on disk and that the response hides
  `tools`/`messages`. This is the proof that a client can *make OpenCode work* while only seeing the
  final summary.
- 34 unit tests (config precedence, URL policy, workspace resolution/allowlist, redaction, JSONC model edits).
- Scripts: `scripts/smoke.mjs` (stdio) and `scripts/http-smoke.mjs` (HTTP).

Not yet: audit log file, keychain storage, artifact resources, progress notifications, per-client
certification (Codex/Anti-Gravity). Tracked in §9 (M8) and §11.

---

## 1. Problem & positioning

OpenCode already has everything we need: a provider-agnostic inference layer, agents/subagents,
tools, permission rules, MCP clients, session storage, and an HTTP API. What it lacks is a
*low-friction door* for **other AI clients**.

Today, using OpenCode from Codex or Claude means shelling out to `opencode run` and scraping
stdout. That loses streaming, session continuity, model selection, attachments, and subagents.

This project builds one thin, well-typed **MCP bridge**:

```
┌─────────────┐   MCP (stdio / HTTP)   ┌──────────────────┐  @opencode/client  ┌─────────────┐
│ Codex       │ ─────────────────────► │ opencode-mcp-    │ ─────────────────► │  OpenCode   │
│ Claude      │ ◄───────────────────── │ server (this)    │ ◄───────────────── │  v2 service │
│ Anti-Gravity│   tools + resources    └──────────────────┘   URL + password   │  :4096      │
└─────────────┘                                │                                  └─────────────┘
                                               └── explicit config, no guessing
```

**We do not reimplement inference, tools, or agents.** OpenCode owns all of that. The bridge is a
translation layer: MCP tool calls ⇄ OpenCode v2 API calls.

### Design principles

1. **Explicitly configured, never guessed** — the bridge connects only to the server URL and
   password the user supplies. No silent `service.json` discovery.
2. **v2 only** — the v2 API and the v2 SDK (`@opencode/client`) are the contract. v1 servers are
   rejected with an actionable error.
3. **Directory-first** — the client's workspace always wins; sessions are created *in that
   directory*, never in the bridge's cwd by accident.
4. **Headless-safe** — no TUI, no interactive prompts. Every blocking permission is surfaced as a
   tool or auto-resolved by policy.
5. **Streaming where possible, simple everywhere** — `wait` by default, events for progress.

---

## 2. Configuration contract (the part that gates everything)

The MCP server has exactly **one required configuration**: where OpenCode v2 lives and how to
authenticate to it.

```
Server address : http://127.0.0.1:4096        (http/https, no trailing slash)
Password       : ********                      (OpenCode Basic-auth password)
```

The username is **fixed** to `opencode` — verified against the live server:

```sh
curl -u opencode:<password>  http://127.0.0.1:4096/api/info   # 200
curl -u wrong:<password>     http://127.0.0.1:4096/api/info   # 401
curl -H "Authorization: Bearer <password>" ...                # 401 (unsupported)
```

So the config page only needs **two fields**, which keeps it simple for Codex / Claude /
Anti-Gravity users.

### 2.1 Where the two values can come from

| Surface | How the user enters it | Notes |
|---|---|---|
| **MCP config page** (Codex, Claude, Anti-Gravity) | two `env` entries: `OPENCODE_URL`, `OPENCODE_PASSWORD` | Works everywhere; this is the primary path |
| **MCP tool** | `opencode_configure({ url, password, persist? })` | Set/repair config *from inside the chat* — see §2.4 |
| **CLI** | `npx opencode-mcp-server configure --url … --password …` | Writes `~/.config/opencode-mcp/config.json` (`0600`), prompts without echoing |
| **HTTP settings endpoint** | `POST /configure` on the bridge's own port (loopback + bridge token) | For a future GUI settings page |
| **Env override** | `OPENCODE_URL`, `OPENCODE_PASSWORD` in the process env | Admin-set default; overridable per session by the tool |

Full JSON form (file has the same shape):

```jsonc
{
  "url": "http://127.0.0.1:4096",
  "password": "••••••••",
  "defaultDirectory": "/abs/path/to/project", // optional
  "allowedRoots": ["/home/me/projects"],      // optional safety rail
  "permissionProfile": "workspace-write"      // read-only | workspace-write | danger-full-access
}
```

Precedence: **runtime (tool) → env → config file → unconfigured**. There is no fifth source and no
auto-discovery (`--discover` exists only as an explicit developer opt-in). A runtime value set by
`opencode_configure` lasts for the process lifetime; it only touches disk with `persist: true`.

### 2.2 "Not configured" behaviour (important UX)

The server must still **start and list its tools** when configuration is missing — otherwise the
client shows a broken MCP entry and the user cannot even ask why.

| State | `opencode_status` | All other tools |
|---|---|---|
| No URL or no password | `{ configured: false, hint: "…" }` | `isError: true`, message below |
| Bad credentials | `{ configured: true, connected: false, error: "unauthorized" }` | actionable error, no retry storm |
| v1 server | `{ configured: true, connected: false, error: "version_unsupported" }` | tells the user to upgrade |
| Healthy v2 | `{ configured: true, connected: true, version, location, agents, defaultModel }` | normal operation |

Exact tool error text (returned as tool content, not a protocol error, so the calling model can
relay it verbatim):

```
OpenCode MCP server is not configured yet.
Set OPENCODE_URL (e.g. http://127.0.0.1:4096) and OPENCODE_PASSWORD in this MCP server's
configuration, then retry. Run `opencode_status` to see the current state.
```

### 2.3 Validation on connect

1. `GET /api/info` with Basic auth → 200.
2. Assert `info.version` matches **`^2\.`** → otherwise `OPENCODE_VERSION_UNSUPPORTED`
   ("OpenCode v1 detected; this bridge requires v2 — run `opencode upgrade`").
3. Record `version`, `pid`, `hostname`; warn if the SDK minor (`@opencode/client@2.3`) diverges
   from the server minor by more than one.
4. Cache the client; re-validate on connection errors and after `server.connected` events.
5. Never log the password; redact it from every error, request dump, and audit entry.

### 2.4 Configuring from the chat (`opencode_configure`)

Because the tool is explicit, a user can fix a wrong URL or password without editing any JSON file:

```ts
opencode_configure({
  url?: string,            // validated: http(s), no trailing slash
  password?: string,
  persist?: boolean,       // default false → in-memory only
  test?: boolean,          // validate + report, do not apply
  clear?: boolean          // revert to env/file/unconfigured
}) -> { configured, connected, version?, hostname?, persisted, error?, hint? }
```

Guardrails (this tool can redirect the bridge, so it is not a free-form setter):

1. **Validate before apply** — auth + `/api/info` + `^2\.` version check; on failure nothing changes.
2. **Never echo the password** — the result contains only `configured/version/hostname`, and the
   value is redacted from audit and error strings.
3. **Persistence is opt-in** — `persist: true` is required to write the 0600 config file; default is
   process-lifetime only, so a mistyped password in a transcript doesn't stick.
4. **Cannot weaken security** — the tool may set `url`/`password` only. `allowedRoots`,
   `permissionProfile`, and the bridge token remain admin/CLI-only, so a prompt cannot grant itself
   broader access.
5. **URL policy** — by default only loopback/private ranges are accepted (`127.0.0.1`, `localhost`,
   RFC1918); public hosts require `--allow-remote-url` at startup.
6. **Transcript warning** — the password is typed into the conversation, so the tool description
   tells the model to prefer env config and to use `opencode_configure` only when nothing else works.

---

## 3. Capability matrix (what the client gets)

| # | User-facing capability | MCP tool(s) | OpenCode v2 API |
|---|---|---|---|
| 0 | Configure / health | `opencode_status`, `opencode_configure` | `GET /api/info` |
| 1 | New session in the client's current directory | `opencode_session_create` | `POST /api/session` with `location.directory` |
| 2 | Select / inherit working directory | `opencode_workspace`, every tool's `directory` arg | `location` on create, `?directory=` on scoped routes, `POST /api/session/{id}/move` |
| 3 | Model selection + default model | `opencode_model` (`list`/`default`/`set`) | `GET /api/model`, `GET /api/model/default`, `POST /api/session/{id}/model`, config-file write for project/global/agent defaults |
| 4 | File upload into the chat | `opencode_file_attach` (+ `files` on prompt) | `POST /api/session/{id}/prompt` `files[]` (`data:` URI), `experimental.file.write` |
| 5 | Sub-agent creation / delegation | `opencode_task`, `opencode_agent` (`list`/`set`/`delegate`) | `POST /api/session` `parentID`+`agent`, `POST /api/session/{id}/agent`, `agents[]` on prompt |
| 6 | See / assign MCP tools | `opencode_mcp` (`list`/`add`/`connect`/`remove`/`resources`) | `GET /api/mcp`, `PUT/DELETE /api/experimental/mcp/{server}`, connect/disconnect, `GET /api/mcp/resource` |
| 7 | Compact the session | `opencode_session_compact` | `POST /api/session/{id}/compact` |
| 8 | Read session data / chat history | `opencode_session_history`, `opencode_session_list` | `POST /api/session/{id}/message` (list), `/context`, `/diff`, `/export` |
| + | Prompt + streamed response | `opencode_session_prompt` | `POST .../prompt` + `experimental.session.wait` + `GET /api/event` |
| + | Stop a run | `opencode_session_interrupt` | `POST /api/session/{id}/interrupt` |
| + | Approve / deny permission requests | `opencode_permission` | `GET /api/permission/request`, `POST /api/session/{id}/permission/{reqID}/reply` |

---

## 4. Architecture

### 4.1 SDK layer — use `@opencode/client`, not the embed SDK

The user-facing requirement is "server address + password", which means **over the network**, not
in-process. The correct package is therefore the generated JavaScript/TypeScript client:

```
@opencode/client@2.3.0   →  OpenCode.make({ baseUrl, headers })   ← what we use
@opencode/sdk            →  embeds OpenCode in-process (no URL)   ← not this
```

Verified API surface we depend on (all present in `2.3.0`):

```ts
const client = OpenCode.make({
  baseUrl: config.url,                                  // http://127.0.0.1:4096
  headers: { authorization: `Basic ${btoa("opencode:" + config.password)}` },
})

await client.server.info()
await client.session.create({ location: { directory }, agent, model, title, parentID })
await client.session.prompt({ sessionID, text, files, agents, skills })
await client.experimental.session.wait({ sessionID })
await client.message.list({ sessionID, limit, order, cursor, type })
await client.session.switchModel({ sessionID, model: { providerID, id, variant } })
await client.session.switchAgent({ sessionID, agent })
await client.session.compact({ sessionID })
await client.session.interrupt({ sessionID })
await client.session.move({ sessionID, directory })
await client.model.list({ location, types })
await client.model.default({ location })
await client.agent.list({ location })
await client.mcp.list({ location })
await client.mcp.add({ server, config })          // local | remote config
await client.mcp.resource.catalog({ location })
await client.experimental.file.write({ location, path, payload: Uint8Array })
await client.permission.request.list()
await client.permission.reply({ sessionID, requestID, decision: "once" | "always" | "reject" })
for await (const event of client.event.subscribe({ types: [...] })) { /* … */ }
```

Wrap this in `src/client.ts` with: lazy connect, 3× retry with backoff on transport errors, typed
`OpenCodeError` mapping (`unauthorized`, `version_unsupported`, `session_not_found`,
`session_busy`), and a `withLocation(directory)` helper that injects `{ location: { directory } }`
into every location-scoped call.

### 4.2 Workspace resolution (the "current directory" problem)

An MCP server is usually spawned with a *fixed* cwd (often `$HOME`). Resolution order per call:

1. **Explicit** `directory` argument on the tool call (always wins).
2. **MCP roots** — `roots/list`, first `file://` root (spec-correct; Codex/Claude expose project
   roots when asked).
3. **Client hints** — `CLAUDE_PROJECT_DIR`, `OPENCODE_MCP_DIRECTORY`, `INIT_CWD`, `PWD`.
4. **`config.defaultDirectory`** from §2.1.
5. **`process.cwd()`** — correct when the client spawns us inside the project.
6. **Refuse** — never silently fall back to `/root`, `/`, or the bridge directory.

Cached for the process lifetime, invalidated on `roots/list_changed`. `opencode_workspace
{ action: "info" }` exposes the resolved value so the model can verify it before writing code.

Relative paths from the client resolve against the workspace, never against server cwd. Every
resolved path is `realpath`-checked against `allowedRoots` when configured.

### 4.3 Session lifecycle

```
configure ─► status(ok) ─► create(location = workspace, agent = build, model = default)
   └─► prompt (text + files + agents/skills)      ← async, returns inbox item
          └─► wait (resolves when idle)  |  event stream (session.text.delta, session.tool.*)
                 └─► history (messages, cursor-paginated)
                        └─► compact → prompt again
```

Sessions are long-lived and keyed by OpenCode `sessionID` (`ses_…`). The bridge keeps a small
side-table `sessionID → { directory, configuredAt, toolset }` for fast policy checks and to survive
`session.moved` events.

### 4.4 Async model

`session.prompt()` returns immediately with an inbox item; it does **not** return the answer. So:

- `opencode_session_prompt` defaults to `wait: true, timeoutMs: 45000` and **summary verbosity**:
  post prompt → `experimental.session.wait` → read new messages → return only
  `{ status, summary, durationMs }`. Tool calls, intermediate turns and reasoning never cross the MCP
  boundary, so the orchestrator's context is not polluted. `verbosity: "full"` is opt-in.
- While waiting, generic `notifications/progress` messages ("OpenCode is working… 12s") are sent when
  the client supplies a progress token. They carry no tool or content details.
- `background: true` creates an in-memory job and returns `{ jobID, status: "working" }` immediately;
  `opencode_job` returns `{ status: "done", summary }` once finished. Jobs are process-local (lost on
  restart) and capped at 100.
- An **inline** task that exceeds its wait is automatically continued as a job: the response is
  `{ status: "working", jobID }`, so the summary is never lost when the client's timeout fires.
- Provider failures are surfaced as `status: "error"` with `error.type`/`error.message`, never as a
  silent empty summary.
- When the wait elapses the tool returns `status: "timeout"` (or `"running"` with `wait: false`) plus a
  hint to poll `opencode_session_history` or interrupt — the session keeps running in OpenCode.
- `wait: false` returns `{ sessionID, status: "running" }`; the client polls `history` or calls
  `opencode_events_wait`.
- Optional `progress: true` subscribes to `GET /api/event?types=session.text.delta,session.tool.*`
  and emits MCP **progress notifications**, so Codex/Claude show live activity.
- Timeout leaves the session running (OpenCode owns it); the response says so and offers
  `opencode_session_interrupt`.

---

## 5. Tool catalog

Conventions: every tool accepts optional `directory`; every tool returns `{ ok, data }` or a typed
error. Names are prefixed `opencode_`. **19 tools**, with a `--profile minimal` variant (10).

### 5.1 Configuration & workspace

```ts
opencode_status() -> {
  configured: boolean, connected: boolean, version?: string, hostname?: string,
  location?: string, agents?: string[], defaultModel?: { providerID, id },
  permissionProfile?: string, error?: string, hint?: string
}

opencode_configure({
  url?, password?, persist?: false, test?: boolean, clear?: boolean
}) -> { configured, connected, version?, hostname?, persisted, error?, hint? }

opencode_workspace({ action: "info" | "set-default" | "list-roots", directory? })
  -> { directory, source: "arg" | "roots" | "env" | "config" | "cwd" }
```

`opencode_status` is the *only* tool guaranteed to work while unconfigured — it is how the user
debugs a mistyped URL or password from inside the chat. `opencode_configure` then repairs it in
place, with the guardrails in §2.4 (validate-first, never echo the password, admin-only fields
untouchable, loopback-only by default).

### 5.2 Sessions

```ts
opencode_session_create({
  directory?: string, title?: string, agent?: string,
  model?: { providerID: string, id: string, variant?: string },
  parentSessionID?: string,
  permissions?: PermissionRule[]
}) -> { sessionID, title, directory, agent, model }
```

```ts
opencode_session_list({ directory?, search?, archived?, limit?, cursor?, parentSessionID? })
opencode_session_get({ sessionID })
opencode_session_move({ sessionID, directory })
opencode_session_delete({ sessionID })
opencode_session_interrupt({ sessionID })
```

### 5.3 Prompting

```ts
opencode_session_prompt({
  sessionID: string,
  text: string,
  files?: { uri: string, name?: string, description?: string }[],
  agents?: { name: string }[],
  skills?: { id: string }[],
  wait?: boolean,          // default true
  timeoutMs?: number,      // default 120_000
  progress?: boolean
}) -> {
  sessionID, status: "idle" | "running" | "timeout" | "failed",
  text: string,
  messages: Message[],     // new turns only
  tools: { name, status, durationMs }[],
  usage: { tokens, cost }
}
```

### 5.4 Models

```ts
opencode_model({ action: "list" | "default" | "set",
  sessionID?, model?, type?, scope?: "session" | "project" | "global" | "agent", agent? })
```

Four assignment levels, in precedence order:

| Scope | Mechanism | Notes |
|---|---|---|
| **session** | `POST /api/session/{id}/model` | immediate; wins for that conversation |
| **agent** | `agents.<id>.model` in config | applies to that agent's runs |
| **project** | `model` in `<workspace>/opencode.json(c)` | default for new sessions in that workspace |
| **global** | `model` in `~/.config/opencode/opencode.json(c)` | machine-wide default |

- `list` → `client.model.list({ location, types })`.
- `default` → `client.model.default({ location })` (the effective value).
- `set` + `sessionID` → `client.session.switchModel(...)`.
- `set` + `scope: project|global|agent` → JSONC-aware edit of the config file (comments preserved),
  followed by `location.reload()` and verification against `model/default`.

> The API itself cannot change the default (`Config.Patch` = `{ shell }` only in 2.2.x), so defaults are
> written to config files. A newly created config file is not picked up by the watcher until a reload,
> which the tool triggers automatically. Agent-level writes are verified by reading the file back,
> because `agent.list` does not expose resolved models.

### 5.5 Files

```ts
opencode_file_attach({
  sessionID: string,
  path?: string,        // server-side path
  data?: string,        // base64 from the client
  name?: string, mime?: string, description?: string
}) -> { attachment: { uri, name }, size }
```

Verified attachment encoding (from the SDK implementation): the prompt's `files[].uri` is a
**`data:<mime>;base64,<payload>` URI**, optionally paired with `source: { type: "inline" }`.

| Source | Mechanism |
|---|---|
| Path visible to the bridge | read bytes → `data:` URI (cap 10 MB) |
| Client-supplied bytes (screenshot/artifact) | `client.experimental.file.write` into `.opencode/attachments/`, then `data:` URI |
| Oversized | write to scratch dir, attach by path reference and tell the model where it is |

Artifacts also surface as MCP **resources** (`opencode://session/{id}/file/{path}`) so the client can
pull outputs back (diffs, generated files, reports).

### 5.6 Agents & subagents

```ts
opencode_agent({ action: "list" | "set" | "delegate" })
opencode_task({
  directory?, prompt, agent?: "general" | "explore" | string,
  title?, model?, wait?: true, timeoutMs?: 45_000,
  verbosity?: "summary" | "full", background?: boolean
}) -> { sessionID, parentSessionID, status, summary, durationMs }

opencode_job({ action: "status" | "list" | "cancel", jobID?, limit? })
  -> { jobID, sessionID, status, summary?, error?, elapsedMs? }
```

- `list` → `client.agent.list()` (verified live: `build`, `general`, `explore`, …).
- `set` → `client.session.switchAgent({ sessionID, agent })`.
- `delegate` / `opencode_task` → create a session (`parentID` + `agent`), prompt, wait, and return
  **only the final summary**. Tool calls and intermediate turns are the caller's opt-in
  (`verbosity: "full"`), so an orchestrator's context stays clean.
- `background: true` returns `{ jobID, status: "working" }` immediately; `opencode_job` collects the
  summary later. Jobs are in-memory (max 100, lost on restart).
- Mid-run delegation: pass `agents: [{ name: "explore" }]` on a normal prompt; OpenCode's own model
  decides when to spawn it.

### 5.7 MCP servers (OpenCode's own MCP clients)

```ts
opencode_mcp({ action: "list" | "add" | "remove" | "connect" | "disconnect" | "resources" })
```

- `list` → `client.mcp.list()` (verified live: `[{ name: "browse", status: { status: "connected" } }]`).
- `add` → `client.mcp.add({ server, config })` with `{ type:"local", command[], cwd?, environment?,
  disabled? }` or `{ type:"remote", url, headers?, oauth? }`.
- `resources` → `client.mcp.resource.catalog()` to show each server's tools/resources.

**Honest limitation:** OpenCode enables/disables MCP servers at *config* level, not per session.
"Assign MCP tools to a session" is therefore approximated by (1) server on/off and (2) a per-session
**permission ruleset** (`permissions` on create) that allow/denies tool names. The tool description
must say this so the calling model doesn't over-trust it.

### 5.8 Compaction & history

```ts
opencode_session_compact({ sessionID, wait?: true })
  -> { before: { tokens, cost }, after: { tokens }, summary }

opencode_session_history({
  sessionID, limit?: 100, cursor?, order?: "asc" | "desc",
  include?: { text: true, toolCalls: true, reasoning: false, synthetic: false },
  format?: "json" | "markdown" | "transcript"
}) -> { messages, cursor, totals: { tokens, cost, tools } }
```

- `compact` → `client.session.compact({ sessionID })`; also support
  `auto: { thresholdPercent: 80 }` to compact before a prompt when context is hot.
- `history` → `client.message.list({ sessionID, limit, order, cursor, type })`, rendering
  `user | assistant | tool | compaction | skill | shell | idle` into the requested format.
- Extra views available without new tools: `session.context()`, `session.diff()`,
  `session.export()`, `session.stats()`.

### 5.9 Permissions (required for headless use)

```ts
opencode_permission({ action: "list" | "reply" | "policy" })
```

Without this, a run that hits a `*.env` read or a shell exec **hangs forever** because the TUI
prompt is nobody's job. `list` → `client.permission.request.list()`; `reply` →
`client.permission.reply({ sessionID, requestID, decision })`; `policy` sets the session ruleset or
the bridge default (`read-only` / `workspace-write` / `danger-full-access`).

---

## 6. Transport & packaging

| Mode | Flag | Use case |
|---|---|---|
| **stdio** (default) | `opencode-mcp` | Codex, Claude Code/Desktop, Anti-Gravity — the common case |
| **Streamable HTTP** | `opencode-mcp --http --port 7777` | remote clients, multiple agents, Docker, settings UI |

Runtime: Node ≥ 20, TypeScript ESM, `@modelcontextprotocol/sdk@^1.32`, `@opencode/client@^2.3`,
`zod@^4`, `tsup` build, single `npx opencode-mcp-server` entry.

### Client wiring

```toml
# ~/.codex/config.toml
[mcp_servers.opencode]
command = "npx"
args = ["-y", "opencode-mcp-server"]
env = { OPENCODE_URL = "http://127.0.0.1:4096", OPENCODE_PASSWORD = "…" }
```

```sh
# Claude Code
claude mcp add opencode -e OPENCODE_URL=http://127.0.0.1:4096 -e OPENCODE_PASSWORD=… \
  -- npx -y opencode-mcp-server
```

```json
// Claude Desktop / Anti-Gravity (JSON MCP config — same command/args/env shape)
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "opencode-mcp-server"],
      "env": {
        "OPENCODE_URL": "http://127.0.0.1:4096",
        "OPENCODE_PASSWORD": "…",
        "OPENCODE_MCP_DIRECTORY": "/abs/path/to/project"
      }
    }
  }
}
```

```json
// HTTP transport
{ "mcpServers": { "opencode": {
    "url": "http://127.0.0.1:7777/mcp",
    "headers": { "Authorization": "Bearer ${OPENCODE_MCP_TOKEN}" } } } }
```

> If a client's MCP page only offers a command field (no env form), the two values can be pasted as
> `--url` / `--password` args. Both forms are accepted by the CLI.

---

## 7. Security model

An MCP tool that drives an agent with shell access is **remote code execution by design**.

1. **Loopback only** in HTTP mode; require a bridge bearer token (generated on first run, `0600`).
2. **Password handling** — never printed, never logged, redacted in errors/audit, stored only in
   the client's own MCP config or `~/.config/opencode-mcp/config.json` (`0600`). Keychain storage
   is a later enhancement.
3. **Roots allowlist** — `allowedRoots` / `OPENCODE_MCP_ALLOWED_ROOTS`; refuse anything outside,
   including `..` traversal and symlink escapes (`realpath` first).
4. **Permission profiles** — `read-only` (default for unknown clients), `workspace-write`,
   `danger-full-access` (explicit opt-in, loud warning).
5. **No credential passthrough** — never return provider keys from `/api/credential`,
   `/api/provider`, or config. Redact `apiKey`, `authorization`, `*_TOKEN`, `password`.
6. **Attachment hygiene** — 10 MB cap, MIME sniffing, write only inside `.opencode/attachments/`.
7. **Audit log** — append-only JSONL: timestamp, client, tool, sessionID, directory, args hash,
   decision. Enough to reconstruct *who ran what where*.
8. **Recursion guard** — if OpenCode itself is configured with this MCP server, the bridge detects
   its own name in `mcp.list()` and refuses to spawn looping sessions.
9. **Kill switch** — `opencode_session_interrupt` plus a global `--read-only` mode.
10. **Config tool guardrails** — `opencode_configure` validates first, never echoes the password,
    cannot change `allowedRoots`/`permissionProfile`, and accepts loopback URLs only unless
    `--allow-remote-url` is set (§2.4).

---

## 8. Repository layout

```
opencode-mcp-server/
├─ docs/plan.md
├─ package.json  tsconfig.json  tsup.config.ts
├─ src/
│  ├─ index.ts            entry: args, transport selection
│  ├─ configure.ts        CLI `configure`, config file read/write, 0600
│  ├─ config.ts           env + file precedence, schema validation
│  ├─ status.ts           opencode_status state machine
│  ├─ client.ts           @opencode/client wrapper: auth, retry, error mapping
│  ├─ workspace.ts        roots/cwd/default resolution + allowlist
│  ├─ policy.ts           permission profiles, redaction, audit
│  ├─ tools/
│  │  ├─ session.ts  prompt.ts  model.ts  agent.ts  task.ts
│  │  ├─ files.ts    mcp.ts    history.ts  permission.ts  workspace.ts  events.ts
│  ├─ resources.ts        opencode://session/{id}/... artifacts
│  ├─ http.ts             Streamable HTTP transport, token auth, /configure
│  └─ log.ts
├─ test/{unit,integration,fixtures}/
└─ README.md
```

---

## 9. Milestones

| M | Deliverable | Acceptance criteria |
|---|---|---|
| **M0** | Spike (1 d) | `OpenCode.make` + Basic auth reaches `/api/info`; version 2 enforced; create session in arbitrary dir; prompt "say hi"; read reply; `data:` attachment round-trips |
| **M1** | Config + status + core (3 d) | Unconfigured server still lists tools and answers `opencode_status`; `configure` CLI writes 0600 file; `opencode_configure` repairs a bad config in-chat; `session_create/list/get/move/prompt/history` work from Claude Code |
| **M2** | Models & agents (2 d) | `model list/default/set` (session + global); `agent list/set/delegate`; `opencode_task` returns a subagent transcript |
| **M3** | Files (2 d) | Path, base64, and fs-write paths all attach; artifacts retrievable as resources |
| **M4** | Compaction, permissions, interrupt (2 d) | A run hitting `*.env` can be approved programmatically; compact shrinks tokens with a summary |
| **M5** | MCP admin (2 d) | List/status, add+connect a remote server, enumerate resources |
| **M6** | HTTP transport + security (3 d) | Bridge token, roots allowlist, audit log, `POST /configure`; two clients share one bridge |
| **M7** | Packaging + docs (2 d) | `npx opencode-mcp-server` works; README with per-client configs; verified on Codex + Claude + Anti-Gravity |
| **M8** | Hardening (3 d) | Integration suite green; 80 %+ unit coverage on mapping/policy; graceful degradation when OpenCode is down |

≈ 20 working days for one engineer; M1–M4 are the must-have core.

---

## 10. Testing strategy

- **Unit** — config precedence, workspace chain, path allowlist (traversal/symlink), redaction,
  message → markdown, permission profile → ruleset, error mapping.
- **Integration** (live service, `RUN_LIVE=1`) — configure → status → create → prompt → wait →
  history → compact → delete; attachment round-trip; subagent; permission reply; model switch.
- **Config tests** — no URL, bad URL, wrong password (401), v1 server, unreachable host, malformed
  config file: each must produce the exact §2.2 state without crashing.
- **Contract tests** — snapshot `/openapi.json`; fail CI when a used endpoint's shape changes.
- **Client smoke tests** — scripted Codex CLI, Claude Code, and Anti-Gravity configs; assert tool
  list, one happy-path prompt, and the unconfigured message.
- **Negative tests** — directory outside allowlist, oversized attachment, invalid model ref,
  interrupted run, OpenCode restarted mid-session.

---

## 11. Risks & open questions

| Risk / question | Impact | Mitigation / next step |
|---|---|---|
| Users paste the wrong password/URL | Total failure, bad first impression | `opencode_status` diagnoses precisely (401 vs unreachable vs v1); never fails fast at boot |
| Password in plaintext client config | Leakage via dotfiles/screenshots | 0600 file option, keychain later, docs recommend env var over committed config |
| `prompt` is fire-and-forget; `wait` has no timeout | Slow/hung clients | Bridge timeout + `interrupt`; return `status: "timeout"` with session still running |
| Per-session MCP tool *assignment* unsupported | Feature #6 is partial | Server enable/disable + permission ruleset; documented in tool description |
| Clients spawn MCP servers with `$HOME` cwd | Sessions in the wrong directory | roots + hints + explicit arg + `workspace info` |
| Attachment size vs MCP result limits | Truncation/failures | 10 MB cap, spill to scratch dir + resource URI |
| Permission prompts block headless runs | Deadlock | `opencode_permission` + default `ask` policy surfaced to the client |
| v2 API is "experimental" and may shift | Breakage on upgrade | v2 version gate, SDK pinned to matching minor, contract tests |
| Recursive self-invocation (OpenCode → this → OpenCode) | Infinite loop | Recursion guard in §7 |
| Tool-count bloat degrades model choice | Poor tool selection | 18 tools max, `--profile minimal` (9), grouped `action` params |
| A prompt could redirect the bridge via `opencode_configure` | Credential/data exfiltration | Validate-first, loopback-only URLs by default, admin-only fields locked, `persist` opt-in (§2.4) |

**Open questions**

1. Should `configure` also support OS keyring (`libsecret` / macOS Keychain) in v1, or is a 0600
   file acceptable? *(default: file first)*
2. Exact Anti-Gravity MCP config file path and whether it exposes an env-field form — confirm in M7.
3. For remote HTTP use, should each client get its own bridge token + permission profile?

---

## 12. Out of scope (for now)

- Replacing the TUI or building a GUI (the `POST /configure` endpoint is the hook for one).
- Hosting inference ourselves (OpenCode providers do that).
- Multi-tenant auth (single-user local tool first).
- Voice / PTY / schedule / artifact endpoints — reachable later without schema changes.
- OpenCode v1 support (explicitly rejected, see §2.3).

---

## 13. Definition of done

1. `npx opencode-mcp-server` starts **unconfigured**, lists 19 tools, and `opencode_status` explains
   exactly what is missing.
2. Supplying `OPENCODE_URL` + `OPENCODE_PASSWORD` (env, CLI, or `opencode_configure` in-chat) flips
   it to healthy; wrong credentials give a 401-specific message; a v1 server is refused with an
   upgrade hint.
3. From Claude Code (and Codex): *"open a session in this repo, use `opencode/iceman-free`, attach
   `README.md`, refactor module X, summarize"* works with progress and no TUI interaction.
4. A second client attaches over HTTP with a token and sees the same sessions.
5. Killing OpenCode produces one clear, actionable error — never a hang.
6. Security checks (§7) are enforced by tests, not just documented.
