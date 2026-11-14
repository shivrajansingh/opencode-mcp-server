import { randomUUID } from "node:crypto"

export type JobStatus = "working" | "done" | "error" | "cancelled"

export interface JobRecord {
  id: string
  sessionID: string
  directory: string
  agent?: string
  title?: string
  status: JobStatus
  summary?: string
  error?: string
  startedAt: number
  finishedAt?: number
}

const jobs = new Map<string, JobRecord>()
const MAX_JOBS = 100

export function createJob(init: Omit<JobRecord, "id" | "status" | "startedAt">): JobRecord {
  prune()
  const job: JobRecord = {
    ...init,
    id: `job_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    status: "working",
    startedAt: Date.now(),
  }
  jobs.set(job.id, job)
  return job
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id)
}

export function listJobs(limit = 20): JobRecord[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}

export function finishJob(
  id: string,
  patch: { status: Exclude<JobStatus, "working">; summary?: string; error?: string },
): JobRecord | undefined {
  const job = jobs.get(id)
  if (!job) return undefined
  job.status = patch.status
  job.summary = patch.summary
  job.error = patch.error
  job.finishedAt = Date.now()
  return job
}

export function cancelJob(id: string, reason = "cancelled by client"): JobRecord | undefined {
  return finishJob(id, { status: "cancelled", error: reason })
}

/** Keep the registry small: drop the oldest finished jobs beyond the cap. */
function prune(): void {
  if (jobs.size < MAX_JOBS) return
  const finished = [...jobs.values()]
    .filter((job) => job.status !== "working")
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
  while (jobs.size >= MAX_JOBS && finished.length > 0) {
    const oldest = finished.shift()!
    jobs.delete(oldest.id)
  }
}

export function jobToJson(job: JobRecord) {
  const durationMs = (job.finishedAt ?? Date.now()) - job.startedAt
  return {
    jobID: job.id,
    sessionID: job.sessionID,
    status: job.status,
    agent: job.agent ?? null,
    elapsedMs: durationMs,
    summary: job.status === "done" ? job.summary ?? "" : undefined,
    error: job.status === "error" || job.status === "cancelled" ? job.error ?? job.status : undefined,
    hint:
      job.status === "working"
        ? "OpenCode is still working. Call opencode_job again with this jobID to collect the summary."
        : undefined,
  }
}
