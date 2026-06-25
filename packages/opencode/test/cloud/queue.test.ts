import { describe, expect, test } from "bun:test"
import { CloudQueue } from "../../src/cloud/queue"

const cost = {
  estimatedUSD: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
}
const runtime = { engine: "opencode" as const, version: "1.14.28", profile: "standard" as const }
const job = (input: { id: string; tenantID?: string; status?: "queued" | "running" | "failed"; created: number }) => ({
  id: input.id,
  tenantID: input.tenantID ?? "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  status: input.status ?? "queued",
  runtime,
  cost,
  time: { created: input.created, updated: input.created },
})

describe("CloudQueue", () => {
  test("selects the oldest queued job inside a tenant", () => {
    expect(
      CloudQueue.next({
        tenantID: "tenant_abc",
        jobs: [
          job({ id: "job_new", created: 30 }),
          job({ id: "job_running", status: "running", created: 5 }),
          job({ id: "job_other", tenantID: "tenant_xyz", created: 1 }),
          job({ id: "job_old", created: 10 }),
        ],
      })?.id,
    ).toBe("job_old")
  })

  test("reports queue depth and oldest queued age", () => {
    expect(
      CloudQueue.stats({
        tenantID: "tenant_abc",
        jobs: [job({ id: "job_old", created: 10 }), job({ id: "job_new", created: 30 }), job({ id: "job_done", status: "running", created: 1 })],
        now: 50,
      }),
    ).toEqual({
      depth: 2,
      oldestQueuedAgeMS: 40,
    })
  })

  test("plans retry attempts with bounded backoff", () => {
    expect(
      CloudQueue.retry({
        job: job({ id: "job_failed", status: "failed", created: 10 }),
        attempts: 1,
        maxAttempts: 3,
        now: 100,
        baseDelayMS: 1000,
        maxDelayMS: 10_000,
      }),
    ).toEqual({
      allowed: true,
      nextStatus: "queued",
      nextAttempt: 2,
      retryAt: 1100,
    })

    expect(
      CloudQueue.retry({
        job: job({ id: "job_failed", status: "failed", created: 10 }),
        attempts: 3,
        maxAttempts: 3,
        now: 100,
        baseDelayMS: 1000,
        maxDelayMS: 10_000,
      }),
    ).toEqual({
      allowed: false,
      nextStatus: "failed",
      nextAttempt: 3,
      retryAt: undefined,
    })
  })
})
