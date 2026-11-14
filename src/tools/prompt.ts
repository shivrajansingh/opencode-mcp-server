import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { OpenCodeClient } from "@opencode/client"
import { invalidInput } from "../errors.js"
import { assertWritable, openClient, register, workspaceFor, type ServerContext } from "./shared.js"

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

const fileInput = z.object({
  uri: z.string().optional().describe("data: URI, file: URI, or absolute path"),
  path: z.string().optional().describe("Absolute or workspace-relative path to read and attach"),
  name: z.string().optional(),
  description: z.string().optional(),
})

export function registerPromptTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_session_prompt",
    {
      title: "Prompt an OpenCode session",
      description:
        "Send a message to a session and (by default) wait for the answer. " +
        "Returns the assistant text, new turns, tool calls and usage. " +
        "Attach files with `files` (path or data: URI). Set wait=false for fire-and-forget.",
      inputSchema: {
        sessionID: z.string(),
        text: z.string().describe("The prompt text"),
        files: z.array(fileInput).optional(),
        agents: z.array(z.object({ name: z.string() })).optional().describe("Agents the model may delegate to"),
        skills: z.array(z.object({ id: z.string() })).optional(),
        wait: z.boolean().optional().describe("Wait for the run to finish (default true)"),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).optional().describe("Default 45000 (kept under typical MCP client timeouts)"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => executePrompt(ctx, args as unknown as PromptInput),
  )
}

export interface PromptInput {
  sessionID: string
  text: string
  files?: Array<{ uri?: string; path?: string; name?: string; description?: string }>
  agents?: Array<{ name: string }>
  skills?: Array<{ id: string }>
  wait?: boolean
  timeoutMs?: number
}

export async function executePrompt(ctx: ServerContext, input: PromptInput) {
  assertWritable(ctx, "sending prompts")
  if (!input.text?.trim() && !(input.files?.length ?? 0)) {
    throw invalidInput("Provide text and/or at least one file.")
  }

  const { client } = await openClient(ctx)
  const session = await client.session.get({ sessionID: input.sessionID })
  const directory = session.location?.directory ?? (await workspaceFor(ctx)).directory

  const files = await Promise.all((input.files ?? []).map((file) => toAttachment(directory, file)))
  const startedAt = Date.now()

  await client.session.prompt({
    sessionID: input.sessionID,
    text: input.text ?? "",
    files,
    agents: input.agents,
    skills: input.skills,
  })

  const shouldWait = input.wait !== false
  const status = shouldWait ? await waitForIdle(client, input.sessionID, input.timeoutMs ?? 45_000) : "running"

  const messages = await collectMessages(client, input.sessionID, startedAt)
  const text = assistantText(messages)
  const tools = toolCalls(messages)
  const usage = usageFrom(messages)

  const resolvedStatus = status === "idle" && messages.length === 0 ? "empty" : status

  return {
    sessionID: input.sessionID,
    status: resolvedStatus,
    directory,
    text,
    messages: messages.map(renderMessage),
    tools,
    usage,
    attachments: files.map((file) => ({ name: file.name, uri: previewUri(file.uri) })),
    hint:
      resolvedStatus === "idle"
        ? undefined
        : resolvedStatus === "empty"
          ? "The provider returned no messages. The prompt may not have been delivered; retry, or inspect the session in the OpenCode TUI."
          : "The run is still in progress. Poll opencode_session_history until it is idle, or call opencode_session_interrupt to stop it.",
  }
}

async function waitForIdle(client: OpenCodeClient, sessionID: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await client.experimental.session.wait({ sessionID }, { signal: controller.signal })
    return "idle"
  } catch (error) {
    if (controller.signal.aborted) return "timeout"
    const message = (error as Error)?.message ?? ""
    if (/abort/i.test(message)) return "timeout"
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function collectMessages(client: OpenCodeClient, sessionID: string, since: number): Promise<any[]> {
  const response = await client.message.list({ sessionID, limit: 100, order: "desc" })
  const recent = response.data.filter((message) => (message.time?.created ?? 0) >= since - 1_000)
  return recent.reverse()
}

function assistantText(messages: any[]): string {
  return messages
    .filter((message) => message.type === "assistant")
    .flatMap((message) => (message.content ?? []).filter((part: any) => part.type === "text"))
    .map((part: any) => part.text ?? "")
    .join("\n\n")
    .trim()
}

function toolCalls(messages: any[]) {
  const out: Array<{ name: string; status: string; input?: unknown }> = []
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content ?? []) {
      if (part.type !== "tool") continue
      out.push({ name: part.name ?? part.tool ?? "tool", status: part.state?.status ?? "unknown", input: part.state?.input })
    }
  }
  return out
}

function usageFrom(messages: any[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === "assistant" && (message.cost !== undefined || message.tokens)) {
      return { cost: message.cost, tokens: message.tokens }
    }
  }
  return null
}

function renderMessage(message: any) {
  switch (message.type) {
    case "user":
      return { type: "user", text: message.text, at: message.time?.created }
    case "assistant": {
      const text = (message.content ?? [])
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n")
      const tools = (message.content ?? [])
        .filter((part: any) => part.type === "tool")
        .map((part: any) => ({ name: part.name ?? part.tool, status: part.state?.status }))
      return { type: "assistant", agent: message.agent, text, tools, cost: message.cost, tokens: message.tokens }
    }
    default:
      return { type: message.type, at: message.time?.created }
  }
}

async function toAttachment(
  directory: string,
  file: { uri?: string; path?: string; name?: string; description?: string },
): Promise<{ uri: string; name?: string; description?: string; source: { type: "inline" } }> {
  if (file.uri && !file.path) {
    return {
      uri: file.uri,
      name: file.name,
      description: file.description,
      source: { type: "inline" },
    }
  }
  const target = file.path ?? file.uri
  if (!target) throw invalidInput("Each file needs a path or a uri.")
  if (/^data:/.test(target)) {
    return { uri: target, name: file.name, description: file.description, source: { type: "inline" } }
  }
  const absolute = path.isAbsolute(target) ? target : path.resolve(directory, target)
  const bytes = await fs.readFile(absolute)
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw invalidInput(`Attachment is larger than 10 MB: ${absolute} (${bytes.byteLength} bytes)`)
  }
  const mime = guessMime(absolute)
  return {
    uri: `data:${mime};base64,${bytes.toString("base64")}`,
    name: file.name ?? path.basename(absolute),
    description: file.description,
    source: { type: "inline" },
  }
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".ts": "text/typescript",
  ".js": "text/javascript",
  ".tsx": "text/tsx",
  ".jsx": "text/jsx",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".zip": "application/zip",
}

export function guessMime(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream"
}

function previewUri(uri: string): string {
  return uri.startsWith("data:") ? `${uri.slice(0, 40)}… (${uri.length} chars)` : uri
}
