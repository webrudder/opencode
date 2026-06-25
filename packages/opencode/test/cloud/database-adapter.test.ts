import { describe, expect, test } from "bun:test"
import { CloudDatabaseAdapter } from "../../src/cloud/database-adapter"
import { CloudEvent } from "../../src/cloud/event"
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

describe("CloudDatabaseAdapter", () => {
  test("wraps repository mutations in a provider-neutral transaction", () => {
    expect(
      CloudDatabaseAdapter.transaction({
        mutations: CloudRepository.createJobTransaction({
          job,
          event: CloudEvent.status({ jobID: "job_abc", sequence: 1, status: "queued", time: 10 }),
        }),
      }),
    ).toMatchObject([
      { action: "begin", isolation: "immediate" },
      {
        action: "write",
        table: "cloud_job",
        mutation: "insert",
        key: { id: "job_abc" },
        conflict: "error",
      },
      {
        action: "write",
        table: "cloud_job_event",
        mutation: "insert",
        key: { id: "job_abc:000000000001" },
        conflict: "error",
      },
      { action: "commit" },
    ])
  })

  test("supports conflict mode and rollback planning", () => {
    const mutations = CloudRepository.cancelJobTransaction({
      job: { ...job, status: "canceled", time: { created: 10, updated: 20 } },
      event: CloudEvent.status({ jobID: "job_abc", sequence: 2, status: "canceled", time: 20 }),
    })

    expect(CloudDatabaseAdapter.transaction({ mutations, conflict: "replace" })[1]).toMatchObject({
      action: "write",
      table: "cloud_job",
      mutation: "update",
      conflict: "replace",
    })
    expect(CloudDatabaseAdapter.failed({ mutations, reason: "deadlock" }).at(-1)).toEqual({
      action: "rollback",
      reason: "deadlock",
    })
  })

  test("summarizes touched tables for audit and metrics", () => {
    expect(
      CloudDatabaseAdapter.tables({
        mutations: CloudRepository.cancelJobTransaction({
          job: { ...job, status: "canceled", time: { created: 10, updated: 20 } },
          event: CloudEvent.status({ jobID: "job_abc", sequence: 2, status: "canceled", time: 20 }),
        }),
      }),
    ).toEqual(["cloud_job", "cloud_job_event", "cloud_job_lease"])
  })
})
