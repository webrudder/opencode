import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { CloudDatabaseAdapter } from "../../src/cloud/database-adapter"
import { CloudEvent } from "../../src/cloud/event"
import { CloudRepository } from "../../src/cloud/repository"
import { CloudSQLiteRunner } from "../../src/cloud/sqlite-runner"

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

function setup() {
  const db = new Database(":memory:")
  db.exec(`
    create table cloud_job (
      id text primary key,
      tenant_id text not null,
      workspace_id text not null,
      session_id text not null,
      status text not null,
      runtime text not null,
      job_spec text,
      cost text not null,
      error text,
      time_created integer not null,
      time_updated integer not null
    );
    create table cloud_job_event (
      id text primary key,
      job_id text not null,
      sequence integer not null,
      type text not null,
      data text not null,
      time_created integer not null
    );
    create table cloud_job_lease (
      job_id text primary key,
      worker_id text not null,
      expires_at integer not null,
      heartbeat_at integer not null
    );
  `)
  return db
}

describe("CloudSQLiteRunner", () => {
  test("executes provider-neutral insert transactions with JSON values", () => {
    const db = setup()

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
    expect(db.query("select status, runtime, cost from cloud_job where id = ?").get(job.id)).toEqual({
      status: "queued",
      runtime: JSON.stringify(job.runtime),
      cost: JSON.stringify(job.cost),
    })
    expect(db.query("select sequence, data from cloud_job_event where id = ?").get("job_abc:000000000001")).toEqual({
      sequence: 1,
      data: JSON.stringify({ status: "queued" }),
    })
  })

  test("executes updates and deletes inside one transaction", () => {
    const db = setup()
    db.query(
      "insert into cloud_job (id, tenant_id, workspace_id, session_id, status, runtime, cost, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      job.id,
      job.tenantID,
      job.workspaceID,
      job.sessionID,
      job.status,
      JSON.stringify(job.runtime),
      JSON.stringify(job.cost),
      job.time.created,
      job.time.updated,
    )
    db.query("insert into cloud_job_lease (job_id, worker_id, expires_at, heartbeat_at) values (?, ?, ?, ?)").run(
      job.id,
      "worker_abc",
      100,
      10,
    )

    const result = CloudSQLiteRunner.run({
      db,
      operations: CloudDatabaseAdapter.transaction({
        mutations: CloudRepository.cancelJobTransaction({
          job: { ...job, status: "canceled", time: { created: 10, updated: 20 } },
          event: CloudEvent.status({ jobID: job.id, sequence: 2, status: "canceled", time: 20 }),
        }),
      }),
    })

    expect(result).toEqual({ writes: 3, committed: true })
    expect(db.query("select status, time_updated from cloud_job where id = ?").get(job.id)).toEqual({
      status: "canceled",
      time_updated: 20,
    })
    expect(db.query("select count(*) as count from cloud_job_lease").get()).toEqual({ count: 0 })
  })

  test("rejects unsafe SQL identifiers before executing writes", () => {
    const db = setup()

    expect(() =>
      CloudSQLiteRunner.run({
        db,
        operations: [
          { action: "begin", isolation: "immediate" },
          {
            action: "write",
            table: "cloud_job; drop table cloud_job",
            mutation: "insert",
            key: { id: job.id },
            values: { id: job.id },
            conflict: "error",
          },
          { action: "commit" },
        ],
      }),
    ).toThrow("Unsafe SQLite identifier")
    expect(db.query("select count(*) as count from cloud_job").get()).toEqual({ count: 0 })
  })
})
