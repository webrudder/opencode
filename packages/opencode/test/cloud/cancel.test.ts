import { describe, expect, test } from "bun:test"
import { CloudAttempt } from "../../src/cloud/attempt"
import { CloudCancel } from "../../src/cloud/cancel"

const job = {
  id: "job_abc",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  status: "running" as const,
  runtime: {
    engine: "opencode" as const,
    version: "1.14.28",
    image: "registry.example.com/cloud-runtime-opencode:1.14.28",
    profile: "standard" as const,
  },
  cost: {
    estimatedUSD: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  },
  time: { created: 10, updated: 10 },
}

describe("CloudCancel", () => {
  test("plans sandbox deletion and attempt cancellation", () => {
    const attempt = CloudAttempt.start({
      job,
      workerID: "worker_abc",
      attempt: 1,
      reason: "initial",
      now: 20,
    })

    expect(
      CloudCancel.plan({
        tenantID: "tenant_abc",
        jobID: "job_abc",
        namespace: "cloud-runtime",
        lease: { jobID: "job_abc", workerID: "worker_abc", expiresAt: 1000, heartbeatAt: 100 },
        workerID: "worker_abc",
        attempt,
        now: 200,
      }),
    ).toEqual({
      jobID: "job_abc",
      tenantID: "tenant_abc",
      workerID: "worker_abc",
      kubernetes: {
        deletePod: {
          apiVersion: "v1",
          kind: "Pod",
          namespace: "cloud-runtime",
          name: "opencode-job-abc",
          propagationPolicy: "Background",
        },
      },
      attempt: {
        ...attempt,
        status: "canceled",
        error: "canceled",
        time: { created: 20, updated: 200 },
      },
    })
  })

  test("allows control-plane cancellation without an active lease", () => {
    expect(
      CloudCancel.plan({
        tenantID: "tenant_abc",
        jobID: "Job With Spaces",
        namespace: "cloud-runtime",
        now: 200,
      }).kubernetes.deletePod.name,
    ).toBe("opencode-job-with-spaces")
  })

  test("rejects cancellation from a worker that does not own the lease", () => {
    expect(() =>
      CloudCancel.plan({
        tenantID: "tenant_abc",
        jobID: "job_abc",
        namespace: "cloud-runtime",
        lease: { jobID: "job_abc", workerID: "worker_1", expiresAt: 1000, heartbeatAt: 100 },
        workerID: "worker_2",
        now: 200,
      }),
    ).toThrow("Cloud cancel lease owner mismatch")
  })
})
