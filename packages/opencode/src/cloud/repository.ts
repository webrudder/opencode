import type { JobEvent } from "./api"
import type { CloudAttempt } from "./attempt"
import type { Lease } from "./lease"
import type { RuntimeWorker, SessionBinding } from "./runtime-pool"
import type { JobSpec } from "./runtime"
import type { Artifact, AuditEvent, File, Job, LLMCredential, Message, Session, WebhookSubscription, Workspace } from "./schema"

type Row = Record<string, unknown>
export type Mutation = {
  action: "insert" | "update" | "delete"
  table: string
  key: Record<string, string | number>
  values?: Row
}

function sequence(input: JobEvent) {
  return Number(input.id.slice(input.jobID.length + 1))
}

function insert(input: { table: string; key: Record<string, string | number>; values: Row }): Mutation {
  return {
    action: "insert",
    table: input.table,
    key: input.key,
    values: input.values,
  }
}

function update(input: { table: string; key: Record<string, string | number>; values: Row }): Mutation {
  return {
    action: "update",
    table: input.table,
    key: input.key,
    values: input.values,
  }
}

function remove(input: { table: string; key: Record<string, string | number> }): Mutation {
  return {
    action: "delete",
    table: input.table,
    key: input.key,
  }
}

export function workspaceRow(input: Workspace) {
  return {
    id: input.id,
    tenant_id: input.tenantID,
    external_id: input.externalID,
    name: input.name,
    time_created: input.time.created,
    time_updated: input.time.updated,
  }
}

export function sessionRow(input: Session) {
  return {
    id: input.id,
    tenant_id: input.tenantID,
    workspace_id: input.workspaceID,
    user_id: input.userID,
    title: input.title,
    model: input.model,
    summary: input.summary,
    time_created: input.time.created,
    time_updated: input.time.updated,
  }
}

export function fileRow(input: File) {
  return {
    id: input.id,
    tenant_id: input.tenantID,
    workspace_id: input.workspaceID,
    session_id: input.sessionID,
    name: input.name,
    mime: input.mime,
    size: input.size,
    object_key: input.objectKey,
    sha256: input.sha256,
    time_created: input.time.created,
    time_updated: input.time.updated,
  }
}

export function jobRow(input: { job: Job; spec?: JobSpec }) {
  return {
    id: input.job.id,
    tenant_id: input.job.tenantID,
    workspace_id: input.job.workspaceID,
    session_id: input.job.sessionID,
    status: input.job.status,
    ...(input.job.executionMode ? { execution_mode: input.job.executionMode } : {}),
    runtime: input.job.runtime,
    job_spec: input.spec,
    ...(input.job.modelConfigSnapshot ? { model_config_snapshot: input.job.modelConfigSnapshot } : {}),
    cost: input.job.cost,
    error: input.job.error,
    time_created: input.job.time.created,
    time_updated: input.job.time.updated,
  }
}

export function messageRow(input: Message) {
  return {
    id: input.id,
    tenant_id: input.tenantID,
    workspace_id: input.workspaceID,
    session_id: input.sessionID,
    job_id: input.jobID,
    role: input.role,
    content: input.content,
    time_created: input.time.created,
    time_updated: input.time.updated,
  }
}

export function artifactRow(input: Artifact) {
  return {
    id: input.id,
    tenant_id: input.tenantID,
    workspace_id: input.workspaceID,
    session_id: input.sessionID,
    job_id: input.jobID,
    name: input.name,
    kind: input.kind,
    mime: input.mime,
    size: input.size,
    object_key: input.objectKey,
    sha256: input.sha256,
    time_created: input.time.created,
    time_updated: input.time.updated,
  }
}

export function attemptRow(input: ReturnType<typeof CloudAttempt.start>) {
  return {
    id: input.id,
    tenant_id: input.tenantID,
    workspace_id: input.workspaceID,
    session_id: input.sessionID,
    job_id: input.jobID,
    worker_id: input.workerID,
    attempt: input.attempt,
    reason: input.reason,
    runtime: input.runtime,
    status: input.status,
    error: input.error,
    time_created: input.time.created,
    time_updated: input.time.updated,
  }
}

export function eventRow(input: JobEvent) {
  return {
    id: input.id,
    job_id: input.jobID,
    sequence: sequence(input),
    type: input.type,
    data: input.data,
    time_created: input.time,
  }
}

export function leaseRow(input: Lease) {
  return {
    job_id: input.jobID,
    worker_id: input.workerID,
    expires_at: input.expiresAt,
    heartbeat_at: input.heartbeatAt,
  }
}

