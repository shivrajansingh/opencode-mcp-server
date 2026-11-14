import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { register, openClient, workspaceFor, assertWritable, type ServerContext } from "./shared.js"
import { executePrompt } from "./prompt.js"

const modelRef = z.object({
  providerID: z.string(),
  id: z.string(),
  variant: z.string().optional(),
})

export interface TaskInput {
  directory?: string
  prompt: string
  agent?: string
  title?: string
  model?: { providerID: string; id: string; variant?: string }
  parentSessionID?: string
  wait?: boolean
  timeoutMs?: number
}

/** Create a session (optionally a child), run one prompt, return the transcript. */
export async function runTask(ctx: ServerContext, input: TaskInput) {
  assertWritable(ctx, "delegating tasks")
  const workspace = await workspaceFor(ctx, input.directory)
  const { client } = await openClient(ctx)

  const session = await client.session.create({
    location: { directory: workspace.directory },
    title: input.title ?? `Task: ${input.prompt.slice(0, 60)}`,
    agent: input.agent ?? "general",
    model: input.model,
    parentID: input.parentSessionID,
  })

  const result = await executePrompt(ctx, {
    sessionID: session.id,
    text: input.prompt,
    wait: input.wait,
    timeoutMs: input.timeoutMs ?? 45_000,
  })

  return {
    ...result,
    sessionID: session.id,
    parentSessionID: session.parentID ?? null,
    directory: workspace.directory,
    agent: session.agent,
    model: session.model,
  }
}

export function registerTaskTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_task",
    {
      title: "Delegate a task to OpenCode",
      description:
        "One-shot delegation: create a session in a workspace, send a prompt, wait for the result, and return " +
        "the answer plus the subagent transcript. Use this for 'have OpenCode do X in this repo' requests; " +
        "use opencode_session_* when you need a persistent conversation.",
      inputSchema: {
        directory: z.string().optional().describe("Absolute workspace; defaults to the client's directory"),
        prompt: z.string().describe("What the agent should do"),
        agent: z.string().optional().describe("Agent id (default general; try explore for read-only research)"),
        title: z.string().optional(),
        model: modelRef.optional(),
        parentSessionID: z.string().optional().describe("Attach the task as a subagent of this session"),
        wait: z.boolean().optional().describe("Default true"),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).optional().describe("Default 45000"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => runTask(ctx, args as TaskInput),
  )
}
