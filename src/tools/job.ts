import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { invalidInput } from "../errors.js"
import { cancelJob, getJob, jobToJson, listJobs } from "../jobs.js"
import { openClient, register, type ServerContext } from "./shared.js"

export function registerJobTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_job",
    {
      title: "Background job status",
      description:
        "Track tasks started with background=true. Returns only the final summary once the job is done — " +
        "intermediate tool calls and thinking never leave OpenCode.",
      inputSchema: {
        action: z.enum(["status", "list", "cancel"]).optional().describe("Default: status"),
        jobID: z.string().optional().describe("Required for status and cancel"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const action = args.action ?? "status"

      if (action === "list") {
        return { jobs: listJobs(args.limit ?? 20).map(jobToJson) }
      }

      if (!args.jobID) throw invalidInput(`action=${action} requires jobID`)
      const job = getJob(args.jobID)
      if (!job) throw invalidInput(`Unknown jobID ${args.jobID}`)

      if (action === "cancel") {
        if (job.status === "working") {
          const { client } = await openClient(ctx)
          await client.session.interrupt({ sessionID: job.sessionID }).catch(() => undefined)
          cancelJob(job.id)
        }
        return jobToJson(getJob(job.id)!)
      }

      return jobToJson(job)
    },
  )
}
