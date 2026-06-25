import { describe, expect, test } from "bun:test"
import { getTableName } from "drizzle-orm"
import { CloudSQL } from "../../src/cloud/cloud.sql"

describe("CloudSQL", () => {
  test("defines durable cloud runtime tables without reusing local opencode session tables", () => {
    expect(
      [
        CloudSQL.TenantTable,
        CloudSQL.UserTable,
        CloudSQL.WorkspaceTable,
        CloudSQL.SessionTable,
        CloudSQL.FileTable,
        CloudSQL.JobTable,
        CloudSQL.MessageTable,
        CloudSQL.ArtifactTable,
        CloudSQL.RuntimeInstanceTable,
        CloudSQL.RuntimeWorkerTable,
        CloudSQL.SessionRuntimeBindingTable,
        CloudSQL.JobLeaseTable,
        CloudSQL.JobAttemptTable,
        CloudSQL.JobEventTable,
        CloudSQL.EventCheckpointTable,
        CloudSQL.ToolCallTable,
        CloudSQL.AuditEventTable,
        CloudSQL.APIKeyTable,
        CloudSQL.WebhookSubscriptionTable,
      ].map(getTableName),
    ).toEqual([
      "cloud_tenant",
      "cloud_user",
      "cloud_workspace",
      "cloud_session",
      "cloud_file",
      "cloud_job",
      "cloud_message",
      "cloud_artifact",
      "cloud_runtime_instance",
      "cloud_runtime_worker",
      "cloud_session_runtime_binding",
      "cloud_job_lease",
      "cloud_job_attempt",
      "cloud_job_event",
      "cloud_event_checkpoint",
      "cloud_tool_call",
      "cloud_audit_event",
      "cloud_api_key",
      "cloud_webhook_subscription",
    ])
  })

  test("keeps tenant and job boundary columns explicit on operational tables", () => {
    expect(CloudSQL.JobTable.tenant_id.name).toBe("tenant_id")
    expect(CloudSQL.JobTable.status.name).toBe("status")
    expect(CloudSQL.ArtifactTable.object_key.name).toBe("object_key")
    expect(CloudSQL.JobAttemptTable.worker_id.name).toBe("worker_id")
    expect(CloudSQL.ToolCallTable.estimated_cost_usd.name).toBe("estimated_cost_usd")
    expect(CloudSQL.RuntimeWorkerTable.max_active_jobs.name).toBe("max_active_jobs")
    expect(CloudSQL.SessionRuntimeBindingTable.runtime_id.name).toBe("runtime_id")
  })
})
