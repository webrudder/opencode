import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { JobSpec } from "./runtime"
import type { RuntimeWorker } from "./runtime-pool"
import type { CloudSchema } from "./schema"

const Timestamps = {
  time_created: integer().notNull(),
  time_updated: integer().notNull(),
}

export const TenantTable = sqliteTable("cloud_tenant", {
  id: text().primaryKey(),
  name: text().notNull(),
  default_runtime_version: text().notNull(),
  allowed_models: text({ mode: "json" }).notNull().$type<string[]>(),
  budget: text({ mode: "json" }).notNull().$type<CloudSchema.Tenant["budget"]>(),
  ...Timestamps,
})

export const UserTable = sqliteTable(
  "cloud_user",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    external_id: text().notNull(),
    email: text(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_user_tenant_idx").on(table.tenant_id),
    index("cloud_user_tenant_external_idx").on(table.tenant_id, table.external_id),
  ],
)

export const WorkspaceTable = sqliteTable(
  "cloud_workspace",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    external_id: text(),
    name: text(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_workspace_tenant_idx").on(table.tenant_id),
    index("cloud_workspace_tenant_external_idx").on(table.tenant_id, table.external_id),
  ],
)

export const SessionTable = sqliteTable(
  "cloud_session",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    workspace_id: text()
      .notNull()
      .references(() => WorkspaceTable.id, { onDelete: "cascade" }),
    user_id: text()
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    model: text({ mode: "json" }).$type<CloudSchema.Session["model"]>(),
    summary: text(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_session_tenant_idx").on(table.tenant_id),
    index("cloud_session_workspace_idx").on(table.workspace_id),
    index("cloud_session_user_idx").on(table.user_id),
  ],
)

export const FileTable = sqliteTable(
  "cloud_file",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    workspace_id: text()
      .notNull()
      .references(() => WorkspaceTable.id, { onDelete: "cascade" }),
    session_id: text().references(() => SessionTable.id, { onDelete: "set null" }),
    name: text().notNull(),
    mime: text(),
    size: integer().notNull(),
    object_key: text().notNull(),
    sha256: text(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_file_tenant_idx").on(table.tenant_id),
    index("cloud_file_workspace_idx").on(table.workspace_id),
    index("cloud_file_session_idx").on(table.session_id),
  ],
)

export const JobTable = sqliteTable(
  "cloud_job",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    workspace_id: text()
      .notNull()
      .references(() => WorkspaceTable.id, { onDelete: "cascade" }),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    status: text().notNull().$type<CloudSchema.Job["status"]>(),
    execution_mode: text().$type<CloudSchema.Job["executionMode"]>(),
    runtime: text({ mode: "json" }).notNull().$type<CloudSchema.Job["runtime"]>(),
    job_spec: text({ mode: "json" }).$type<JobSpec>(),
    model_config_snapshot: text({ mode: "json" }).$type<CloudSchema.Job["modelConfigSnapshot"]>(),
    cost: text({ mode: "json" }).notNull().$type<CloudSchema.Job["cost"]>(),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_job_tenant_status_idx").on(table.tenant_id, table.status),
    index("cloud_job_session_idx").on(table.session_id),
    index("cloud_job_updated_idx").on(table.time_updated),
  ],
)

export const MessageTable = sqliteTable(
  "cloud_message",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    workspace_id: text()
      .notNull()
      .references(() => WorkspaceTable.id, { onDelete: "cascade" }),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    job_id: text().references(() => JobTable.id, { onDelete: "set null" }),
    role: text().notNull().$type<CloudSchema.Message["role"]>(),
    content: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_message_session_time_idx").on(table.session_id, table.time_created, table.id),
    index("cloud_message_job_idx").on(table.job_id),
  ],
)

export const ArtifactTable = sqliteTable(
  "cloud_artifact",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    workspace_id: text()
      .notNull()
      .references(() => WorkspaceTable.id, { onDelete: "cascade" }),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    job_id: text()
      .notNull()
      .references(() => JobTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    kind: text().notNull(),
    mime: text(),
    size: integer().notNull(),
    object_key: text().notNull(),
    sha256: text(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_artifact_tenant_idx").on(table.tenant_id),
    index("cloud_artifact_job_idx").on(table.job_id),
    index("cloud_artifact_session_idx").on(table.session_id),
  ],
)

export const RuntimeInstanceTable = sqliteTable(
  "cloud_runtime_instance",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    workspace_id: text()
      .notNull()
      .references(() => WorkspaceTable.id, { onDelete: "cascade" }),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    job_id: text()
      .notNull()
      .references(() => JobTable.id, { onDelete: "cascade" }),
    engine: text().notNull().$type<CloudSchema.RuntimeInstance["engine"]>(),
    version: text().notNull(),
    image: text(),
    image_digest: text(),
    sandbox_id: text(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_runtime_instance_tenant_idx").on(table.tenant_id),
    index("cloud_runtime_instance_job_idx").on(table.job_id),
  ],
)

export const RuntimeWorkerTable = sqliteTable(
  "cloud_runtime_worker",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    execution_mode: text().notNull().$type<RuntimeWorker["executionMode"]>(),
    status: text().notNull().$type<RuntimeWorker["status"]>(),
    version: text().notNull(),
    profile: text().notNull().$type<RuntimeWorker["profile"]>(),
    max_active_jobs: integer().notNull(),
    max_sessions: integer().notNull(),
    metrics: text({ mode: "json" }).notNull().$type<RuntimeWorker["metrics"]>(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_runtime_worker_tenant_idx").on(table.tenant_id),
    index("cloud_runtime_worker_tenant_status_idx").on(table.tenant_id, table.status),
  ],
)

export const SessionRuntimeBindingTable = sqliteTable(
  "cloud_session_runtime_binding",
  {
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    runtime_id: text()
      .notNull()
      .references(() => RuntimeWorkerTable.id, { onDelete: "cascade" }),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.session_id] }),
    index("cloud_session_runtime_binding_runtime_idx").on(table.tenant_id, table.runtime_id),
  ],
)

