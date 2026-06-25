import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { CloudDatabaseAdapter } from "../../src/cloud/database-adapter"
import { CloudEvent } from "../../src/cloud/event"
import { CloudRepository } from "../../src/cloud/repository"
import { CloudRuntime } from "../../src/cloud/runtime"
import { CloudSQLiteRunner } from "../../src/cloud/sqlite-runner"
import { CloudSQLiteSchema } from "../../src/cloud/sqlite-schema"
import { CloudSQLiteWorkerLoop } from "../../src/cloud/sqlite-worker-loop"

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

function setup(input?: { withJob?: boolean }) {
  const db = new Database(":memory:")
  CloudSQLiteSchema.apply({ db })
  if (input?.withJob === false) return db
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
  ).run("message_abc", job.tenantID, job.workspaceID, job.sessionID, job.id, "user", "Analyze with SQLite", 11, 11)
  return db
}

describe("CloudSQLiteWorkerLoop", () => {
  test("returns idle when SQLite has no queued jobs", () => {
    expect(
      CloudSQLiteWorkerLoop.tick({
        db: setup({ withJob: false }),
        tenantID: job.tenantID,
        workerID: "worker_abc",
        leaseTTLMS: 1000,
        now: () => 100,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
      }),
    ).toEqual({ status: "idle" })
  })

  test("leases a queued SQLite job and persists worker start state", () => {
    const db = setup()
    const result = CloudSQLiteWorkerLoop.tick({
      db,
      tenantID: job.tenantID,
      workerID: "worker_abc",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
    })

    expect(result).toMatchObject({
      status: "started",
      jobID: job.id,
      lease: { jobID: job.id, workerID: "worker_abc", expiresAt: 1100, heartbeatAt: 100 },
      launch: {
        command: "opencode",
        args: ["run", "Analyze with SQLite"],
        cwd: "/sandbox/job_abc/work",
      },
    })
    expect(db.query("select status, job_spec from cloud_job where id = ?").get(job.id)).toEqual({
      status: "leasing",
      job_spec: JSON.stringify(spec),
    })
    expect(db.query("select worker_id, expires_at, heartbeat_at from cloud_job_lease where job_id = ?").get(job.id)).toEqual({
      worker_id: "worker_abc",
      expires_at: 1100,
      heartbeat_at: 100,
    })
    expect(db.query("select status, attempt from cloud_job_attempt where job_id = ?").get(job.id)).toEqual({
      status: "running",
      attempt: 1,
    })
    expect(db.query("select sequence, data from cloud_job_event where id = ?").get("job_abc:000000000002")).toEqual({
      sequence: 2,
      data: JSON.stringify({ status: "leasing" }),
    })
  })

  test("heartbeats an active SQLite lease and records an event", () => {
    const db = setup()
    db.query("insert into cloud_job_lease (job_id, worker_id, expires_at, heartbeat_at) values (?, ?, ?, ?)").run(
      job.id,
      "worker_abc",
      200,
      100,
    )

    expect(
      CloudSQLiteWorkerLoop.heartbeat({
        db,
        workerID: "worker_abc",
        leaseTTLMS: 1000,
        now: () => 300,
        jobID: job.id,
      }),
    ).toEqual({ jobID: job.id, workerID: "worker_abc", expiresAt: 1300, heartbeatAt: 300 })
    expect(db.query("select expires_at, heartbeat_at from cloud_job_lease where job_id = ?").get(job.id)).toEqual({
      expires_at: 1300,
      heartbeat_at: 300,
    })
    expect(db.query("select type, data from cloud_job_event where id = ?").get("job_abc:000000000002")).toEqual({
      type: "job.heartbeat",
      data: JSON.stringify({}),
    })
  })

  test("completes a leased SQLite job with artifacts and terminal events", () => {
    const db = setup()
    CloudSQLiteWorkerLoop.tick({
      db,
      tenantID: job.tenantID,
      workerID: "worker_abc",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
    })

    const result = CloudSQLiteWorkerLoop.completeJob({
      db,
      tenantID: job.tenantID,
      jobID: job.id,
      now: () => 200,
      manifest: {
        version: 1,
        jobID: job.id,
        artifacts: [{ name: "report.md", path: "report.md", kind: "md", mime: "text/markdown", sha256: "abc" }],
      },
      objectKeyPrefix: "tenant_abc/job_abc",
      sizeByPath: { "report.md": 100 },
    })

    expect(result.job.status).toBe("succeeded")
    expect(result.artifacts.map((artifact) => artifact.objectKey)).toEqual(["tenant_abc/job_abc/report.md"])
    expect(db.query("select status from cloud_job where id = ?").get(job.id)).toEqual({ status: "succeeded" })
    expect(db.query("select status from cloud_job_attempt where job_id = ?").get(job.id)).toEqual({
      status: "succeeded",
    })
    expect(db.query("select count(*) as count from cloud_job_lease where job_id = ?").get(job.id)).toEqual({
      count: 0,
    })
    expect(
      db
        .query("select type from cloud_job_event where job_id = ? order by sequence")
        .all(job.id)
        .map((row) => (row as { type: string }).type),
    ).toEqual([
      "job.status",
      "job.status",
      "job.status",
      "job.status",
      "job.status",
      "job.artifact",
      "job.status",
    ])
  })

  test("fails a leased SQLite job with error state and terminal event", () => {
    const db = setup()
    CloudSQLiteWorkerLoop.tick({
      db,
      tenantID: job.tenantID,
      workerID: "worker_abc",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
    })

    const result = CloudSQLiteWorkerLoop.failJob({
      db,
      tenantID: job.tenantID,
      jobID: job.id,
      message: "provider timeout",
      now: () => 300,
    })

    expect(result.status).toBe("failed")
    expect(db.query("select status, error from cloud_job where id = ?").get(job.id)).toEqual({
      status: "failed",
      error: "provider timeout",
    })
    expect(db.query("select status, error from cloud_job_attempt where job_id = ?").get(job.id)).toEqual({
      status: "failed",
      error: "provider timeout",
    })
    expect(db.query("select count(*) as count from cloud_job_lease where job_id = ?").get(job.id)).toEqual({
      count: 0,
    })
    expect(
      db
        .query("select type from cloud_job_event where job_id = ? order by sequence")
        .all(job.id)
        .map((row) => (row as { type: string }).type),
    ).toEqual(["job.status", "job.status", "job.error", "job.status"])
  })

  test("expires a leased SQLite job after execution timeout", () => {
    const db = setup()
    CloudSQLiteWorkerLoop.tick({
      db,
      tenantID: job.tenantID,
      workerID: "worker_abc",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
    })

    const result = CloudSQLiteWorkerLoop.expireJob({
      db,
      tenantID: job.tenantID,
      jobID: job.id,
      message: "execution timeout",
      now: () => 300,
    })

    expect(result.status).toBe("expired")
    expect(db.query("select status, error from cloud_job where id = ?").get(job.id)).toEqual({
      status: "expired",
      error: "execution timeout",
    })
    expect(db.query("select status, error from cloud_job_attempt where job_id = ?").get(job.id)).toEqual({
      status: "failed",
      error: "execution timeout",
    })
    expect(db.query("select count(*) as count from cloud_job_lease where job_id = ?").get(job.id)).toEqual({
      count: 0,
    })
  })

  test("cancels a leased SQLite job and active attempt", () => {
    const db = setup()
    CloudSQLiteWorkerLoop.tick({
      db,
      tenantID: job.tenantID,
      workerID: "worker_abc",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
    })

    const result = CloudSQLiteWorkerLoop.cancelJob({
      db,
      tenantID: job.tenantID,
      jobID: job.id,
      message: "user canceled",
      now: () => 300,
    })

    expect(result.status).toBe("canceled")
    expect(db.query("select status, error from cloud_job where id = ?").get(job.id)).toEqual({
      status: "canceled",
      error: "user canceled",
    })
    expect(db.query("select status, error from cloud_job_attempt where job_id = ?").get(job.id)).toEqual({
      status: "canceled",
      error: "user canceled",
    })
    expect(db.query("select count(*) as count from cloud_job_lease where job_id = ?").get(job.id)).toEqual({
      count: 0,
    })
  })
})
