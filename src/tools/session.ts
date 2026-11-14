import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { invalidInput } from "../errors.js"
import { assertWritable, openClient, register, workspaceFor, type ServerContext } from "./shared.js"

const modelRef = z.object({
  providerID: z.string(),
  id: z.string(),
  variant: z.string().optional(),
})

const permissionRule = z.object({
  action: z.string(),
  resource: z.string(),
  effect: z.enum(["allow", "deny", "ask"]),
})

export function registerSessionTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_session_create",
    {
      title: "Create OpenCode session",
      description:
        "Create a new OpenCode session in a directory. Defaults to the client's current workspace. " +
        "Use agent='build' for implementation work, 'plan' for planning, and 'general'/'explore' for subagents. " +
        "Pass parentSessionID to create a child (subagent) session.",
      inputSchema: {
        directory: z.string().optional().describe("Absolute working directory for the session"),
        title: z.string().optional(),
        agent: z.string().optional().describe("Agent id, e.g. build, plan, general, explore"),
        model: modelRef.optional().describe("Explicit model, e.g. { providerID: 'opencode', id: 'iceman-free' }"),
        parentSessionID: z.string().optional().describe("Makes this a subagent session"),
        permissions: z.array(permissionRule).optional().describe("Per-session permission ruleset"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const workspace = await workspaceFor(ctx, args.directory)
      const { client } = await openClient(ctx)
      const info = await client.session.create({
        location: { directory: workspace.directory },
        title: args.title,
        agent: args.agent,
        model: args.model,
        parentID: args.parentSessionID,
        permissions: args.permissions,
      })
      return {
        sessionID: info.id,
        title: info.title,
        directory: info.location?.directory ?? workspace.directory,
        agent: info.agent,
        model: info.model ?? args.model ?? null,
        parentSessionID: info.parentID ?? null,
      }
    },
  )
}

export function registerSessionAdminTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_session_list",
    {
      title: "List OpenCode sessions",
      description: "List sessions, newest first. Filter by directory, search text, archive state, or parent session.",
      inputSchema: {
        directory: z.string().optional(),
        search: z.string().optional(),
        archived: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
        parentSessionID: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const workspace = await workspaceFor(ctx, args.directory)
      const { client } = await openClient(ctx)
      const response = await client.session.list({
        directory: workspace.directory,
        search: args.search,
        archived: args.archived,
        limit: args.limit ?? 20,
        cursor: args.cursor,
        parentID: args.parentSessionID,
      })
      return {
        directory: workspace.directory,
        sessions: response.data.map(summarize),
        cursor: response.cursor ?? null,
      }
    },
  )

  register(
    server,
    "opencode_session_get",
    {
      title: "Get OpenCode session",
      description: "Fetch one session's metadata: title, agent, model, cost, tokens, timestamps and outcome.",
      inputSchema: { sessionID: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { client } = await openClient(ctx)
      const info = await client.session.get({ sessionID: args.sessionID })
      return summarize(info)
    },
  )

  register(
    server,
    "opencode_session_move",
    {
      title: "Move OpenCode session",
      description: "Change the working directory of an existing session.",
      inputSchema: {
        sessionID: z.string(),
        directory: z.string().describe("New absolute working directory"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      assertWritable(ctx, "moving a session")
      if (!args.directory) throw invalidInput("directory is required")
      const workspace = await workspaceFor(ctx, args.directory)
      const { client } = await openClient(ctx)
      await client.session.move({ sessionID: args.sessionID, directory: workspace.directory })
      return { ok: true, sessionID: args.sessionID, directory: workspace.directory }
    },
  )

  register(
    server,
    "opencode_session_delete",
    {
      title: "Delete OpenCode session",
      description: "Delete a session and its messages.",
      inputSchema: { sessionID: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      assertWritable(ctx, "deleting a session")
      const { client } = await openClient(ctx)
      await client.session.remove({ sessionID: args.sessionID })
      return { ok: true, deleted: args.sessionID }
    },
  )

  register(
    server,
    "opencode_session_interrupt",
    {
      title: "Interrupt OpenCode run",
      description: "Stop the current run in a session. The session stays usable afterwards.",
      inputSchema: { sessionID: z.string() },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const { client } = await openClient(ctx)
      const response = await client.session.interrupt({ sessionID: args.sessionID })
      return { ok: true, sessionID: args.sessionID, response }
    },
  )

  register(
    server,
    "opencode_session_compact",
    {
      title: "Compact OpenCode session",
      description:
        "Summarize older turns to free context. Returns the compaction inbox item and token totals before/after " +
        "when the service reports them.",
      inputSchema: {
        sessionID: z.string(),
        wait: z.boolean().optional().describe("Wait for the compaction to finish (default true)"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      assertWritable(ctx, "compacting a session")
      const { client } = await openClient(ctx)
      const before = await client.session.get({ sessionID: args.sessionID }).catch(() => null)
      const inbox = await client.session.compact({ sessionID: args.sessionID })
      if (args.wait !== false) {
        await client.experimental.session.wait({ sessionID: args.sessionID }).catch(() => undefined)
      }
      const after = await client.session.get({ sessionID: args.sessionID }).catch(() => null)
      return {
        ok: true,
        sessionID: args.sessionID,
        inbox,
        before: before ? { tokens: before.tokens, cost: before.cost } : null,
        after: after ? { tokens: after.tokens, cost: after.cost } : null,
      }
    },
  )
}

function summarize(info: any) {
  return {
    sessionID: info.id,
    title: info.title,
    parentSessionID: info.parentID ?? null,
    directory: info.location?.directory,
    agent: info.agent,
    model: info.model,
    cost: info.cost,
    tokens: info.tokens,
    outcome: info.outcome,
    created: info.time?.created,
    updated: info.time?.updated,
  }
}
