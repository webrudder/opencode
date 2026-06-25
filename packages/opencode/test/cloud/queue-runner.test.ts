import { describe, expect, test } from "bun:test"
import { CloudQueueAdapter } from "../../src/cloud/queue-adapter"
import { CloudQueueRunner } from "../../src/cloud/queue-runner"

describe("CloudQueueRunner", () => {
  test("executes enqueue, lease, heartbeat, ack, retry, and cancel through an injected queue client", async () => {
    const calls: unknown[] = []

    expect(
      await CloudQueueRunner.run({
        client: {
          enqueue: async (input) => {
            calls.push(input)
            return { messageID: `${input.queue}:${input.jobID}` }
          },
          lease: async (input) => {
            calls.push(input)
            return { leased: true, leaseToken: `${input.workerID}:${input.jobID}` }
          },
          heartbeat: async (input) => {
            calls.push(input)
            return { extended: true }
          },
          ack: async (input) => {
            calls.push(input)
            return { acknowledged: true }
          },
          retry: async (input) => {
            calls.push(input)
            return { messageID: `${input.queue}:${input.jobID}:${input.attempt}` }
          },
          cancel: async (input) => {
            calls.push(input)
            return { canceled: true }
          },
        },
        operations: [
          CloudQueueAdapter.enqueue({ tenantID: "tenant_abc", jobID: "job_abc", now: 100, profile: "standard" }),
          CloudQueueAdapter.lease({
            tenantID: "tenant_abc",
            jobID: "job_abc",
            workerID: "worker_abc",
            leaseTTLMS: 1000,
          }),
          CloudQueueAdapter.heartbeat({ jobID: "job_abc", workerID: "worker_abc", leaseTTLMS: 1000, time: 200 }),
          CloudQueueAdapter.ack({
            jobID: "job_abc",
            workerID: "worker_abc",
            terminalStatus: "succeeded",
            time: 300,
          }),
          CloudQueueAdapter.retry({
            tenantID: "tenant_abc",
            jobID: "job_retry",
            runAt: 500,
            attempt: 2,
            reason: "provider timeout",
          }),
          CloudQueueAdapter.cancel({ tenantID: "tenant_abc", jobID: "job_cancel", requestedBy: "api", time: 600 }),
        ],
      }),
    ).toEqual({
      enqueued: 1,
      leases: [{ jobID: "job_abc", leased: true, leaseToken: "worker_abc:job_abc" }],
      heartbeats: 1,
      acknowledgements: 1,
      retries: 1,
      cancellations: 1,
    })

    expect(calls).toEqual([
      {
        queue: "cloud-runtime:standard:tenant_abc",
        tenantID: "tenant_abc",
        jobID: "job_abc",
        runAt: 100,
        priority: 0,
      },
      {
        queue: "cloud-runtime:standard:tenant_abc",
        tenantID: "tenant_abc",
        jobID: "job_abc",
        workerID: "worker_abc",
        leaseTTLMS: 1000,
      },
      {
        jobID: "job_abc",
        workerID: "worker_abc",
        leaseTTLMS: 1000,
        time: 200,
      },
      {
        jobID: "job_abc",
        workerID: "worker_abc",
        terminalStatus: "succeeded",
        time: 300,
      },
      {
        queue: "cloud-runtime:standard:tenant_abc",
        tenantID: "tenant_abc",
        jobID: "job_retry",
        runAt: 500,
        attempt: 2,
        reason: "provider timeout",
      },
      {
        tenantID: "tenant_abc",
        jobID: "job_cancel",
        requestedBy: "api",
        time: 600,
      },
    ])
  })

  test("returns an unleasing result when a provider does not acquire a job", async () => {
    expect(
      await CloudQueueRunner.run({
        client: {
          lease: async () => ({ leased: false, reason: "not visible" }),
        },
        operations: [
          CloudQueueAdapter.lease({
            tenantID: "tenant_abc",
            jobID: "job_abc",
            workerID: "worker_abc",
            leaseTTLMS: 1000,
          }),
        ],
      }),
    ).toEqual({
      enqueued: 0,
      leases: [{ jobID: "job_abc", leased: false, reason: "not visible" }],
      heartbeats: 0,
      acknowledgements: 0,
      retries: 0,
      cancellations: 0,
    })
  })

  test("fails fast when a required queue client method is missing", async () => {
    await expect(
      CloudQueueRunner.run({
        client: {},
        operations: [CloudQueueAdapter.enqueue({ tenantID: "tenant_abc", jobID: "job_abc", now: 100 })],
      }),
    ).rejects.toThrow("Cloud queue client enqueue is not configured")
  })
})
