import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describeConfig, saveConfigFile } from "../config.js"
import { invalidInput } from "../errors.js"
import { register, type ServerContext, workspaceFor } from "./shared.js"

export function registerConfigTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_status",
    {
      title: "OpenCode status",
      description:
        "Report whether this MCP bridge is configured and connected to an OpenCode v2 server. " +
        "Works even when nothing is configured, so it is the first tool to call when something looks wrong.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const state = await ctx.bridge.probe()
      const provenance = await describeConfig()
      const out: Record<string, unknown> = {
        configured: state.configured,
        connected: state.connected,
        url: state.url ?? provenance.url.value,
        configSource: provenance.url.source,
        passwordPresent: provenance.password.present,
        version: state.version,
        hostname: state.hostname,
        pid: state.pid,
        error: state.error,
        message: state.message,
        hint: state.hint,
      }

      if (state.connected) {
        try {
          const workspace = await workspaceFor(ctx)
          out.directory = workspace.directory
          out.directorySource = workspace.source
          const client = await ctx.bridge.client()
          const [agents, model] = await Promise.all([
            client.agent.list({ location: { directory: workspace.directory } }).catch(() => null),
            client.model.default({ location: { directory: workspace.directory } }).catch(() => null),
          ])
          if (agents) out.agents = agents.data.map((agent) => ({ id: agent.id, name: agent.name, mode: agent.mode }))
          if (model?.data) out.defaultModel = { providerID: model.data.providerID, id: model.data.modelID }
        } catch {
          // Status must never fail because a secondary lookup did.
        }
      }
      return out
    },
  )

  register(
    server,
    "opencode_configure",
    {
      title: "Configure OpenCode connection",
      description:
        "Set or repair the OpenCode v2 server address and password from inside the chat. " +
        "The values are validated against GET /api/info before they are applied; nothing changes on failure. " +
        "The password is never echoed back, is kept in memory by default, and is only written to disk when persist=true. " +
        "Prefer configuring OPENCODE_URL and OPENCODE_PASSWORD in the MCP client settings when possible.",
      inputSchema: {
        url: z.string().optional().describe("OpenCode server address, e.g. http://127.0.0.1:4096"),
        password: z.string().optional().describe("OpenCode Basic-auth password (username is always 'opencode')"),
        persist: z.boolean().optional().describe("Write the values to the 0600 config file (default false)"),
        test: z.boolean().optional().describe("Validate and report, without applying"),
        clear: z.boolean().optional().describe("Forget runtime credentials"),
        removeFile: z.boolean().optional().describe("With clear=true, also delete the stored config file"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      if (args.clear) {
        const state = await ctx.bridge.clear({ includeFile: Boolean(args.removeFile) })
        return { ok: true, configured: state.configured, connected: state.connected, error: state.error }
      }
      if (!args.url && !args.password) {
        throw invalidInput("Provide url and/or password, or clear=true.")
      }
      const state = await ctx.bridge.configure(
        { url: args.url, password: args.password, persist: Boolean(args.persist), test: Boolean(args.test) },
        { allowRemoteUrl: ctx.allowRemoteUrl },
      )
      return {
        ok: state.connected,
        configured: state.configured,
        connected: state.connected,
        url: state.url,
        version: state.version,
        hostname: state.hostname,
        persisted: Boolean(args.persist) && !args.test,
        tested: Boolean(args.test),
      }
    },
  )

  register(
    server,
    "opencode_workspace",
    {
      title: "Resolve workspace directory",
      description:
        "Report which directory sessions will use, where that choice came from (argument, MCP roots, env, config, cwd), " +
        "or persist a new default. Use this before creating a session when you are unsure about the working directory.",
      inputSchema: {
        action: z.enum(["info", "set-default", "list-roots"]).optional().describe("Default: info"),
        directory: z.string().optional().describe("Absolute path (required for set-default)"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const action = args.action ?? "info"
      if (action === "list-roots") {
        const roots = await ctx.rootsProvider().catch(() => [])
        return { roots }
      }
      if (action === "set-default") {
        if (!args.directory) throw invalidInput("directory is required for set-default")
        const workspace = await workspaceFor(ctx, args.directory)
        await saveConfigFile({ defaultDirectory: workspace.directory })
        return { ok: true, directory: workspace.directory, persisted: true }
      }
      const workspace = await workspaceFor(ctx, args.directory)
      return {
        directory: workspace.directory,
        source: workspace.source,
        defaultDirectory: workspace.config?.defaultDirectory,
        allowedRoots: workspace.config?.allowedRoots ?? null,
        permissionProfile: workspace.config?.permissionProfile,
      }
    },
  )
}
