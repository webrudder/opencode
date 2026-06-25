import type { Job } from "./schema"
import type { JobStatus } from "./runtime"
import { CloudWebhook } from "./webhook"

function queued(input: { jobs: Job[]; tenantID: string }) {
  return input.jobs
    .filter((job) => job.tenantID === input.tenantID && job.status === "queued")
    .toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
}

export function next(input: { jobs: Job[]; tenantID: string }) {
  return queued(input)[0]
}

export function stats(input: { jobs: Job[]; tenantID: string; now: number }) {
  const jobs = queued(input)
  return {
    depth: jobs.length,
    oldestQueuedAgeMS: jobs[0] ? input.now - jobs[0].time.created : 0,
  }
}

export function retry(input: {
  job: Job
  attempts: number
  maxAttempts: number
  now: number
  baseDelayMS: number
  maxDelayMS: number
}) {
  const allowed = ["failed", "expired"].includes(input.job.status) && input.attempts < input.maxAttempts
  return {
    allowed,
    nextStatus: (allowed ? "queued" : input.job.status) as JobStatus,
    nextAttempt: allowed ? input.attempts + 1 : input.attempts,
    retryAt: allowed
      ? input.now +
        CloudWebhook.retryDelayMS({
          attempt: input.attempts,
          baseDelayMS: input.baseDelayMS,
          maxDelayMS: input.maxDelayMS,
        })
      : undefined,
  }
}

export * as CloudQueue from "./queue"
