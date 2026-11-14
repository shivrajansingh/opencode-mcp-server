import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { invalidInput } from "../errors.js"
import { openClient, register, workspaceFor, type ServerContext } from "./shared.js"
import { runTask } from "./task.js"

export function registerAgentTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_agent",
    {
      title: "Agents and subagents",
      description:
        "List available agents (primary and subagent), switch the agent of a session, or delegate a one-shot task " +
        "to a subagent. Delegation creates a real child session and returns its transcript.",
      inputSchema: {
        action: z.enum(["list", "set", "delegate"]),
        directory: z.string().optional(),
        sessionID: z.string().optional().describe("For action=set"),
        agent: z.string().optional().describe("Agent id, e.g. general, explore, build"),
        prompt: z.string().optional().describe("For action=delegate"),
        parentSessionID: z.string().optional(),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const workspace = await workspaceFor(ctx, args.directory)
      const { client } = await openClient(ctx)

      if (args.action === "list") {
        const response = await client.agent.list({ location: { directory: workspace.directory } })
        return {
          directory: workspace.directory,
          agents: response.data.map((agent) => ({
            id: agent.id,
            name: agent.name,
            mode: agent.mode,
            hidden: agent.hidden,
            description: agent.description,
            model: agent.model,
          })),
        }
      }

      if (args.action === "set") {
        if (!args.sessionID) throw invalidInput("action=set requires sessionID")
        if (!args.agent) throw invalidInput("action=set requires agent")
        await client.session.switchAgent({ sessionID: args.sessionID, agent: args.agent })
        return { ok: true, sessionID: args.sessionID, agent: args.agent }
      }

      if (!args.prompt) throw invalidInput("action=delegate requires prompt")
      return runTask(ctx, {
        directory: workspace.directory,
        prompt: args.prompt,
        agent: args.agent ?? "general",
        parentSessionID: args.parentSessionID,
        timeoutMs: args.timeoutMs,
      })
    },
  )
}
