import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { register, openClient, workspaceFor, assertWritable, type ServerContext } from "./shared.js"
import { executePrompt, waitForSummary } from "./prompt.js"
import { createJob, finishJob } from "../jobs.js"

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
  verbosity?: "summary" | "full"
  background?: boolean
}

/** Create a session (optionally a child), run one prompt, return the summary. */
export async function runTask(ctx: ServerContext, input: TaskInput, extra?: unknown) {
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

  if (input.background) {
    const job = createJob({
      sessionID: session.id,
      directory: workspace.directory,
      agent: session.agent ?? input.agent,
      title: session.title,
    })
    void runInBackground(ctx, job.id, session.id, input)
    return {
      jobID: job.id,
      sessionID: session.id,
      status: "working",
      agent: session.agent ?? input.agent ?? null,
      hint: "OpenCode is working. Call opencode_job { action: 'status', jobID } to collect the final summary.",
    }
  }

  const startedAt = Date.now()
  const result = await executePrompt(
    ctx,
    {
      sessionID: session.id,
      text: input.prompt,
      wait: input.wait,
      timeoutMs: input.timeoutMs ?? 45_000,
      verbosity: input.verbosity,
    },
    extra,
  )

  if (input.verbosity === "full") {
    return {
      ...result,
      sessionID: session.id,
      parentSessionID: session.parentID ?? null,
      directory: workspace.directory,
      agent: session.agent,
      model: session.model,
    }
  }

  // The caller's wait elapsed but OpenCode is still working: keep going in the background so the
  // summary is not lost, and hand back a jobID.
  if (result.status === "timeout" && input.wait !== false) {
    const job = createJob({
      sessionID: session.id,
      directory: workspace.directory,
      agent: session.agent ?? input.agent,
      title: session.title,
    })
    void continueInBackground(ctx, job.id, session.id, startedAt)
    return {
      sessionID: session.id,
      parentSessionID: session.parentID ?? null,
      status: "working",
      jobID: job.id,
      summary: "",
      durationMs: result.durationMs,
      agent: session.agent ?? input.agent ?? null,
      hint: "OpenCode is still working. Call opencode_job { action: 'status', jobID } to collect the summary.",
    }
  }

  return {
    sessionID: session.id,
    parentSessionID: session.parentID ?? null,
    status: result.status,
    summary: result.summary,
    durationMs: result.durationMs,
    agent: session.agent ?? input.agent ?? null,
    ...("hint" in result && result.hint ? { hint: result.hint } : {}),
  }
}

async function continueInBackground(
  ctx: ServerContext,
  jobID: string,
  sessionID: string,
  since: number,
): Promise<void> {
  try {
    const result = await waitForSummary(ctx, sessionID, since, 1_800_000)
    if (result.status === "idle") {
      finishJob(jobID, { status: "done", summary: result.summary })
    } else if (result.status === "error" && result.error) {
      finishJob(jobID, { status: "error", error: result.error.message })
    } else {
      finishJob(jobID, {
        status: "error",
        error: result.status === "empty" ? "no output from the provider" : "still running after 30 minutes",
      })
    }
  } catch (error) {
    finishJob(jobID, { status: "error", error: error instanceof Error ? error.message : String(error) })
  }
}

async function runInBackground(ctx: ServerContext, jobID: string, sessionID: string, input: TaskInput): Promise<void> {
  try {
    const result = await executePrompt(ctx, {
      sessionID,
      text: input.prompt,
      wait: true,
      timeoutMs: input.timeoutMs ?? 1_800_000,
      verbosity: "summary",
    })
    if (result.status === "idle") {
      finishJob(jobID, { status: "done", summary: result.summary })
    } else if (result.status === "error" && "error" in result && result.error) {
      finishJob(jobID, { status: "error", error: result.error.message })
    } else if (result.status === "timeout" || result.status === "running") {
      finishJob(jobID, {
        status: "error",
        error: "still running after the wait timeout; the session continues in OpenCode",
      })
    } else {
      finishJob(jobID, { status: "error", error: result.hint ?? result.status })
    }
  } catch (error) {
    finishJob(jobID, { status: "error", error: error instanceof Error ? error.message : String(error) })
  }
}

export function registerTaskTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_task",
    {
      title: "Delegate a task to OpenCode",
      description:
        "One-shot delegation: create a session, send a prompt, wait for the run, and return ONLY the final summary. " +
        "Tool calls, intermediate steps and reasoning stay inside OpenCode, so the caller's context stays clean. " +
        "Use background=true to get an immediate 'working' acknowledgement and collect the summary later with opencode_job. " +
        "Set verbosity='full' only when a transcript is explicitly needed.",
      inputSchema: {
        directory: z.string().optional().describe("Absolute workspace; defaults to the client's directory"),
        prompt: z.string().describe("What the agent should do"),
        agent: z.string().optional().describe("Agent id (default general; try explore for read-only research)"),
        title: z.string().optional(),
        model: modelRef.optional(),
        parentSessionID: z.string().optional().describe("Attach the task as a subagent of this session"),
        wait: z.boolean().optional().describe("Wait for the run (default true; ignored when background=true)"),
        timeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(3_600_000)
          .optional()
          .describe("Default 45000 inline, 1800000 in background"),
        verbosity: z.enum(["summary", "full"]).optional().describe("summary (default). 'full' is admin-only and usually disabled"),
        background: z.boolean().optional().describe("Return immediately with a jobID instead of waiting"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, extra) => runTask(ctx, args as TaskInput, extra),
  )
}
