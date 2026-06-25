import type { QueryClient } from "./postgres-runner"

const statements = [
  `create table if not exists cloud_tenant (
    id text primary key,
    name text not null,
    default_runtime_version text not null,
    allowed_models jsonb not null,
    budget jsonb not null,
    time_created bigint not null,
    time_updated bigint not null
  )`,
  `create table if not exists cloud_user (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    external_id text not null,
    email text,
    time_created bigint not null,
    time_updated bigint not null
  )`,
  "create index if not exists cloud_user_tenant_idx on cloud_user (tenant_id)",
  "create index if not exists cloud_user_tenant_external_idx on cloud_user (tenant_id, external_id)",
  `create table if not exists cloud_workspace (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    external_id text,
    name text,
    time_created bigint not null,
    time_updated bigint not null
  )`,
  "create index if not exists cloud_workspace_tenant_idx on cloud_workspace (tenant_id)",
  "create index if not exists cloud_workspace_tenant_external_idx on cloud_workspace (tenant_id, external_id)",
  `create table if not exists cloud_session (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    workspace_id text not null references cloud_workspace(id) on delete cascade,
    user_id text not null references cloud_user(id) on delete cascade,
    title text not null,
    model jsonb,
    summary text,
    time_created bigint not null,
    time_updated bigint not null
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
    size bigint not null,
    object_key text not null,
    sha256 text,
    time_created bigint not null,
    time_updated bigint not null
  )`,
  "create index if not exists cloud_file_tenant_idx on cloud_file (tenant_id)",
  "create index if not exists cloud_file_workspace_idx on cloud_file (workspace_id)",
  "create index if not exists cloud_file_session_idx on cloud_file (session_id)",
  `create table if not exists cloud_job (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    workspace_id text not null references cloud_workspace(id) on delete cascade,
    session_id text not null references cloud_session(id) on delete cascade,
    status text not null,
    execution_mode text,
    runtime jsonb not null,
    job_spec jsonb,
    model_config_snapshot jsonb,
    cost jsonb not null,
    error text,
    time_created bigint not null,
    time_updated bigint not null
  )`,
  "create index if not exists cloud_job_tenant_status_idx on cloud_job (tenant_id, status)",
  "create index if not exists cloud_job_session_idx on cloud_job (session_id)",
  "create index if not exists cloud_job_updated_idx on cloud_job (time_updated)",
  `create table if not exists cloud_message (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    workspace_id text not null references cloud_workspace(id) on delete cascade,
    session_id text not null references cloud_session(id) on delete cascade,
    job_id text references cloud_job(id) on delete set null,
    role text not null,
    content text not null,
    time_created bigint not null,
    time_updated bigint not null
  )`,
  "create index if not exists cloud_message_session_time_idx on cloud_message (session_id, time_created, id)",
  "create index if not exists cloud_message_job_idx on cloud_message (job_id)",
  `create table if not exists cloud_artifact (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    workspace_id text not null references cloud_workspace(id) on delete cascade,
    session_id text not null references cloud_session(id) on delete cascade,
    job_id text not null references cloud_job(id) on delete cascade,
    name text not null,
    kind text not null,
    mime text,
    size bigint not null,
    object_key text not null,
    sha256 text,
    time_created bigint not null,
    time_updated bigint not null
  )`,
  "create index if not exists cloud_artifact_tenant_idx on cloud_artifact (tenant_id)",
  "create index if not exists cloud_artifact_job_idx on cloud_artifact (job_id)",
  "create index if not exists cloud_artifact_session_idx on cloud_artifact (session_id)",
  `create table if not exists cloud_runtime_instance (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    workspace_id text not null references cloud_workspace(id) on delete cascade,
    session_id text not null references cloud_session(id) on delete cascade,
    job_id text not null references cloud_job(id) on delete cascade,
    engine text not null,
    version text not null,
    image text,
    image_digest text,
    sandbox_id text,
    time_created bigint not null,
    time_updated bigint not null
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
    max_active_jobs bigint not null,
    max_sessions bigint not null,
    endpoint text,
    metrics jsonb not null,
    time_created bigint not null,
    time_updated bigint not null
  )`,
  "create index if not exists cloud_runtime_worker_tenant_idx on cloud_runtime_worker (tenant_id)",
  "create index if not exists cloud_runtime_worker_tenant_status_idx on cloud_runtime_worker (tenant_id, status)",
  `create table if not exists cloud_session_runtime_binding (
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    session_id text not null references cloud_session(id) on delete cascade,
    runtime_id text not null references cloud_runtime_worker(id) on delete cascade,
    time_created bigint not null,
    time_updated bigint not null,
    primary key (tenant_id, session_id)
  )`,
  "create index if not exists cloud_session_runtime_binding_runtime_idx on cloud_session_runtime_binding (tenant_id, runtime_id)",
  `create table if not exists cloud_integrator_runtime_policy (
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    integrator_id text not null,
    default_execution_mode text not null,
    allowed_execution_modes jsonb not null,
    max_active_jobs bigint not null,
    max_sessions bigint not null,
    max_concurrent_jobs_per_session bigint not null,
    time_created bigint not null,
    time_updated bigint not null,
    primary key (tenant_id, integrator_id)
  )`,
  "create index if not exists cloud_integrator_runtime_policy_tenant_idx on cloud_integrator_runtime_policy (tenant_id)",
  `create table if not exists cloud_job_lease (
    job_id text primary key references cloud_job(id) on delete cascade,
    worker_id text not null,
    expires_at bigint not null,
    heartbeat_at bigint not null
  )`,
  `create table if not exists cloud_queue_message (
    queue text not null,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    job_id text not null references cloud_job(id) on delete cascade,
    run_at bigint not null,
    priority integer not null,
    attempt integer not null,
    status text not null,
    worker_id text,
    lease_expires_at bigint,
    reason text,
    terminal_status text,
    time_created bigint not null,
    time_updated bigint not null,
    primary key (queue, tenant_id, job_id)
  )`,
  "create index if not exists cloud_queue_message_visible_idx on cloud_queue_message (queue, tenant_id, status, run_at, priority)",
  "create index if not exists cloud_queue_message_job_idx on cloud_queue_message (tenant_id, job_id)",
  `create table if not exists cloud_job_attempt (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    workspace_id text not null references cloud_workspace(id) on delete cascade,
    session_id text not null references cloud_session(id) on delete cascade,
    job_id text not null references cloud_job(id) on delete cascade,
    worker_id text not null,
    attempt integer not null,
    reason text not null,
    runtime jsonb not null,
    status text not null,
    error text,
    time_created bigint not null,
    time_updated bigint not null
  )`,
  "create index if not exists cloud_job_attempt_tenant_idx on cloud_job_attempt (tenant_id)",
  "create index if not exists cloud_job_attempt_job_idx on cloud_job_attempt (job_id, attempt)",
  `create table if not exists cloud_job_event (
    id text primary key,
    job_id text not null references cloud_job(id) on delete cascade,
    sequence bigint not null,
    type text not null,
    data jsonb not null,
    time_created bigint not null
  )`,
  "create index if not exists cloud_job_event_job_sequence_idx on cloud_job_event (job_id, sequence)",
  `create table if not exists cloud_event_checkpoint (
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    consumer_id text not null,
    job_id text not null references cloud_job(id) on delete cascade,
    cursor bigint not null,
    time_updated bigint not null,
    primary key (tenant_id, consumer_id, job_id)
  )`,
  `create table if not exists cloud_tool_call (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    workspace_id text not null references cloud_workspace(id) on delete cascade,
    session_id text not null references cloud_session(id) on delete cascade,
    job_id text not null references cloud_job(id) on delete cascade,
    tool text not null,
    status text not null,
    duration_ms bigint,
    error text,
    estimated_cost_usd double precision,
    time_created bigint not null,
    time_updated bigint not null
  )`,
  "create index if not exists cloud_tool_call_tenant_idx on cloud_tool_call (tenant_id)",
  "create index if not exists cloud_tool_call_job_idx on cloud_tool_call (job_id)",
  "create index if not exists cloud_tool_call_tool_idx on cloud_tool_call (tool)",
  `create table if not exists cloud_audit_event (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    user_id text,
    resource_type text not null,
    resource_id text not null,
    action text not null,
    time_created bigint not null
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
    scopes jsonb not null,
    time_revoked bigint,
    time_created bigint not null,
    time_updated bigint not null
  )`,
  "create index if not exists cloud_api_key_tenant_idx on cloud_api_key (tenant_id)",
  "create index if not exists cloud_api_key_prefix_idx on cloud_api_key (prefix)",
  `create table if not exists cloud_webhook_subscription (
    id text primary key,
    tenant_id text not null references cloud_tenant(id) on delete cascade,
    url text not null,
    secret_ref text not null,
    events jsonb not null,
    enabled boolean not null,
    time_created bigint not null,
    time_updated bigint not null
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
    allowed_models jsonb not null,
    default_model text not null,
    enabled integer not null,
    version bigint not null,
    last_used_at bigint,
    time_created bigint not null,
    time_updated bigint not null
  )`,
  "create index if not exists cloud_llm_credential_tenant_idx on cloud_llm_credential (tenant_id)",
  "create index if not exists cloud_llm_credential_owner_idx on cloud_llm_credential (tenant_id, scope, owner_key)",
]

function nameFrom(input: { statement: string; kind: "table" | "index" }) {
  return input.statement.match(new RegExp(`create ${input.kind} if not exists ([a-z0-9_]+)`))?.[1]
}

export async function apply(input: { client: QueryClient }) {
  await input.client.query("select pg_advisory_lock(8213477)", [])
  try {
    for (const statement of statements) {
      await input.client.query(statement, [])
    }
  } finally {
    await input.client.query("select pg_advisory_unlock(8213477)", [])
  }
  return {
    tables: statements
      .map((statement) => nameFrom({ statement, kind: "table" }))
      .filter((item): item is string => Boolean(item)),
    indexes: statements
      .map((statement) => nameFrom({ statement, kind: "index" }))
      .filter((item): item is string => Boolean(item)),
  }
}

export * as CloudPostgresSchema from "./postgres-schema"
