import { describe, expect, test } from "bun:test"
import { CloudPostgresSchema } from "../../src/cloud/postgres-schema"

function setup() {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    client: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        return { rowCount: 0 }
      },
    },
  }
}

describe("CloudPostgresSchema", () => {
  test("applies the cloud runtime schema through a generic PostgreSQL query client", async () => {
    const subject = setup()

    const result = await CloudPostgresSchema.apply({ client: subject.client })

    expect(result.tables).toContain("cloud_job")
    expect(result.tables).toContain("cloud_job_event")
    expect(result.tables).toContain("cloud_queue_message")
    expect(result.tables).toContain("cloud_runtime_worker")
    expect(result.tables).toContain("cloud_session_runtime_binding")
    expect(result.tables).toContain("cloud_integrator_runtime_policy")
    expect(result.indexes).toContain("cloud_job_tenant_status_idx")
    expect(result.indexes).toContain("cloud_queue_message_visible_idx")
    expect(result.indexes).toContain("cloud_runtime_worker_tenant_status_idx")
    expect(result.indexes).toContain("cloud_session_runtime_binding_runtime_idx")
    expect(result.indexes).toContain("cloud_integrator_runtime_policy_tenant_idx")
    expect(subject.calls.at(0)?.sql).toBe("select pg_advisory_lock(8213477)")
    expect(subject.calls.at(1)?.sql).toStartWith("create table if not exists cloud_tenant")
    expect(subject.calls.at(-1)?.sql).toBe("select pg_advisory_unlock(8213477)")
    expect(subject.calls.map((call) => call.sql)).toContain(
      "create index if not exists cloud_job_tenant_status_idx on cloud_job (tenant_id, status)",
    )
  })

  test("uses PostgreSQL-safe durable column types for JSON, time, cost, and booleans", async () => {
    const subject = setup()

    await CloudPostgresSchema.apply({ client: subject.client })

    expect(subject.calls.find((call) => call.sql.startsWith("create table if not exists cloud_job"))?.sql).toContain(
      "runtime jsonb not null",
    )
    expect(subject.calls.find((call) => call.sql.startsWith("create table if not exists cloud_runtime_worker"))?.sql).toContain(
      "metrics jsonb not null",
    )
    expect(subject.calls.find((call) => call.sql.startsWith("create table if not exists cloud_tool_call"))?.sql).toContain(
      "estimated_cost_usd double precision",
    )
    expect(
      subject.calls.find((call) => call.sql.startsWith("create table if not exists cloud_webhook_subscription"))?.sql,
    ).toContain("enabled boolean not null")
    expect(subject.calls.every((call) => call.params.length === 0)).toBe(true)
  })

  test("releases the schema advisory lock when schema application fails", async () => {
    const calls: { sql: string; params: unknown[] }[] = []
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        if (sql.startsWith("create table if not exists cloud_tenant")) throw new Error("schema failed")
        return { rowCount: 0 }
      },
    }

    await expect(CloudPostgresSchema.apply({ client })).rejects.toThrow("schema failed")
    expect(calls.at(0)?.sql).toBe("select pg_advisory_lock(8213477)")
    expect(calls.at(-1)?.sql).toBe("select pg_advisory_unlock(8213477)")
  })
})
