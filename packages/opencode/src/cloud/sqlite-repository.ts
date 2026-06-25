import type { Database } from "bun:sqlite"
import { CloudAPI, type JobEvent } from "./api"
import type { Lease } from "./lease"
import { CloudRuntime, type JobSpec } from "./runtime"
import { CloudSchema, type Job, type Message } from "./schema"

function parse(input: unknown) {
  if (typeof input !== "string") return input
  return JSON.parse(input)
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
      created: input.time_created,
      updated: input.time_updated,
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
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function event(input: Record<string, unknown>): JobEvent {
  return CloudAPI.decodeJobEvent({
    id: input.id,
    jobID: input.job_id,
    type: input.type,
    data: parse(input.data),
    time: input.time_created,
  })
}

export function listQueuedJobs(input: { db: Database; tenantID: string }) {
  return input.db
    .query("select * from cloud_job where tenant_id = ? and status = 'queued' order by time_created, id")
    .all(input.tenantID)
    .map((row) => job(row as Record<string, unknown>))
}

export function getJob(input: { db: Database; tenantID: string; id: string }): Job | undefined {
  const row = input.db.query("select * from cloud_job where tenant_id = ? and id = ?").get(input.tenantID, input.id)
  if (!row) return undefined
  return job(row as Record<string, unknown>)
}

export function getJobSpec(input: { db: Database; tenantID: string; id: string }): JobSpec | undefined {
  const row = input.db
    .query("select job_spec from cloud_job where tenant_id = ? and id = ?")
    .get(input.tenantID, input.id) as { job_spec: string | null } | null
  if (!row?.job_spec) return undefined
  return CloudRuntime.decodeJobSpec(parse(row.job_spec))
}

export function getJobPrompt(input: { db: Database; tenantID: string; jobID: string }) {
  const row = input.db
    .query(
      "select * from cloud_message where tenant_id = ? and job_id = ? and role = 'user' order by time_created desc, id desc limit 1",
    )
    .get(input.tenantID, input.jobID) as Record<string, unknown> | null
  if (!row) return undefined
  const result = message(row)
  return {
    id: result.jobID ?? result.id,
    tenantID: result.tenantID,
    jobID: input.jobID,
    prompt: result.content,
  }
}

export function listEvents(input: { db: Database; jobID: string; cursor?: string; limit?: number }) {
  return input.db
    .query(
      "select * from cloud_job_event where job_id = ? and id > ? order by sequence, id limit ?",
    )
    .all(input.jobID, input.cursor ?? "", input.limit ?? 100)
    .map((row) => event(row as Record<string, unknown>))
}

export function getLease(input: { db: Database; jobID: string }): Lease | undefined {
  const row = input.db.query("select * from cloud_job_lease where job_id = ?").get(input.jobID) as
    | {
        job_id: string
        worker_id: string
        expires_at: number
        heartbeat_at: number
      }
    | null
  if (!row) return undefined
  return {
    jobID: row.job_id,
    workerID: row.worker_id,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
  }
}

export * as CloudSQLiteRepository from "./sqlite-repository"
