import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { openClient, register, workspaceFor, type ServerContext } from "./shared.js"

export function registerHistoryTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_session_history",
    {
      title: "Read session history",
      description:
        "Read a session's messages and totals. Useful for inspecting what an agent did, auditing tool calls, " +
        "or exporting a transcript to another client.",
      inputSchema: {
        sessionID: z.string(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 100"),
        cursor: z.string().optional(),
        order: z.enum(["asc", "desc"]).optional(),
        includeToolCalls: z.boolean().optional().describe("Include tool calls in rendered output (default true)"),
        includeReasoning: z.boolean().optional().describe("Include reasoning blocks (default false)"),
        format: z.enum(["json", "markdown", "transcript"]).optional().describe("Default json"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { client } = await openClient(ctx)
      const [session, response] = await Promise.all([
        client.session.get({ sessionID: args.sessionID }),
        client.message.list({
          sessionID: args.sessionID,
          limit: args.limit ?? 100,
          order: args.order ?? "asc",
          cursor: args.cursor,
        }),
      ])

      const format = args.format ?? "json"
      const messages = response.data.map((message) => render(message, args.includeReasoning ?? false))
      const result = {
        sessionID: args.sessionID,
        title: session.title,
        directory: session.location?.directory ?? (await workspaceFor(ctx)).directory,
        totals: {
          cost: session.cost,
          tokens: session.tokens,
          messageCount: response.data.length,
        },
        cursor: response.cursor ?? null,
        messages,
      }

      if (format === "json") return result

      const markdown = toMarkdown(result.title, messages, args.includeToolCalls !== false)
      return { ...result, markdown }
    },
  )
}

function render(message: any, includeReasoning: boolean) {
  const at = message.time?.created
  switch (message.type) {
    case "user":
      return { role: "user", at, text: message.text, attachments: message.files?.length ?? 0 }
    case "assistant": {
      const parts = (message.content ?? []) as any[]
      return {
        role: "assistant",
        at,
        agent: message.agent,
        model: message.model,
        text: parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim(),
        reasoning: includeReasoning
          ? parts
              .filter((part) => part.type === "reasoning")
              .map((part) => part.text)
              .join("\n")
          : undefined,
        tools: parts
          .filter((part) => part.type === "tool")
          .map((part) => ({
            name: part.name ?? part.tool,
            status: part.state?.status,
            input: part.state?.input,
            output: summarizeOutput(part.state?.output),
          })),
        cost: message.cost,
        tokens: message.tokens,
        finish: message.finish,
        error: message.error,
      }
    }
    case "compaction":
      return { role: "compaction", at, state: message.state }
    case "shell":
      return { role: "shell", at, command: message.command }
    default:
      return { role: message.type ?? "event", at }
  }
}

function summarizeOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined
  const text = typeof output === "string" ? output : JSON.stringify(output)
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

function toMarkdown(title: string | undefined, messages: any[], includeTools: boolean): string {
  const lines: string[] = [`# ${title ?? "Session transcript"}`, ""]
  for (const message of messages) {
    if (message.role === "user") {
      lines.push(`## User`, "", message.text ?? "", "")
    } else if (message.role === "assistant") {
      lines.push(`## Assistant${message.agent ? ` (${message.agent})` : ""}`, "", message.text ?? "", "")
      if (includeTools && message.tools?.length) {
        for (const tool of message.tools) {
          lines.push(`- \`${tool.name}\` — ${tool.status ?? "unknown"}`)
        }
        lines.push("")
      }
    } else if (message.role === "compaction") {
      lines.push(`## Compaction`, "", `state: ${message.state ?? "unknown"}`, "")
    }
  }
  return lines.join("\n")
}
