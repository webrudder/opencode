import { describe, expect, test } from "bun:test"
import { CloudDatabaseAdapter } from "../../src/cloud/database-adapter"
import { CloudEvent } from "../../src/cloud/event"
import { CloudPostgresRunner } from "../../src/cloud/postgres-runner"
import { CloudRepository } from "../../src/cloud/repository"

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

function setup(input?: { failOn?: string }) {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    client: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        if (input?.failOn && sql.startsWith(input.failOn)) throw new Error(`failed ${input.failOn}`)
        return { rowCount: 1 }
      },
    },
  }
}

describe("CloudPostgresRunner", () => {
  test("executes provider-neutral insert transactions with PostgreSQL placeholders", async () => {
    const subject = setup()

    const result = await CloudPostgresRunner.run({
      client: subject.client,
      operations: CloudDatabaseAdapter.transaction({
        mutations: CloudRepository.createJobTransaction({
          job,
          event: CloudEvent.status({ jobID: job.id, sequence: 1, status: "queued", time: 10 }),
        }),
      }),
    })

    expect(result).toEqual({ writes: 2, committed: true })
    expect(subject.calls.map((call) => call.sql)).toEqual([
      "begin",
      "insert into cloud_job (id, tenant_id, workspace_id, session_id, status, runtime, job_spec, cost, error, time_created, time_updated) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      "insert into cloud_job_event (id, job_id, sequence, type, data, time_created) values ($1, $2, $3, $4, $5, $6)",
      "commit",
    ])
    expect(subject.calls[1]?.params).toEqual([
      job.id,
      job.tenantID,
      job.workspaceID,
      job.sessionID,
      "queued",
      JSON.stringify(job.runtime),
      null,
      JSON.stringify(job.cost),
      null,
      10,
      10,
    ])
    expect(subject.calls[2]?.params).toContain(JSON.stringify({ status: "queued" }))
  })

  test("executes updates and deletes inside one transaction", async () => {
    const subject = setup()

    const result = await CloudPostgresRunner.run({
      client: subject.client,
      operations: CloudDatabaseAdapter.transaction({
        mutations: CloudRepository.cancelJobTransaction({
          job: { ...job, status: "canceled", time: { created: 10, updated: 20 } },
          event: CloudEvent.status({ jobID: job.id, sequence: 2, status: "canceled", time: 20 }),
        }),
      }),
    })

    expect(result).toEqual({ writes: 3, committed: true })
    expect(subject.calls[1]?.sql).toStartWith("update cloud_job set id = $1, tenant_id = $2")
    expect(subject.calls[1]?.sql).toEndWith("where id = $12 and tenant_id = $13")
    expect(subject.calls[3]).toEqual({
      sql: "delete from cloud_job_lease where job_id = $1",
      params: [job.id],
    })
  })

  test("rolls back failed transaction plans", async () => {
    const subject = setup()

    const result = await CloudPostgresRunner.run({
      client: subject.client,
      operations: CloudDatabaseAdapter.failed({
        reason: "test rollback",
        mutations: CloudRepository.createJobTransaction({
          job,
          event: CloudEvent.status({ jobID: job.id, sequence: 1, status: "queued", time: 10 }),
        }),
      }),
    })

    expect(result).toEqual({ writes: 2, committed: false })
    expect(subject.calls.at(-1)).toEqual({ sql: "rollback", params: [] })
  })

  test("rejects unsafe SQL identifiers before executing writes", async () => {
    const subject = setup()

    await expect(
      CloudPostgresRunner.run({
        client: subject.client,
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
    ).rejects.toThrow("Unsafe PostgreSQL identifier")
    expect(subject.calls).toEqual([{ sql: "begin", params: [] }])
  })
})