export function auditEventRow(input: AuditEvent) {
  return {
    id: input.id,
    tenant_id: input.tenantID,
    user_id: input.userID,
    resource_type: input.resourceType,
    resource_id: input.resourceID,
    action: input.action,
    time_created: input.time.created,
  }
}

export function webhookRow(input: WebhookSubscription) {
  return {
    id: input.id,
    tenant_id: input.tenantID,
    url: input.url,
    secret_ref: input.secretRef,
    events: input.events,
    enabled: input.enabled ? 1 : 0,
    time_created: input.time.created,
    time_updated: input.time.updated,
  }
}

export function llmCredentialRow(input: LLMCredential) {
  return {
    id: input.id,
    tenant_id: input.tenantID,
    scope: input.scope,
    owner_key: input.ownerKey,
    name: input.name,
    provider_type: input.providerType,
    provider: input.provider,
    base_url: input.baseURL,
    secret_ref: input.secretRef,
    allowed_models: input.allowedModels,
    default_model: input.defaultModel,
    enabled: input.enabled ? 1 : 0,
    version: input.version,
    last_used_at: input.lastUsedAt,
    time_created: input.time.created,
    time_updated: input.time.updated,
  }
}

export function runtimeWorkerRow(input: RuntimeWorker) {
  return {
    id: input.id,
    tenant_id: input.tenantID,
    execution_mode: input.executionMode,
    status: input.status,
    version: input.version,
    profile: input.profile,
    max_active_jobs: input.maxActiveJobs,
    max_sessions: input.maxSessions,
    metrics: input.metrics,
    time_created: input.time.created,
    time_updated: input.time.updated,
  }
}

export function sessionRuntimeBindingRow(input: SessionBinding) {
  return {
    tenant_id: input.tenantID,
    session_id: input.sessionID,
    runtime_id: input.runtimeID,
    time_created: input.time.created,
    time_updated: input.time.updated,
  }
}

export function createJobTransaction(input: { job: Job; event: JobEvent; spec?: JobSpec }) {
  return [
    insert({ table: "cloud_job", key: { id: input.job.id }, values: jobRow({ job: input.job, spec: input.spec }) }),
    insert({ table: "cloud_job_event", key: { id: input.event.id }, values: eventRow(input.event) }),
  ]
}

export function recordLeaseTransaction(input: {
  job: Job
  lease: Lease
  attempt: ReturnType<typeof CloudAttempt.start>
  event: JobEvent
}) {
  return [
    update({
      table: "cloud_job",
      key: { id: input.job.id, tenant_id: input.job.tenantID },
      values: jobRow({ job: input.job }),
    }),
    insert({ table: "cloud_job_lease", key: { job_id: input.lease.jobID }, values: leaseRow(input.lease) }),
    insert({ table: "cloud_job_attempt", key: { id: input.attempt.id }, values: attemptRow(input.attempt) }),
    insert({ table: "cloud_job_event", key: { id: input.event.id }, values: eventRow(input.event) }),
  ]
}

export function completeJobTransaction(input: { job: Job; artifacts: Artifact[]; attempt?: ReturnType<typeof CloudAttempt.start>; events: JobEvent[] }) {
  return [
    update({
      table: "cloud_job",
      key: { id: input.job.id, tenant_id: input.job.tenantID },
      values: jobRow({ job: input.job }),
    }),
    ...(input.attempt
      ? [
          update({
            table: "cloud_job_attempt",
            key: { id: input.attempt.id, tenant_id: input.attempt.tenantID },
            values: attemptRow(input.attempt),
          }),
        ]
      : []),
    ...input.artifacts.map((artifact) =>
      insert({ table: "cloud_artifact", key: { id: artifact.id }, values: artifactRow(artifact) }),
    ),
    ...input.events.map((event) => insert({ table: "cloud_job_event", key: { id: event.id }, values: eventRow(event) })),
    remove({ table: "cloud_job_lease", key: { job_id: input.job.id } }),
  ]
}

export function cancelJobTransaction(input: { job: Job; attempt?: ReturnType<typeof CloudAttempt.start>; event: JobEvent }) {
  return [
    update({
      table: "cloud_job",
      key: { id: input.job.id, tenant_id: input.job.tenantID },
      values: jobRow({ job: input.job }),
    }),
    ...(input.attempt
      ? [
          update({
            table: "cloud_job_attempt",
            key: { id: input.attempt.id, tenant_id: input.attempt.tenantID },
            values: attemptRow(input.attempt),
          }),
        ]
      : []),
    insert({ table: "cloud_job_event", key: { id: input.event.id }, values: eventRow(input.event) }),
    remove({ table: "cloud_job_lease", key: { job_id: input.job.id } }),
  ]
}

export * as CloudRepository from "./repository"
