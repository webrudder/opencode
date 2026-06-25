import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { CloudDatabaseAdapter } from "../../src/cloud/database-adapter"
import { CloudEvent } from "../../src/cloud/event"
import { CloudRepository } from "../../src/cloud/repository"
import { CloudRuntime } from "../../src/cloud/runtime"
import { CloudSQLiteRepository } from "../../src/cloud/sqlite-repository"
import { CloudSQLiteRunner } from "../../src/cloud/sqlite-runner"
import { CloudSQLiteSchema } from "../../src/cloud/sqlite-schema"

const cost = {
  estimatedUSD: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
}
const runtime = {
  engine: "opencode" as const,
  version: "1.14.28",
  image: "cloud-runtime-opencode:1.14.28",
  profile: "standard" as const,
}
const job = {
  id: "job_abc",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  status: "queued" as const,
  runtime,
  cost,
  time: { created: 10, updated: 10 },
}
const spec = CloudRuntime.decodeJobSpec({
  id: job.id,
  tenantID: job.tenantID,
  workspaceID: job.workspaceID,
  sessionID: job.sessionID,
  runtime,
  model: { provider: "anthropic", model: "claude-sonnet-4-5" },
  tools: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false }, mcp: {}, skills: [] },
  permissions: { filesystem: "workspace_only", shell: "restricted", network: ["storage.internal"] },
  inputs: [],
  outputs: ["md"],
})

function setup() {
  const db = new Database(":memory:")
  CloudSQLiteSchema.apply({ db })
  CloudSQLiteRunner.run({
    db,
    operations: CloudDatabaseAdapter.transaction({
      mutations: CloudRepository.createJobTransaction({
        job,
        spec,
        event: CloudEvent.status({ jobID: job.id, sequence: 1, status: "queued", time: 10 }),
      }),
    }),
  })
  db.query(
    "insert into cloud_message (id, tenant_id, workspace_id, session_id, job_id, role, content, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("message_abc", job.tenantID, job.workspaceID, job.sessionID, job.id, "user", "Analyze this", 11, 11)
  return db
}

describe("CloudSQLiteRepository", () => {
  test("lists queued jobs for a tenant in creation order", () => {
    const db = setup()
    db.query(
      "insert into cloud_job (id, tenant_id, workspace_id, session_id, status, runtime, cost, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "job_done",
      job.tenantID,
      job.workspaceID,
      job.sessionID,
      "succeeded",
      JSON.stringify(runtime),
      JSON.stringify(cost),
      11,
      11,
    )
    db.query(
      "insert into cloud_job (id, tenant_id, workspace_id, session_id, status, runtime, cost, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "job_other",
      "tenant_other",
      "workspace_other",
      "session_other",
      "queued",
      JSON.stringify(runtime),
      JSON.stringify(cost),
      1,
      1,
    )

    expect(CloudSQLiteRepository.listQueuedJobs({ db, tenantID: job.tenantID }).map((item) => item.id)).toEqual([
      job.id,
    ])
  })

  test("reads job spec and prompt from persisted rows", () => {
    const db = setup()

    expect(CloudSQLiteRepository.getJobSpec({ db, tenantID: job.tenantID, id: job.id })).toEqual(spec)
    expect(CloudSQLiteRepository.getJobPrompt({ db, tenantID: job.tenantID, jobID: job.id })?.prompt).toBe(
      "Analyze this",
    )
    expect(CloudSQLiteRepository.getJobSpec({ db, tenantID: "tenant_other", id: job.id })).toBeUndefined()
    expect(CloudSQLiteRepository.getJobPrompt({ db, tenantID: "tenant_other", jobID: job.id })).toBeUndefined()
  })

  test("streams job events and reads active leases", () => {
    const db = setup()
    db.query("insert into cloud_job_lease (job_id, worker_id, expires_at, heartbeat_at) values (?, ?, ?, ?)").run(
      job.id,
      "worker_abc",
      100,
      20,
    )

    expect(CloudSQLiteRepository.listEvents({ db, jobID: job.id }).map((event) => event.id)).toEqual([
      "job_abc:000000000001",
    ])
    expect(CloudSQLiteRepository.getLease({ db, jobID: job.id })).toEqual({
      jobID: job.id,
      workerID: "worker_abc",
      expiresAt: 100,
      heartbeatAt: 20,
    })
  })
})
