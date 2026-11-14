import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { invalidInput } from "../errors.js"
import { assertWritable, openClient, register, workspaceFor, type ServerContext } from "./shared.js"

const localConfig = z.object({
  type: z.literal("local"),
  command: z.array(z.string()),
  cwd: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
})

const remoteConfig = z.object({
  type: z.literal("remote"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
})

export function registerMcpTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_mcp",
    {
      title: "OpenCode MCP servers",
      description:
        "Inspect and manage the MCP servers that OpenCode itself uses (not this bridge). " +
        "Actions: list (servers + connection status), resources (tool/resource catalog), " +
        "add (local or remote), remove, connect, disconnect. " +
        "Server enablement is global per OpenCode project; per-session tool filtering is done with session permissions.",
      inputSchema: {
        action: z.enum(["list", "resources", "add", "remove", "connect", "disconnect"]),
        directory: z.string().optional(),
        server: z.string().optional().describe("Server name, for add/remove/connect/disconnect"),
        config: z.union([localConfig, remoteConfig]).optional().describe("Server config for action=add"),
        types: z.array(z.string()).optional().describe("Resource types for action=resources"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const workspace = await workspaceFor(ctx, args.directory)
      const location = { directory: workspace.directory }
      const { client } = await openClient(ctx)

      if (args.action === "list") {
        const response = await client.mcp.list({ location })
        return {
          directory: workspace.directory,
          servers: response.data.map((entry) => ({
            name: entry.name,
            title: entry.title,
            status: entry.status,
            integrationID: entry.integrationID,
          })),
        }
      }

      if (args.action === "resources") {
        const response = await client.mcp.resource.catalog({ location })
        return { directory: workspace.directory, catalog: response.data }
      }

      assertWritable(ctx, `MCP ${args.action}`)
      if (!args.server) throw invalidInput(`action=${args.action} requires server`)

      if (args.action === "add") {
        if (!args.config) throw invalidInput("action=add requires config")
        await client.mcp.add({ server: args.server, location, config: args.config as any })
        return { ok: true, added: args.server, config: args.config }
      }
      if (args.action === "remove") {
        await client.mcp.remove({ server: args.server, location })
        return { ok: true, removed: args.server }
      }
      if (args.action === "connect") {
        await client.mcp.connect({ server: args.server, location })
        return { ok: true, connected: args.server }
      }
      await client.mcp.disconnect({ server: args.server, location })
      return { ok: true, disconnected: args.server }
    },
  )
}
