import { describe, expect, test } from "bun:test"
import { CloudMemoryQueue } from "../../src/cloud/memory-queue"
import { CloudQueueAdapter } from "../../src/cloud/queue-adapter"
import { CloudQueueRunner } from "../../src/cloud/queue-runner"

describe("CloudMemoryQueue", () => {
  test("leases the highest priority visible job once until acked", async () => {
    const queue = CloudMemoryQueue.create({ now: () => 100 })
    const client = CloudMemoryQueue.client(queue)

    await CloudQueueRunner.run({
      client,
      operations: [
        CloudQueueAdapter.enqueue({ tenantID: "tenant_abc", jobID: "job_low", now: 100, priority: 0 }),
        CloudQueueAdapter.enqueue({ tenantID: "tenant_abc", jobID: "job_high", now: 100, priority: 10 }),
      ],
    })

    expect(
      await CloudQueueRunner.run({
        client,
        operations: [
          CloudQueueAdapter.lease({
            tenantID: "tenant_abc",
            jobID: "job_high",
            workerID: "worker_abc",
            leaseTTLMS: 1000,
          }),
        ],
      }),
    ).toMatchObject({
      leases: [{ jobID: "job_high", leased: true, leaseToken: "worker_abc:job_high:1100" }],
    })
    expect(
      await client.lease?.({
        queue: "cloud-runtime:standard:tenant_abc",
        tenantID: "tenant_abc",
        jobID: "job_high",
        workerID: "worker_other",
        leaseTTLMS: 1000,
      }),
    ).toEqual({ leased: false, reason: "leased" })

    await CloudQueueRunner.run({
      client,
      operations: [
        CloudQueueAdapter.ack({
          jobID: "job_high",
          workerID: "worker_abc",
          terminalStatus: "succeeded",
          time: 200,
        }),
      ],
    })

    expect(CloudMemoryQueue.snapshot(queue).map((item) => [item.jobID, item.status])).toEqual([
      ["job_high", "acked"],
      ["job_low", "queued"],
    ])
  })

  test("makes an expired lease visible to another worker and supports heartbeat extension", async () => {
    let now = 100
    const queue = CloudMemoryQueue.create({ now: () => now })
    const client = CloudMemoryQueue.client(queue)

    await client.enqueue?.({
      queue: "cloud-runtime:standard:tenant_abc",
      tenantID: "tenant_abc",
      jobID: "job_abc",
      runAt: 100,
      priority: 0,
    })
    expect(
      await client.lease?.({
        queue: "cloud-runtime:standard:tenant_abc",
        tenantID: "tenant_abc",
        jobID: "job_abc",
        workerID: "worker_abc",
        leaseTTLMS: 100,
      }),
    ).toEqual({ leased: true, leaseToken: "worker_abc:job_abc:200" })

    now = 150
    expect(await client.heartbeat?.({ jobID: "job_abc", workerID: "worker_abc", leaseTTLMS: 500, time: now })).toEqual({
      extended: true,
    })

    now = 300
    expect(
      await client.lease?.({
        queue: "cloud-runtime:standard:tenant_abc",
        tenantID: "tenant_abc",
        jobID: "job_abc",
        workerID: "worker_other",
        leaseTTLMS: 100,
      }),
    ).toEqual({ leased: false, reason: "leased" })

    now = 700
    expect(
      await client.lease?.({
        queue: "cloud-runtime:standard:tenant_abc",
        tenantID: "tenant_abc",
        jobID: "job_abc",
        workerID: "worker_other",
        leaseTTLMS: 100,
      }),
    ).toEqual({ leased: true, leaseToken: "worker_other:job_abc:800" })
  })

  test("cancels and retries queued messages", async () => {
    const queue = CloudMemoryQueue.create({ now: () => 100 })
    const client = CloudMemoryQueue.client(queue)

    await client.enqueue?.({
      queue: "cloud-runtime:standard:tenant_abc",
      tenantID: "tenant_abc",
      jobID: "job_cancel",
      runAt: 100,
      priority: 0,
    })
    await client.cancel?.({ tenantID: "tenant_abc", jobID: "job_cancel", requestedBy: "api", time: 100 })
    await client.retry?.({
      queue: "cloud-runtime:standard:tenant_abc",
      tenantID: "tenant_abc",
      jobID: "job_retry",
      runAt: 500,
      attempt: 2,
      reason: "provider timeout",
    })

    expect(CloudMemoryQueue.snapshot(queue).map((item) => [item.jobID, item.status, item.runAt, item.attempt])).toEqual([
      ["job_cancel", "canceled", 100, 1],
      ["job_retry", "queued", 500, 2],
    ])
  })
})
