import { CloudAPI, type JobEvent } from "./api"
import type { Lease } from "./lease"
import { CloudRuntimePool, type RuntimeWorker, type SessionBinding } from "./runtime-pool"
import { CloudRuntime, type JobSpec } from "./runtime"
import { CloudSchema, type Job, type Message } from "./schema"

type QueryClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows?: Record<string, unknown>[] } | Record<string, unknown>[]>
}

function rows(input: Awaited<ReturnType<QueryClient["query"]>>) {
  if (Array.isArray(input)) return input
  return input.rows ?? []
}

function parse(input: unknown) {
  if (typeof input !== "string") return input
  return JSON.parse(input)
}

function numberValue(input: unknown) {
  return Number(input)
}

function job(input: Record<string, unknown>): Job {
  return CloudSchema.decodeJob({
    id: input.id,
    tenantID: input.tenant_id,
    workspaceID: input.workspace_id,
    sessionID: input.session_id,
    status: input.status,
    executionMode: input.execution_mode ?? undefined,
    runtime: parse(input.runtime),
    modelConfigSnapshot: parse(input.model_config_snapshot) ?? undefined,
    cost: parse(input.cost),
    error: input.error ?? undefined,
    time: {
      created: numberValue(input.time_created),
      updated: numberValue(input.time_updated),
    },
  })
}

function message(input: Record<string, unknown>): Message {
  return CloudSchema.decodeMessage({
    id: input.id,
    tenantID: input.tenant_id,
    workspaceID: input.workspace_id,
    sessionID: input.session_id,
    jobID: input.job_id ?? undefined,
    role: input.role,
    content: input.content,
    time: {
      created: numberValue(input.time_created),
      updated: numberValue(input.time_updated),
    },
  })
}

function event(input: Record<string, unknown>): JobEvent {
  return CloudAPI.decodeJobEvent({
    id: input.id,
    jobID: input.job_id,
    type: input.type,
    data: parse(input.data),
    time: numberValue(input.time_created),
  })
}

function runtimeWorker(input: Record<string, unknown>): RuntimeWorker {
  return CloudRuntimePool.decodeRuntimeWorker({
    id: input.id,
    tenantID: input.tenant_id,
    executionMode: input.execution_mode,
    status: input.status,
    version: input.version,
    profile: input.profile,
    maxActiveJobs: Number(input.max_active_jobs),
    maxSessions: Number(input.max_sessions),
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    metrics: parse(input.metrics),
    time: {
      created: Number(input.time_created),
      updated: Number(input.time_updated),
    },
  })
}

function sessionRuntimeBinding(input: Record<string, unknown>): SessionBinding {
  return CloudRuntimePool.decodeSessionBinding({
    tenantID: input.tenant_id,
    sessionID: input.session_id,
    runtimeID: input.runtime_id,
    time: {
      created: Number(input.time_created),
      updated: Number(input.time_updated),
    },
  })
}

export async function listQueuedJobs(input: { client: QueryClient; tenantID: string }) {
  return rows(
    await input.client.query("select * from cloud_job where tenant_id = $1 and status = 'queued' order by time_created, id", [
      input.tenantID,
    ]),
  ).map(job)
}

export async function getJob(input: { client: QueryClient; tenantID: string; id: string }): Promise<Job | undefined> {
  return rows(await input.client.query("select * from cloud_job where tenant_id = $1 and id = $2", [input.tenantID, input.id]))
    .map(job)
    .at(0)
}

export async function getJobSpec(input: { client: QueryClient; tenantID: string; id: string }): Promise<JobSpec | undefined> {
  const row = rows(await input.client.query("select job_spec from cloud_job where tenant_id = $1 and id = $2", [input.tenantID, input.id])).at(0)
  if (!row?.job_spec) return undefined
  return CloudRuntime.decodeJobSpec(parse(row.job_spec))
}

export async function getJobPrompt(input: { client: QueryClient; tenantID: string; jobID: string }) {
  const row = rows(
    await input.client.query(
      "select * from cloud_message where tenant_id = $1 and job_id = $2 and role = 'user' order by time_created desc, id desc limit 1",
      [input.tenantID, input.jobID],
    ),
  ).at(0)
  if (!row) return undefined
  const result = message(row)
  return {
    id: result.jobID ?? result.id,
    tenantID: result.tenantID,
    jobID: input.jobID,
    prompt: result.content,
  }
}

export async function listEvents(input: { client: QueryClient; jobID: string; cursor?: string; limit?: number }) {
  return rows(
    await input.client.query("select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3", [
      input.jobID,
      input.cursor ?? "",
      input.limit ?? 100,
    ]),
  ).map(event)
}

export async function getLease(input: { client: QueryClient; jobID: string }): Promise<Lease | undefined> {
  const row = rows(await input.client.query("select * from cloud_job_lease where job_id = $1", [input.jobID])).at(0)
  if (!row) return undefined
  return {
    jobID: `${row.job_id}`,
    workerID: `${row.worker_id}`,
    expiresAt: Number(row.expires_at),
    heartbeatAt: Number(row.heartbeat_at),
  }
}

export async function hasRunningSessionAttempt(input: { client: QueryClient; tenantID: string; sessionID: string }) {
  return Boolean(
    rows(
      await input.client.query(
        "select id from cloud_job_attempt where tenant_id = $1 and session_id = $2 and status = 'running' order by time_created desc, id desc limit 1",
        [input.tenantID, input.sessionID],
      ),
    ).at(0),
  )
}

export async function listRuntimeWorkers(input: { client: QueryClient; tenantID: string }) {
  return rows(await input.client.query("select * from cloud_runtime_worker where tenant_id = $1 order by id", [input.tenantID])).map(
    runtimeWorker,
  )
}

export async function listSessionRuntimeBindings(input: { client: QueryClient; tenantID: string }) {
  return rows(await input.client.query("select * from cloud_session_runtime_binding where tenant_id = $1", [input.tenantID])).map(
    sessionRuntimeBinding,
  )
}

export async function bindSessionRuntime(input: { client: QueryClient; binding: SessionBinding }) {
  await input.client.query(
    `insert into cloud_session_runtime_binding (
      tenant_id, session_id, runtime_id, time_created, time_updated
    ) values ($1, $2, $3, $4, $5)
    on conflict(tenant_id, session_id) do update set
      runtime_id = excluded.runtime_id,
      time_updated = excluded.time_updated`,
    [input.binding.tenantID, input.binding.sessionID, input.binding.runtimeID, input.binding.time.created, input.binding.time.updated],
  )
  return input.binding
}

export async function releaseSessionRuntime(input: { client: QueryClient; tenantID: string; sessionID: string }) {
  await input.client.query("delete from cloud_session_runtime_binding where tenant_id = $1 and session_id = $2", [
    input.tenantID,
    input.sessionID,
  ])
}

export async function markRuntimeOffline(input: { client: QueryClient; tenantID: string; runtimeID: string; now: number }) {
  await input.client.query("update cloud_runtime_worker set status = 'offline', time_updated = $1 where tenant_id = $2 and id = $3", [
    input.now,
    input.tenantID,
    input.runtimeID,
  ])
}

export * as CloudPostgresRepository from "./postgres-repository"