export const JobLeaseTable = sqliteTable("cloud_job_lease", {
  job_id: text()
    .primaryKey()
    .references(() => JobTable.id, { onDelete: "cascade" }),
  worker_id: text().notNull(),
  expires_at: integer().notNull(),
  heartbeat_at: integer().notNull(),
})

export const JobAttemptTable = sqliteTable(
  "cloud_job_attempt",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    workspace_id: text()
      .notNull()
      .references(() => WorkspaceTable.id, { onDelete: "cascade" }),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    job_id: text()
      .notNull()
      .references(() => JobTable.id, { onDelete: "cascade" }),
    worker_id: text().notNull(),
    attempt: integer().notNull(),
    reason: text().notNull().$type<"initial" | "retry">(),
    runtime: text({ mode: "json" }).notNull().$type<CloudSchema.Job["runtime"]>(),
    status: text().notNull().$type<"running" | "succeeded" | "failed" | "canceled">(),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_job_attempt_tenant_idx").on(table.tenant_id),
    index("cloud_job_attempt_job_idx").on(table.job_id, table.attempt),
  ],
)

export const JobEventTable = sqliteTable(
  "cloud_job_event",
  {
    id: text().primaryKey(),
    job_id: text()
      .notNull()
      .references(() => JobTable.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    type: text().notNull(),
    data: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
    time_created: integer().notNull(),
  },
  (table) => [index("cloud_job_event_job_sequence_idx").on(table.job_id, table.sequence)],
)

export const EventCheckpointTable = sqliteTable(
  "cloud_event_checkpoint",
  {
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    consumer_id: text().notNull(),
    job_id: text()
      .notNull()
      .references(() => JobTable.id, { onDelete: "cascade" }),
    cursor: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenant_id, table.consumer_id, table.job_id] })],
)

export const ToolCallTable = sqliteTable(
  "cloud_tool_call",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    workspace_id: text()
      .notNull()
      .references(() => WorkspaceTable.id, { onDelete: "cascade" }),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    job_id: text()
      .notNull()
      .references(() => JobTable.id, { onDelete: "cascade" }),
    tool: text().notNull(),
    status: text().notNull().$type<CloudSchema.ToolCall["status"]>(),
    duration_ms: integer(),
    error: text(),
    estimated_cost_usd: real(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_tool_call_tenant_idx").on(table.tenant_id),
    index("cloud_tool_call_job_idx").on(table.job_id),
    index("cloud_tool_call_tool_idx").on(table.tool),
  ],
)

export const AuditEventTable = sqliteTable(
  "cloud_audit_event",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    user_id: text().references(() => UserTable.id, { onDelete: "set null" }),
    resource_type: text().notNull(),
    resource_id: text().notNull(),
    action: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("cloud_audit_event_tenant_idx").on(table.tenant_id),
    index("cloud_audit_event_user_idx").on(table.user_id),
    index("cloud_audit_event_resource_idx").on(table.resource_type, table.resource_id),
  ],
)

export const APIKeyTable = sqliteTable(
  "cloud_api_key",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    prefix: text().notNull(),
    hash: text().notNull(),
    scopes: text({ mode: "json" }).notNull().$type<string[]>(),
    time_revoked: integer(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_api_key_tenant_idx").on(table.tenant_id),
    index("cloud_api_key_prefix_idx").on(table.prefix),
  ],
)

export const WebhookSubscriptionTable = sqliteTable(
  "cloud_webhook_subscription",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    url: text().notNull(),
    secret_ref: text().notNull(),
    events: text({ mode: "json" }).notNull().$type<string[]>(),
    enabled: integer({ mode: "boolean" }).notNull(),
    ...Timestamps,
  },
  (table) => [index("cloud_webhook_subscription_tenant_idx").on(table.tenant_id)],
)

export const LLMCredentialTable = sqliteTable(
  "cloud_llm_credential",
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => TenantTable.id, { onDelete: "cascade" }),
    scope: text().notNull().$type<CloudSchema.LLMCredential["scope"]>(),
    owner_key: text().notNull(),
    name: text().notNull(),
    provider_type: text().notNull(),
    provider: text().notNull(),
    base_url: text(),
    secret_ref: text().notNull(),
    allowed_models: text({ mode: "json" }).notNull().$type<string[]>(),
    default_model: text().notNull(),
    enabled: integer({ mode: "boolean" }).notNull(),
    version: integer().notNull(),
    last_used_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("cloud_llm_credential_tenant_idx").on(table.tenant_id),
    index("cloud_llm_credential_owner_idx").on(table.tenant_id, table.scope, table.owner_key),
  ],
)

export * as CloudSQL from "./cloud.sql"
