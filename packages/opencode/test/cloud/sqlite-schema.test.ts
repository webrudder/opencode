import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { CloudDatabaseAdapter } from "../../src/cloud/database-adapter"
import { CloudEvent } from "../../src/cloud/event"
import { CloudRepository } from "../../src/cloud/repository"
import { CloudSQLiteRunner } from "../../src/cloud/sqlite-runner"
import { CloudSQLiteSchema } from "../../src/cloud/sqlite-schema"

const job = {
  id: "job_abc",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  status: "queued" as const,
  runtime: { engine: "opencode" as const, version: "1.14.28", profile: "standard" as const },
  cost: {
    estimatedUSD: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  },
  time: { created: 10, updated: 10 },
}

describe("CloudSQLiteSchema", () => {
  test("applies the local cloud runtime schema to a real SQLite database", () => {
    const db = new Database(":memory:")

    const result = CloudSQLiteSchema.apply({ db })

    expect(result.tables).toContain("cloud_job")
    expect(result.tables).toContain("cloud_job_event")
    expect(result.tables).toContain("cloud_runtime_worker")
    expect(result.tables).toContain("cloud_session_runtime_binding")
    expect(result.tables).toContain("cloud_integrator_runtime_policy")
    expect(result.indexes).toContain("cloud_job_tenant_status_idx")
    expect(result.indexes).toContain("cloud_runtime_worker_tenant_status_idx")
    expect(result.indexes).toContain("cloud_session_runtime_binding_runtime_idx")
    expect(result.indexes).toContain("cloud_integrator_runtime_policy_tenant_idx")
    expect(db.query("select name from sqlite_master where type = 'table' and name = ?").get("cloud_artifact")).toEqual({
      name: "cloud_artifact",
    })
  })

  test("supports repository transactions after schema bootstrap", () => {
    const db = new Database(":memory:")
    CloudSQLiteSchema.apply({ db })

    const result = CloudSQLiteRunner.run({
      db,
      operations: CloudDatabaseAdapter.transaction({
        mutations: CloudRepository.createJobTransaction({
          job,
          event: CloudEvent.status({ jobID: job.id, sequence: 1, status: "queued", time: 10 }),
        }),
      }),
    })

    expect(result).toEqual({ writes: 2, committed: true })
    expect(db.query("select id, status from cloud_job where id = ?").get(job.id)).toEqual({
      id: "job_abc",
      status: "queued",
    })
  })

  test("can be applied more than once without dropping existing data", () => {
    const db = new Database(":memory:")
    CloudSQLiteSchema.apply({ db })
    CloudSQLiteRunner.run({
      db,
      operations: CloudDatabaseAdapter.transaction({
        mutations: CloudRepository.createJobTransaction({
          job,
          event: CloudEvent.status({ jobID: job.id, sequence: 1, status: "queued", time: 10 }),
        }),
      }),
    })

    CloudSQLiteSchema.apply({ db })

    expect(db.query("select count(*) as count from cloud_job").get()).toEqual({ count: 1 })
  })
})
