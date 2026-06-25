import { describe, expect, test } from "bun:test"
import { CloudLease } from "../../src/cloud/lease"

const baseJob = {
  id: "job_123",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  status: "queued" as const,
  runtime: { engine: "opencode" as const, version: "1.14.28", profile: "standard" as const },
  cost: { estimatedUSD: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
  time: { created: 1, updated: 1 },
}

describe("CloudLease", () => {
  test("leases a queued job to a worker", () => {
    expect(
      CloudLease.leaseJob({
        job: baseJob,
        workerID: "worker_1",
        now: 100,
        ttlMS: 1000,
      }),
    ).toMatchObject({
      job: { status: "leasing" },
      lease: {
        jobID: "job_123",
        workerID: "worker_1",
        expiresAt: 1100,
      },
    })
  })

  test("rejects a second worker while the lease is active", () => {
    expect(() =>
      CloudLease.leaseJob({
        job: { ...baseJob, status: "leasing" },
        lease: { jobID: "job_123", workerID: "worker_1", expiresAt: 1100, heartbeatAt: 100 },
        workerID: "worker_2",
        now: 500,
        ttlMS: 1000,
      }),
    ).toThrow("Cloud job lease is still active")
  })

  test("allows a new worker to take over after lease expiry", () => {
    expect(
      CloudLease.leaseJob({
        job: { ...baseJob, status: "leasing" },
        lease: { jobID: "job_123", workerID: "worker_1", expiresAt: 1100, heartbeatAt: 100 },
        workerID: "worker_2",
        now: 1200,
        ttlMS: 1000,
      }).lease,
    ).toMatchObject({
      workerID: "worker_2",
      expiresAt: 2200,
    })
  })

  test("heartbeats only for the lease owner", () => {
    expect(
      CloudLease.heartbeat({
        lease: { jobID: "job_123", workerID: "worker_1", expiresAt: 1100, heartbeatAt: 100 },
        workerID: "worker_1",
        now: 600,
        ttlMS: 1000,
      }),
    ).toEqual({ jobID: "job_123", workerID: "worker_1", expiresAt: 1600, heartbeatAt: 600 })

    expect(() =>
      CloudLease.heartbeat({
        lease: { jobID: "job_123", workerID: "worker_1", expiresAt: 1100, heartbeatAt: 100 },
        workerID: "worker_2",
        now: 600,
        ttlMS: 1000,
      }),
    ).toThrow("Cloud job lease owner mismatch")
  })

  test("does not lease terminal jobs", () => {
    expect(() =>
      CloudLease.leaseJob({
        job: { ...baseJob, status: "succeeded" },
        workerID: "worker_1",
        now: 100,
        ttlMS: 1000,
      }),
    ).toThrow("Cannot lease terminal cloud job")
  })
})
