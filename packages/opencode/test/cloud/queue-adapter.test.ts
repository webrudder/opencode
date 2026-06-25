import { describe, expect, test } from "bun:test"
import { CloudQueueAdapter } from "../../src/cloud/queue-adapter"

describe("CloudQueueAdapter", () => {
  test("builds provider-neutral enqueue and lease operations", () => {
    expect(
      CloudQueueAdapter.lifecycle({
        tenantID: "tenant_abc",
        jobID: "job_abc",
        workerID: "worker_abc",
        leaseTTLMS: 60_000,
        now: 1000,
        profile: "large",
      }),
    ).toEqual({
      enqueue: {
        action: "enqueue",
        queue: "cloud-runtime:large:tenant_abc",
        jobID: "job_abc",
        tenantID: "tenant_abc",
        runAt: 1000,
        priority: 0,
      },
      lease: {
        action: "lease",
        queue: "cloud-runtime:large:tenant_abc",
        jobID: "job_abc",
        tenantID: "tenant_abc",
        workerID: "worker_abc",
        leaseTTLMS: 60_000,
      },
      heartbeat: {
        action: "heartbeat",
        jobID: "job_abc",
        workerID: "worker_abc",
        leaseTTLMS: 60_000,
        time: 1000,
      },
      cancel: {
        action: "cancel",
        jobID: "job_abc",
        tenantID: "tenant_abc",
        requestedBy: "api",
        time: 1000,
      },
    })
  })

  test("plans delayed retry and terminal acknowledgement", () => {
    expect(
      CloudQueueAdapter.retry({
        tenantID: "tenant_abc",
        jobID: "job_abc",
        profile: "standard",
        runAt: 2000,
        attempt: 2,
        reason: "provider timeout",
      }),
    ).toEqual({
      action: "retry",
      queue: "cloud-runtime:standard:tenant_abc",
      jobID: "job_abc",
      tenantID: "tenant_abc",
      runAt: 2000,
      attempt: 2,
      reason: "provider timeout",
    })

    expect(
      CloudQueueAdapter.ack({
        jobID: "job_abc",
        workerID: "worker_abc",
        terminalStatus: "succeeded",
        time: 3000,
      }),
    ).toEqual({
      action: "ack",
      jobID: "job_abc",
      workerID: "worker_abc",
      terminalStatus: "succeeded",
      time: 3000,
    })
  })
})
