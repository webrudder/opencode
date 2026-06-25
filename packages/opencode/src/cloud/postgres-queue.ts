import type { QueryClient, QueryResult } from "./postgres-runner"
import type { Client } from "./queue-runner"

function rows(input: QueryResult): Record<string, unknown>[] {
  if (Array.isArray(input)) return input
  return input.rows ?? []
}

function changed(input: QueryResult) {
  if (Array.isArray(input)) return input.length > 0
  return (input.rowCount ?? input.rows?.length ?? 0) > 0
}

async function reason(input: {
  client: QueryClient
  queue: string
  tenantID: string
  jobID: string
}) {
  return (
    rows(
      await input.client.query("select status from cloud_queue_message where queue = $1 and tenant_id = $2 and job_id = $3", [
        input.queue,
        input.tenantID,
        input.jobID,
      ]),
    )[0]?.status ?? "missing"
  )
}

export function client(input: { client: QueryClient; now: () => number }): Client {
  return {
    async enqueue(request) {
      await input.client.query(
        `insert into cloud_queue_message (
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
        [request.queue, request.tenantID, request.jobID, request.runAt, request.priority, 1, input.now(), input.now()],
      )
      return { messageID: `${request.queue}:${request.tenantID}:${request.jobID}` }
    },
    async lease(request) {
      const leaseExpiresAt = input.now() + request.leaseTTLMS
      const result = rows(
        await input.client.query(
          `update cloud_queue_message set
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
      returning job_id, lease_expires_at`,
          [request.queue, request.tenantID, request.jobID, request.workerID, leaseExpiresAt, input.now()],
        ),
      )[0]
      if (!result) {
        return {
          leased: false as const,
          reason: String(await reason({ client: input.client, queue: request.queue, tenantID: request.tenantID, jobID: request.jobID })),
        }
      }
      return {
        leased: true as const,
        leaseToken: `${request.workerID}:${result.job_id}:${result.lease_expires_at}`,
      }
    },
    async heartbeat(request) {
      const result = await input.client.query(
        `update cloud_queue_message set
        lease_expires_at = $3,
        time_updated = $4
      where job_id = $1 and worker_id = $2 and status = 'leased'
      returning job_id`,
        [request.jobID, request.workerID, request.time + request.leaseTTLMS, request.time],
      )
      return { extended: changed(result) }
    },
    async ack(request) {
      const result = await input.client.query(
        `update cloud_queue_message set
        status = 'acked',
        terminal_status = $3,
        time_updated = $4
      where job_id = $1 and worker_id = $2 and status = 'leased'
      returning job_id`,
        [request.jobID, request.workerID, request.terminalStatus, request.time],
      )
      return { acknowledged: changed(result) }
    },
    async retry(request) {
      await input.client.query(
        `insert into cloud_queue_message (
        queue, tenant_id, job_id, run_at, priority, attempt, status, reason, time_created, time_updated
      ) values ($1, $2, $3, $4, 0, $5, 'queued', $6, $7, $8)
      on conflict(queue, tenant_id, job_id) do update set
        run_at = excluded.run_at,
        attempt = excluded.attempt,
        status = 'queued',
        worker_id = null,
        lease_expires_at = null,
        reason = excluded.reason,
        terminal_status = null,
        time_updated = excluded.time_updated`,
        [request.queue, request.tenantID, request.jobID, request.runAt, request.attempt, request.reason, input.now(), input.now()],
      )
      return { messageID: `${request.queue}:${request.tenantID}:${request.jobID}:${request.attempt}` }
    },
    async cancel(request) {
      const result = await input.client.query(
        `update cloud_queue_message set
        status = 'canceled',
        time_updated = $3
      where tenant_id = $1 and job_id = $2 and status <> 'acked'
      returning job_id`,
        [request.tenantID, request.jobID, request.time],
      )
      return { canceled: changed(result) }
    },
  }
}

export * as CloudPostgresQueue from "./postgres-queue"
