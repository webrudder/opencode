import type { Job } from "./schema"

type Attempt = {
  id: string
  tenantID: string
  workspaceID: string
  sessionID: string
  jobID: string
  workerID: string
  attempt: number
  reason: "initial" | "retry"
  runtime: Job["runtime"]
  status: "running" | "succeeded" | "failed" | "canceled"
  error?: string
  time: {
    created: number
    updated: number
  }
}

function id(input: { jobID: string; attempt: number }) {
  return `${input.jobID}:attempt:${input.attempt.toString().padStart(6, "0")}`
}

export function start(input: {
  job: Job
  workerID: string
  attempt: number
  reason: "initial" | "retry"
  now: number
}): Attempt {
  return {
    id: id({ jobID: input.job.id, attempt: input.attempt }),
    tenantID: input.job.tenantID,
    workspaceID: input.job.workspaceID,
    sessionID: input.job.sessionID,
    jobID: input.job.id,
    workerID: input.workerID,
    attempt: input.attempt,
    reason: input.reason,
    runtime: input.job.runtime,
    status: "running",
    time: {
      created: input.now,
      updated: input.now,
    },
  }
}

export function complete(input: { attempt: Attempt; now: number }): Attempt {
  return {
    ...input.attempt,
    status: "succeeded",
    time: {
      ...input.attempt.time,
      updated: input.now,
    },
  }
}

export function fail(input: { attempt: Attempt; now: number; error: string }): Attempt {
  return {
    ...input.attempt,
    status: "failed",
    error: input.error,
    time: {
      ...input.attempt.time,
      updated: input.now,
    },
  }
}

export function cancel(input: { attempt: Attempt; now: number; reason?: string }): Attempt {
  return {
    ...input.attempt,
    status: "canceled",
    error: input.reason ?? "canceled",
    time: {
      ...input.attempt.time,
      updated: input.now,
    },
  }
}

export function next(input: { job: Job; attempts: Attempt[]; maxAttempts: number }) {
  const attempt = input.attempts.length + 1
  if (!["failed", "expired"].includes(input.job.status)) {
    return {
      allowed: false,
      attempt,
      reason: "not_retryable" as const,
    }
  }
  if (input.attempts.length >= input.maxAttempts) {
    return {
      allowed: false,
      attempt,
      reason: "max_attempts" as const,
    }
  }
  return {
    allowed: true,
    attempt,
    reason: attempt === 1 ? ("initial" as const) : ("retry" as const),
  }
}

export * as CloudAttempt from "./attempt"
