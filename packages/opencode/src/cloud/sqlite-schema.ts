import type { Database } from "bun:sqlite"

const statements = [
  "pragma foreign_keys = on",
  `create table if not exists cloud_tenant (
    id text primary key,
    name text not null,
    default_runtime_version text not null,
    allowed_models text not null,
    budget text not null,
    time_created integer not null,
    time_updated integer not null
  )`,
  `create table if not exists cloud_user (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    external_id text not null,
    email text,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_user_tenant_idx on cloud_user (tenant_id)",
  "create index if not exists cloud_user_tenant_external_idx on cloud_user (tenant_id, external_id)",
  `create table if not exists cloud_workspace (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    external_id text,
    name text,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_workspace_tenant_idx on cloud_workspace (tenant_id)",
  "create index if not exists cloud_workspace_tenant_external_idx on cloud_workspace (tenant_id, external_id)",
  `create table if not exists cloud_session (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    workspace_id text not null references cloud_workspace(id) on delete cascade,
    user_id text not null references cloud_user(id) on delete cascade,
    title text not null,
    model text,
    summary text,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_session_tenant_idx on cloud_session (tenant_id)",
  "create index if not exists cloud_session_workspace_idx on cloud_session (workspace_id)",
  "create index if not exists cloud_session_user_idx on cloud_session (user_id)",
  `create table if not exists cloud_file (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    workspace_id text not null references cloud_workspace(id) on delete cascade,
    session_id text references cloud_session(id) on delete set null,
    name text not null,
    mime text,
    size integer not null,
    object_key text not null,
    sha256 text,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_file_tenant_idx on cloud_file (tenant_id)",
  "create index if not exists cloud_file_workspace_idx on cloud_file (workspace_id)",
  "create index if not exists cloud_file_session_idx on cloud_file (session_id)",
  `create table if not exists cloud_job (
    id text primary key,
    tenant_id text not null,
    workspace_id text not null,
    session_id text not null,
    status text not null,
    execution_mode text,
    runtime text not null,
    job_spec text,
    model_config_snapshot text,
    cost text not null,
    error text,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_job_tenant_status_idx on cloud_job (tenant_id, status)",
  "create index if not exists cloud_job_session_idx on cloud_job (session_id)",
  "create index if not exists cloud_job_updated_idx on cloud_job (time_updated)",
  `create table if not exists cloud_message (
    id text primary key,
    tenant_id text not null,
    workspace_id text not null,
    session_id text not null,
    job_id text references cloud_job(id) on delete set null,
    role text not null,
    content text not null,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_message_session_time_idx on cloud_message (session_id, time_created, id)",
  "create index if not exists cloud_message_job_idx on cloud_message (job_id)",
  `create table if not exists cloud_artifact (
    id text primary key,
    tenant_id text not null,
    workspace_id text not null,
    session_id text not null,
    job_id text not null references cloud_job(id) on delete cascade,
    name text not null,
    kind text not null,
    mime text,
    size integer not null,
    object_key text not null,
    sha256 text,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_artifact_tenant_idx on cloud_artifact (tenant_id)",
  "create index if not exists cloud_artifact_job_idx on cloud_artifact (job_id)",
  "create index if not exists cloud_artifact_session_idx on cloud_artifact (session_id)",
  `create table if not exists cloud_runtime_instance (
    id text primary key,
    tenant_id text not null,
    workspace_id text not null,
    session_id text not null,
    job_id text not null references cloud_job(id) on delete cascade,
    engine text not null,
    version text not null,
    image text,
    image_digest text,
    sandbox_id text,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_runtime_instance_tenant_idx on cloud_runtime_instance (tenant_id)",
  "create index if not exists cloud_runtime_instance_job_idx on cloud_runtime_instance (job_id)",
  `create table if not exists cloud_runtime_worker (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    execution_mode text not null,
    status text not null,
    version text not null,
    profile text not null,
    max_active_jobs integer not null,
    max_sessions integer not null,
    metrics text not null,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_runtime_worker_tenant_idx on cloud_runtime_worker (tenant_id)",
  "create index if not exists cloud_runtime_worker_tenant_status_idx on cloud_runtime_worker (tenant_id, status)",
  `create table if not exists cloud_session_runtime_binding (
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    session_id text not null references cloud_session(id) on delete cascade,
    runtime_id text not null references cloud_runtime_worker(id) on delete cascade,
    time_created integer not null,
    time_updated integer not null,
    primary key (tenant_id, session_id)
  )`,
  "create index if not exists cloud_session_runtime_binding_runtime_idx on cloud_session_runtime_binding (tenant_id, runtime_id)",
  `create table if not exists cloud_integrator_runtime_policy (
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    integrator_id text not null,
    default_execution_mode text not null,
    allowed_execution_modes text not null,
    max_active_jobs integer not null,
    max_sessions integer not null,
    max_concurrent_jobs_per_session integer not null,
    time_created integer not null,
    time_updated integer not null,
    primary key (tenant_id, integrator_id)
  )`,
  "create index if not exists cloud_integrator_runtime_policy_tenant_idx on cloud_integrator_runtime_policy (tenant_id)",
  `create table if not exists cloud_job_lease (
    job_id text primary key references cloud_job(id) on delete cascade,
    worker_id text not null,
    expires_at integer not null,
    heartbeat_at integer not null
  )`,
  `create table if not exists cloud_job_attempt (
    id text primary key,
    tenant_id text not null,
    workspace_id text not null,
    session_id text not null,
    job_id text not null references cloud_job(id) on delete cascade,
    worker_id text not null,
    attempt integer not null,
    reason text not null,
    runtime text not null,
    status text not null,
    error text,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_job_attempt_tenant_idx on cloud_job_attempt (tenant_id)",
  "create index if not exists cloud_job_attempt_job_idx on cloud_job_attempt (job_id, attempt)",
  `create table if not exists cloud_job_event (
    id text primary key,
    job_id text not null references cloud_job(id) on delete cascade,
    sequence integer not null,
    type text not null,
    data text not null,
    time_created integer not null
  )`,
  "create index if not exists cloud_job_event_job_sequence_idx on cloud_job_event (job_id, sequence)",
  `create table if not exists cloud_event_checkpoint (
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    consumer_id text not null,
    job_id text not null references cloud_job(id) on delete cascade,
    cursor integer not null,
    time_updated integer not null,
    primary key (tenant_id, consumer_id, job_id)
  )`,
  `create table if not exists cloud_tool_call (
    id text primary key,
    tenant_id text not null,
    workspace_id text not null,
    session_id text not null,
    job_id text not null references cloud_job(id) on delete cascade,
    tool text not null,
    status text not null,
    duration_ms integer,
    error text,
    estimated_cost_usd real,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_tool_call_tenant_idx on cloud_tool_call (tenant_id)",
  "create index if not exists cloud_tool_call_job_idx on cloud_tool_call (job_id)",
  "create index if not exists cloud_tool_call_tool_idx on cloud_tool_call (tool)",
  `create table if not exists cloud_audit_event (
    id text primary key,
    tenant_id text not null,
    user_id text,
    resource_type text not null,
    resource_id text not null,
    action text not null,
    time_created integer not null
  )`,
  "create index if not exists cloud_audit_event_tenant_idx on cloud_audit_event (tenant_id)",
  "create index if not exists cloud_audit_event_user_idx on cloud_audit_event (user_id)",
  "create index if not exists cloud_audit_event_resource_idx on cloud_audit_event (resource_type, resource_id)",
  `create table if not exists cloud_api_key (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    name text not null,
    prefix text not null,
    hash text not null,
    scopes text not null,
    time_revoked integer,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_api_key_tenant_idx on cloud_api_key (tenant_id)",
  "create index if not exists cloud_api_key_prefix_idx on cloud_api_key (prefix)",
  `create table if not exists cloud_webhook_subscription (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    url text not null,
    secret_ref text not null,
    events text not null,
    enabled integer not null,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_webhook_subscription_tenant_idx on cloud_webhook_subscription (tenant_id)",
  `create table if not exists cloud_llm_credential (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    scope text not null,
    owner_key text not null,
    name text not null,
    provider_type text not null,
    provider text not null,
    base_url text,
    secret_ref text not null,
    allowed_models text not null,
    default_model text not null,
    enabled integer not null,
    version integer not null,
    last_used_at integer,
    time_created integer not null,
    time_updated integer not null
  )`,
  "create index if not exists cloud_llm_credential_tenant_idx on cloud_llm_credential (tenant_id)",
  "create index if not exists cloud_llm_credential_owner_idx on cloud_llm_credential (tenant_id, scope, owner_key)",
]

export function apply(input: { db: Database }) {
  statements.forEach((statement) => input.db.exec(statement))
  return {
    tables: input.db
      .query("select name from sqlite_master where type = 'table' and name like 'cloud_%' order by name")
      .all()
      .map((row) => `${(row as { name: string }).name}`),
    indexes: input.db
      .query("select name from sqlite_master where type = 'index' and name like 'cloud_%' order by name")
      .all()
      .map((row) => `${(row as { name: string }).name}`),
  }
}

export * as CloudSQLiteSchema from "./sqlite-schema"
