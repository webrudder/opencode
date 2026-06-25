import { describe, expect, test } from "bun:test"
import { CloudAttempt } from "../../src/cloud/attempt"

const job = {
  id: "job_abc",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  status: "queued" as const,
  runtime: {
    engine: "opencode" as const,
    version: "1.14.28",
    image: "registry.example.com/cloud-runtime-opencode:1.14.28",
    imageDigest: "sha256:abc",
    profile: "standard" as const,
  },
  cost: {
    estimatedUSD: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  },
  time: { created: 10, updated: 10 },
}

describe("CloudAttempt", () => {
  test("creates the first worker attempt for a leased job", () => {
    expect(
      CloudAttempt.start({
        job,
        workerID: "worker_abc",
        attempt: 1,
        reason: "initial",
        now: 20,
      }),
    ).toEqual({
      id: "job_abc:attempt:000001",
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      jobID: "job_abc",
      workerID: "worker_abc",
      attempt: 1,
      reason: "initial",
      runtime: {
        engine: "opencode",
        version: "1.14.28",
        image: "registry.example.com/cloud-runtime-opencode:1.14.28",
        imageDigest: "sha256:abc",
        profile: "standard",
      },
      status: "running",
      time: { created: 20, updated: 20 },
    })
  })

  test("completes, fails, and cancels attempts without mutating the original record", () => {
    const attempt = CloudAttempt.start({
      job,
      workerID: "worker_abc",
      attempt: 2,
      reason: "retry",
      now: 20,
    })

    expect(CloudAttempt.complete({ attempt, now: 30 }).status).toBe("succeeded")
    expect(CloudAttempt.fail({ attempt, now: 40, error: "sandbox exited" })).toMatchObject({
      status: "failed",
      error: "sandbox exited",
      time: { created: 20, updated: 40 },
    })
    expect(CloudAttempt.cancel({ attempt, now: 50, reason: "user requested cancellation" })).toMatchObject({
      status: "canceled",
      error: "user requested cancellation",
      time: { created: 20, updated: 50 },
    })
    expect(attempt.status).toBe("running")
  })

  test("plans the next attempt from previous attempt history", () => {
    expect(
      CloudAttempt.next({
        job: { ...job, status: "failed" },
        attempts: [
          CloudAttempt.fail({
            attempt: CloudAttempt.start({
              job,
              workerID: "worker_abc",
              attempt: 1,
              reason: "initial",
              now: 20,
            }),
            now: 30,
            error: "provider timeout",
          }),
        ],
        maxAttempts: 3,
      }),
    ).toEqual({
      allowed: true,
      attempt: 2,
      reason: "retry",
    })
  })

  test("rejects retries for terminal non-retryable jobs and exhausted attempts", () => {
    expect(
      CloudAttempt.next({
        job: { ...job, status: "canceled" },
        attempts: [],
        maxAttempts: 3,
      }),
    ).toEqual({
      allowed: false,
      attempt: 1,
      reason: "not_retryable",
    })

    expect(
      CloudAttempt.next({
        job: { ...job, status: "failed" },
        attempts: [
          CloudAttempt.start({ job, workerID: "worker_abc", attempt: 1, reason: "initial", now: 20 }),
          CloudAttempt.start({ job, workerID: "worker_abc", attempt: 2, reason: "retry", now: 30 }),
        ],
        maxAttempts: 2,
      }),
    ).toEqual({
      allowed: false,
      attempt: 3,
      reason: "max_attempts",
    })
  })
})
