import { describe, expect, test } from "bun:test"
import { CloudPostgresQueue } from "../../src/cloud/postgres-queue"
import { CloudQueueAdapter } from "../../src/cloud/queue-adapter"
import { CloudQueueRunner } from "../../src/cloud/queue-runner"

function setup(responses: Record<string, Record<string, unknown>[]>) {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    client: CloudPostgresQueue.client({
      now: () => 100,
      client: {
        query: async (sql, params) => {
          calls.push({ sql, params: params ?? [] })
          return { rows: responses[sql] ?? [], rowCount: responses[sql]?.length ?? 0 }
        },
      },
    }),
  }
}

describe("CloudPostgresQueue", () => {
  test("enqueues jobs through durable PostgreSQL queue rows", async () => {
    const subject = setup({})

    expect(
      await CloudQueueRunner.run({
        client: subject.client,
        operations: [
          CloudQueueAdapter.enqueue({
            tenantID: "tenant_abc",
            jobID: "job_abc",
            now: 100,
            priority: 3,
          }),
        ],
      }),
    ).toMatchObject({ enqueued: 1 })
    expect(subject.calls).toEqual([
      {
        sql: `insert into cloud_queue_message (
        queue, tenant_id, job_id, run_at, priority, attempt, status, time_created, time_updated
      ) values ($1, $2, $3, $4, $5, $6, 'queued', $7, $8)
      on conflict(queue, tenant_id, job_id) do update set
        run_at = excluded.run_at,
        priority = excluded.priority,
        attempt = excluded.attempt,
        status = 'queued',
        worker_id = null,
        lease_expires_at = null,
        reason = null,
        terminal_status = null,
        time_updated = excluded.time_updated`,
        params: ["cloud-runtime:standard:tenant_abc", "tenant_abc", "job_abc", 100, 3, 1, 100, 100],
      },
    ])
  })

  test("leases visible jobs and reports provider misses", async () => {
    const leaseSQL = `update cloud_queue_message set
        status = 'leased',
        worker_id = $4,
        lease_expires_at = $5,
        time_updated = $6
      where queue = $1
        and tenant_id = $2
        and job_id = $3
        and (
          (status = 'queued' and run_at <= $6)
          or (status = 'leased' and lease_expires_at <= $6)
        )
      returning job_id, lease_expires_at`
    const subject = setup({
      [leaseSQL]: [{ job_id: "job_abc", lease_expires_at: 1100 }],
    })

    expect(
      await CloudQueueRunner.run({
        client: subject.client,
        operations: [
          CloudQueueAdapter.lease({
            tenantID: "tenant_abc",
            jobID: "job_abc",
            workerID: "worker_abc",
            leaseTTLMS: 1000,
          }),
        ],
      }),
    ).toMatchObject({
      leases: [{ jobID: "job_abc", leased: true, leaseToken: "worker_abc:job_abc:1100" }],
    })

    const miss = setup({
      "select status from cloud_queue_message where queue = $1 and tenant_id = $2 and job_id = $3": [
        { status: "leased" },
      ],
    })
    expect(
      await miss.client.lease?.({
        queue: "cloud-runtime:standard:tenant_abc",
        tenantID: "tenant_abc",
        jobID: "job_abc",
        workerID: "worker_other",
        leaseTTLMS: 1000,
      }),
    ).toEqual({ leased: false, reason: "leased" })
  })

  test("heartbeats, acknowledges, retries, and cancels durable queue rows", async () => {
    const subject = setup({})

    await CloudQueueRunner.run({
      client: subject.client,
      operations: [
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
    })

    expect(subject.calls.map((call) => call.params)).toEqual([
      ["job_abc", "worker_abc", 1200, 200],
      ["job_abc", "worker_abc", "succeeded", 300],
      ["cloud-runtime:standard:tenant_abc", "tenant_abc", "job_retry", 500, 2, "provider timeout", 100, 100],
      ["tenant_abc", "job_cancel", 600],
    ])
  })

  test("treats Bun SQL array update results as successful when returning rows exist", async () => {
    const subject = CloudPostgresQueue.client({
      now: () => 100,
      client: {
        query: async () => [{ job_id: "job_abc" }],
      },
    })

    expect(await subject.heartbeat?.({ jobID: "job_abc", workerID: "worker_abc", leaseTTLMS: 1000, time: 200 })).toEqual({
      extended: true,
    })
    expect(await subject.ack?.({ jobID: "job_abc", workerID: "worker_abc", terminalStatus: "succeeded", time: 300 })).toEqual({
      acknowledged: true,
    })
    expect(await subject.cancel?.({ tenantID: "tenant_abc", jobID: "job_abc", requestedBy: "api", time: 400 })).toEqual({
      canceled: true,
    })
  })
})
