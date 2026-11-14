import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { BridgeError } from "../errors.js"
import { redact } from "../log.js"
import { openClient, register, workspaceFor, type ServerContext } from "./shared.js"

type Detail = "summary" | "tools" | "full"

export function registerHistoryTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_session_history",
    {
      title: "Read session history",
      description:
        "Audit a session. Default detail='summary' returns only what a caller usually needs: the user prompt, " +
        "the assistant's answers, token totals and a count of tools used — no tool arguments or outputs. " +
        "detail='tools' adds one line per step (name and status; targets only with includeTargets=true). " +
        "detail='full' is disabled for security unless the bridge was started with --allow-full-history. " +
        "The full transcript is never sent by default.",
      inputSchema: {
        sessionID: z.string(),
        detail: z
          .enum(["summary", "tools", "full"])
          .optional()
          .describe("summary (default) | tools | full (admin-only, usually disabled)"),
        includeTargets: z
          .boolean()
          .optional()
          .describe("detail='tools': include a redacted path/command target per step (default false)"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 100"),
        cursor: z.string().optional().describe("Pagination cursor from a previous call"),
        order: z.enum(["asc", "desc"]).optional(),
        includeReasoning: z.boolean().optional().describe("Only with admin-enabled detail='full'"),
        format: z.enum(["json", "markdown"]).optional().describe("Default json"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const detail: Detail = args.detail ?? "summary"

      if (detail === "full" && !ctx.allowFullHistory) {
        throw new BridgeError(
          "INVALID_INPUT",
          "Full session history is disabled on this bridge for security reasons.",
          {
            hint:
              "Use detail='summary' or detail='tools'. To allow raw tool inputs/outputs locally, restart the " +
              "bridge with --allow-full-history (or OPENCODE_MCP_ALLOW_FULL_HISTORY=1).",
          },
        )
      }
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

      const messages: any[] = []
      for (const message of response.data) {
        const rendered = render(message, detail, args.includeReasoning ?? false, args.includeTargets ?? false)
        if (rendered) messages.push(rendered)
      }

      // Tool usage is aggregated from the raw messages, independent of the detail level.
      const toolUsage: Record<string, number> = {}
      for (const message of response.data) {
        for (const part of (message as any).content ?? []) {
          if (part?.type !== "tool") continue
          const name = part.name ?? part.tool ?? "tool"
          toolUsage[name] = (toolUsage[name] ?? 0) + 1
        }
      }

      const result: Record<string, unknown> = {
        sessionID: args.sessionID,
        title: session.title,
        directory: session.location?.directory ?? (await workspaceFor(ctx)).directory,
        totals: {
          cost: session.cost,
          tokens: session.tokens,
          messageCount: response.data.length,
        },
        toolUsage,
        messages,
      }

      // Cursor tokens are only useful when the caller is actually paging.
      if (args.cursor || detail === "full") result.cursor = response.cursor ?? null

      if ((args.format ?? "json") === "markdown") {
        result.markdown = toMarkdown(session.title, messages)
      }
      return result
    },
  )
}

function render(message: any, detail: Detail, includeReasoning: boolean, includeTargets: boolean): unknown | null {
  if (message.type === "user") {
    return {
      role: "user",
      text: message.text,
      ...(message.files?.length ? { attachments: message.files.length } : {}),
    }
  }

  if (message.type === "assistant") {
    const parts = (message.content ?? []) as any[]
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    const tools = parts.filter((part) => part.type === "tool")

    if (detail === "summary") {
      // Step messages carry no prose; their tool counts are aggregated separately.
      if (!text) return null
      return { role: "assistant", ...(message.agent ? { agent: message.agent } : {}), text }
    }

    if (detail === "tools") {
      if (!text && tools.length === 0) return null
      return {
        role: "assistant",
        ...(message.agent ? { agent: message.agent } : {}),
        ...(text ? { text } : {}),
        ...(tools.length
          ? {
              tools: tools.map((part) => ({
                name: part.name ?? part.tool ?? "tool",
                status: part.state?.status ?? "unknown",
                ...(includeTargets && toolTarget(part.state?.input)
                  ? { target: redact(toolTarget(part.state?.input)!) }
                  : {}),
              })),
            }
          : {}),
      }
    }

    // detail === "full" (admin-enabled only). Redact secrets even then.
    const reasoning = includeReasoning
      ? parts
          .filter((part) => part.type === "reasoning")
          .map((part) => part.text)
          .join("\n")
      : undefined
    return {
      role: "assistant",
      at: message.time?.created,
      ...(message.agent ? { agent: message.agent } : {}),
      ...(message.model ? { model: message.model } : {}),
      ...(text ? { text } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(tools.length
        ? {
            tools: tools.map((part) => ({
              name: part.name ?? part.tool ?? "tool",
              status: part.state?.status ?? "unknown",
              input: redactValue(part.state?.input),
              output: redactValue(truncate(part.state?.output, 300)),
            })),
          }
        : {}),
      ...(message.cost !== undefined ? { cost: message.cost } : {}),
      ...(message.tokens ? { tokens: message.tokens } : {}),
      ...(message.finish ? { finish: message.finish } : {}),
      ...(message.error ? { error: message.error } : {}),
    }
  }

  if (detail !== "full") return null
  if (message.type === "compaction") return { role: "compaction", at: message.time?.created, state: message.state }
  if (message.type === "shell") return { role: "shell", at: message.time?.created, command: message.command }
  return { role: message.type ?? "event", at: message.time?.created }
}

/** A tiny, human-useful handle for a tool call: path, command, query or file. */
function toolTarget(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  for (const key of ["path", "filePath", "file", "command", "query", "url", "pattern"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return value.length > 80 ? `${value.slice(0, 80)}…` : value
    }
  }
  return undefined
}

function truncate(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Redact a structured value while keeping it JSON-friendly. */
function redactValue<T>(value: T): T {
  if (value === undefined || value === null) return value
  if (typeof value === "string") return redact(value) as unknown as T
  try {
    return JSON.parse(redact(JSON.stringify(value))) as T
  } catch {
    return redact(String(value)) as unknown as T
  }
}

function toMarkdown(title: string | undefined, messages: any[]): string {
  const lines: string[] = [`# ${title ?? "Session transcript"}`, ""]
  for (const message of messages) {
    if (message.role === "user") {
      lines.push("## User", "", message.text ?? "", "")
    } else if (message.role === "assistant") {
      lines.push(`## Assistant${message.agent ? ` (${message.agent})` : ""}`, "", message.text ?? "", "")
      for (const tool of message.tools ?? []) {
        lines.push(`- \`${tool.name}\` — ${tool.status ?? "unknown"}${tool.target ? ` — ${tool.target}` : ""}`)
      }
      if (message.tools?.length) lines.push("")
    }
  }
  return lines.join("\n")
}
