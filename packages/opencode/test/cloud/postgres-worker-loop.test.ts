import { describe, expect, test } from "bun:test"
import { CloudPostgresWorkerLoop } from "../../src/cloud/postgres-worker-loop"
import { CloudRuntime } from "../../src/cloud/runtime"

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
  tenant_id: "tenant_abc",
  workspace_id: "workspace_abc",
  session_id: "session_abc",
  status: "queued",
  runtime,
  cost,
  error: null,
  time_created: 10,
  time_updated: 10,
}
const spec = CloudRuntime.decodeJobSpec({
  id: job.id,
  tenantID: job.tenant_id,
  workspaceID: job.workspace_id,
  sessionID: job.session_id,
  runtime,
  model: { provider: "anthropic", model: "claude-sonnet-4-5" },
  tools: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false }, mcp: {}, skills: [] },
  permissions: { filesystem: "workspace_only", shell: "restricted", network: ["storage.internal"] },
  inputs: [],
  outputs: ["md"],
})

function setup(responses: Record<string, Record<string, unknown>[]>) {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    client: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        return sql.startsWith("select") ? { rows: responses[sql] ?? [] } : { rowCount: 1 }
      },
    },
  }
}

describe("CloudPostgresWorkerLoop", () => {
  test("returns idle when PostgreSQL has no queued jobs", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and status = 'queued' order by time_created, id": [],
    })

    expect(
      await CloudPostgresWorkerLoop.tick({
        client: subject.client,
        tenantID: job.tenant_id,
        workerID: "worker_abc",
        leaseTTLMS: 1000,
        now: () => 100,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
      }),
    ).toEqual({ status: "idle" })
  })

  test("leases a queued PostgreSQL job and persists worker start state", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and status = 'queued' order by time_created, id": [job],
      "select job_spec from cloud_job where tenant_id = $1 and id = $2": [{ job_spec: spec }],
      "select * from cloud_message where tenant_id = $1 and job_id = $2 and role = 'user' order by time_created desc, id desc limit 1":
        [
          {
            id: "message_abc",
            tenant_id: job.tenant_id,
            workspace_id: job.workspace_id,
            session_id: job.session_id,
            job_id: job.id,
            role: "user",
            content: "Analyze with Postgres",
            time_created: 11,
            time_updated: 11,
          },
        ],
      "select * from cloud_job_lease where job_id = $1": [],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_abc:000000000001",
          job_id: job.id,
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: 10,
        },
      ],
      "select count(*) as count from cloud_job_attempt where job_id = $1": [{ count: 0 }],
    })

    const result = await CloudPostgresWorkerLoop.tick({
      client: subject.client,
      tenantID: job.tenant_id,
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
        args: ["run", "Analyze with Postgres"],
        cwd: "/sandbox/job_abc/work",
      },
    })
    expect(subject.calls.map((call) => call.sql)).toContain("begin")
    expect(subject.calls.map((call) => call.sql)).toContain(
      "update cloud_job set status = $1, time_updated = $2 where id = $3 and tenant_id = $4",
    )
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_job_lease"))?.params).toEqual([
      job.id,
      "worker_abc",
      1100,
      100,
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_job_event"))?.params).toContain(
      JSON.stringify({ status: "leasing" }),
    )
    expect(subject.calls.at(-1)?.sql).toBe("commit")
  })

  test("skips queued jobs whose session already has a running attempt", async () => {
    const blocked = {
      ...job,
      id: "job_blocked",
      session_id: "session_busy",
    }
    const runnable = {
      ...job,
      id: "job_runnable",
      session_id: "session_free",
      time_created: 11,
    }
    const runnableSpec = CloudRuntime.decodeJobSpec({
      ...spec,
      id: runnable.id,
      sessionID: runnable.session_id,
    })
    const responses: Record<string, Record<string, unknown>[]> = {
      "select * from cloud_job where tenant_id = $1 and status = 'queued' order by time_created, id": [blocked, runnable],
      "select job_spec from cloud_job where tenant_id = $1 and id = $2": [{ job_spec: runnableSpec }],
      "select * from cloud_message where tenant_id = $1 and job_id = $2 and role = 'user' order by time_created desc, id desc limit 1":
        [
          {
            id: "message_runnable",
            tenant_id: job.tenant_id,
            workspace_id: job.workspace_id,
            session_id: runnable.session_id,
            job_id: runnable.id,
            role: "user",
            content: "Run free session",
            time_created: 12,
            time_updated: 12,
          },
        ],
      "select * from cloud_job_lease where job_id = $1": [],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [],
      "select count(*) as count from cloud_job_attempt where job_id = $1": [{ count: 0 }],
    }
    const calls: { sql: string; params: unknown[] }[] = []
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        if (
          sql ===
          "select id from cloud_job_attempt where tenant_id = $1 and session_id = $2 and status = 'running' order by time_created desc, id desc limit 1"
        ) {
          return { rows: params?.at(1) === "session_busy" ? [{ id: "attempt_busy" }] : [] }
        }
        return sql.startsWith("select") ? { rows: responses[sql] ?? [] } : { rowCount: 1 }
      },
    }

    const result = await CloudPostgresWorkerLoop.tick({
      client,
      tenantID: job.tenant_id,
      workerID: "worker_abc",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
    })

    expect(result).toMatchObject({
      status: "started",
      jobID: runnable.id,
      attempt: { sessionID: runnable.session_id },
      launch: { cwd: "/sandbox/job_runnable/work" },
    })
  })

  test("leases queued PostgreSQL jobs through a queue client before mutating job state", async () => {
    const queueCalls: unknown[] = []
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and status = 'queued' order by time_created, id": [job],
      "select job_spec from cloud_job where tenant_id = $1 and id = $2": [{ job_spec: spec }],
      "select * from cloud_message where tenant_id = $1 and job_id = $2 and role = 'user' order by time_created desc, id desc limit 1":
        [
          {
            id: "message_abc",
            tenant_id: job.tenant_id,
            workspace_id: job.workspace_id,
            session_id: job.session_id,
            job_id: job.id,
            role: "user",
            content: "Analyze with Postgres queue",
            time_created: 11,
            time_updated: 11,
          },
        ],
      "select * from cloud_job_lease where job_id = $1": [],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_abc:000000000001",
          job_id: job.id,
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: 10,
        },
      ],
      "select count(*) as count from cloud_job_attempt where job_id = $1": [{ count: 0 }],
    })

    expect(
      await CloudPostgresWorkerLoop.tick({
        client: subject.client,
        tenantID: job.tenant_id,
        workerID: "worker_abc",
        leaseTTLMS: 1000,
        now: () => 100,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
        queueClient: {
          lease: async (input) => {
            queueCalls.push(input)
            return { leased: true, leaseToken: "worker_abc:job_abc:1100" }
          },
        },
      }),
    ).toMatchObject({ status: "started", jobID: job.id })
    expect(queueCalls).toEqual([
      {
        queue: "cloud-runtime:standard:tenant_abc",
        tenantID: job.tenant_id,
        jobID: job.id,
        workerID: "worker_abc",
        leaseTTLMS: 1000,
      },
    ])
  })

  test("does not mutate PostgreSQL job state when queue lease is rejected", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and status = 'queued' order by time_created, id": [job],
    })

    expect(
      await CloudPostgresWorkerLoop.tick({
        client: subject.client,
        tenantID: job.tenant_id,
        workerID: "worker_abc",
        leaseTTLMS: 1000,
        now: () => 100,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
        queueClient: {
          lease: async () => ({ leased: false, reason: "leased" }),
        },
      }),
    ).toEqual({ status: "idle", reason: "queue:leased" })
    expect(subject.calls.map((call) => call.sql)).not.toContain(
      "update cloud_job set status = $1, time_updated = $2 where id = $3 and tenant_id = $4",
    )
  })

  test("heartbeats an active PostgreSQL lease and records an event", async () => {
    const subject = setup({
      "select * from cloud_job_lease where job_id = $1": [
        {
          job_id: job.id,
          worker_id: "worker_abc",
          expires_at: 200,
          heartbeat_at: 100,
        },
      ],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_abc:000000000001",
          job_id: job.id,
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: 10,
        },
      ],
    })

    expect(
      await CloudPostgresWorkerLoop.heartbeat({
        client: subject.client,
        workerID: "worker_abc",
        leaseTTLMS: 1000,
        now: () => 300,
        jobID: job.id,
      }),
    ).toEqual({ jobID: job.id, workerID: "worker_abc", expiresAt: 1300, heartbeatAt: 300 })
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job_lease"))?.params).toEqual([
      "worker_abc",
      1300,
      300,
      job.id,
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_job_event"))?.params).toContain(
      JSON.stringify({}),
    )
  })

  test("heartbeats the queue visibility timeout with the PostgreSQL lease", async () => {
    const queueCalls: unknown[] = []
    const subject = setup({
      "select * from cloud_job_lease where job_id = $1": [
        {
          job_id: job.id,
          worker_id: "worker_abc",
          expires_at: 200,
          heartbeat_at: 100,
        },
      ],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [],
    })

    await CloudPostgresWorkerLoop.heartbeat({
      client: subject.client,
      workerID: "worker_abc",
      leaseTTLMS: 1000,
      now: () => 300,
      jobID: job.id,
      queueClient: {
        heartbeat: async (input) => {
          queueCalls.push(input)
          return { extended: true }
        },
      },
    })

    expect(queueCalls).toEqual([
      {
        jobID: job.id,
        workerID: "worker_abc",
        leaseTTLMS: 1000,
        time: 300,
      },
    ])
  })

  test("completes a leased PostgreSQL job with artifacts and terminal events", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_abc:000000000001",
          job_id: job.id,
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: 10,
        },
        {
          id: "job_abc:000000000002",
          job_id: job.id,
          sequence: 2,
          type: "job.status",
          data: { status: "leasing" },
          time_created: 100,
        },
      ],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000001" },
      ],
    })

    const result = await CloudPostgresWorkerLoop.completeJob({
      client: subject.client,
      tenantID: job.tenant_id,
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
    expect(subject.calls.map((call) => call.sql)).toContain(
      "update cloud_job set status = $1, time_updated = $2 where id = $3 and tenant_id = $4",
    )
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job_attempt"))?.params).toEqual([
      "succeeded",
      200,
      "job_abc:attempt:000000000001",
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_artifact"))?.params).toEqual([
      "job_abc:artifact:000000000001",
      job.tenant_id,
      job.workspace_id,
      job.session_id,
      job.id,
      "report.md",
      "md",
      "text/markdown",
      100,
      "tenant_abc/job_abc/report.md",
      "abc",
      200,
      200,
    ])
    expect(subject.calls.filter((call) => call.sql.startsWith("insert into cloud_job_event"))).toHaveLength(5)
    expect(subject.calls.find((call) => call.sql.startsWith("delete from cloud_job_lease"))).toEqual({
      sql: "delete from cloud_job_lease where job_id = $1",
      params: [job.id],
    })
    expect(subject.calls.at(-1)?.sql).toBe("commit")
  })

  test("acknowledges the queue as succeeded after PostgreSQL job completion", async () => {
    const queueCalls: unknown[] = []
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_abc:000000000001",
          job_id: job.id,
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: 10,
        },
      ],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000001" },
      ],
    })

    await CloudPostgresWorkerLoop.completeJob({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      now: () => 200,
      manifest: { version: 1, jobID: job.id, artifacts: [] },
      objectKeyPrefix: "tenant_abc/job_abc",
      sizeByPath: {},
      workerID: "worker_abc",
      queueClient: {
        ack: async (input) => {
          queueCalls.push(input)
          return { acknowledged: true }
        },
      },
    })

    expect(queueCalls).toEqual([
      {
        jobID: job.id,
        workerID: "worker_abc",
        terminalStatus: "succeeded",
        time: 200,
      },
    ])
  })

  test("completes a PostgreSQL job from a Kubernetes sandbox result", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_abc:000000000001",
          job_id: job.id,
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: 10,
        },
      ],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000001" },
      ],
    })

    const result = await CloudPostgresWorkerLoop.completeKubernetesRun({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      now: () => 200,
      objectKeyPrefix: "tenant_abc/job_abc/artifacts",
      result: {
        jobID: job.id,
        podName: "opencode-job-abc",
        status: "succeeded",
        logs: "done",
        podStatus: { phase: "Succeeded", exitCode: 0 },
        manifest: {
          version: 1,
          jobID: job.id,
          artifacts: [{ name: "report.md", path: "report.md", kind: "md", mime: "text/markdown", sha256: "sha_k8s" }],
        },
        sizeByPath: { "report.md": 120 },
      },
    })

    expect(result).toMatchObject({ status: "completed", jobID: job.id })
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_artifact"))?.params).toEqual([
      "job_abc:artifact:000000000001",
      job.tenant_id,
      job.workspace_id,
      job.session_id,
      job.id,
      "report.md",
      "md",
      "text/markdown",
      120,
      "tenant_abc/job_abc/artifacts/report.md",
      "sha_k8s",
      200,
      200,
    ])
  })

  test("acknowledges the queue after PostgreSQL Kubernetes completion", async () => {
    const queueCalls: unknown[] = []
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_abc:000000000001",
          job_id: job.id,
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: 10,
        },
      ],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000001" },
      ],
    })

    await CloudPostgresWorkerLoop.completeKubernetesRun({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      now: () => 200,
      objectKeyPrefix: "tenant_abc/job_abc/artifacts",
      workerID: "worker_abc",
      queueClient: {
        ack: async (input) => {
          queueCalls.push(input)
          return { acknowledged: true }
        },
      },
      result: {
        jobID: job.id,
        podName: "opencode-job-abc",
        status: "succeeded",
        logs: "done",
        podStatus: { phase: "Succeeded", exitCode: 0 },
      },
    })

    expect(queueCalls).toEqual([
      {
        jobID: job.id,
        workerID: "worker_abc",
        terminalStatus: "succeeded",
        time: 200,
      },
    ])
  })

  test("fails a PostgreSQL job from a failed Kubernetes sandbox result", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_abc:000000000001",
          job_id: job.id,
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: 10,
        },
      ],
      "select count(*) as count from cloud_job_attempt where job_id = $1": [{ count: 1 }],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000001" },
      ],
    })

    const result = await CloudPostgresWorkerLoop.completeKubernetesRun({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      now: () => 200,
      objectKeyPrefix: "tenant_abc/job_abc/artifacts",
      result: {
        jobID: job.id,
        podName: "opencode-job-abc",
        status: "failed",
        logs: "runtime failed",
        podStatus: { phase: "Failed", exitCode: 1 },
      },
    })

    expect(result).toMatchObject({ status: "failed", jobID: job.id })
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job set status"))?.params).toEqual([
      "failed",
      "Kubernetes sandbox opencode-job-abc failed: runtime failed",
      200,
      job.id,
      job.tenant_id,
    ])
  })

  test("fails a leased PostgreSQL job with error state and terminal event", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_abc:000000000001",
          job_id: job.id,
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: 10,
        },
        {
          id: "job_abc:000000000002",
          job_id: job.id,
          sequence: 2,
          type: "job.status",
          data: { status: "leasing" },
          time_created: 100,
        },
      ],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000001" },
      ],
    })

    const result = await CloudPostgresWorkerLoop.failJob({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      message: "provider timeout",
      now: () => 300,
    })

    expect(result.status).toBe("failed")
    expect(result.error).toBe("provider timeout")
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job "))?.params).toEqual([
      "failed",
      "provider timeout",
      300,
      job.id,
      job.tenant_id,
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job_attempt"))?.params).toEqual([
      "failed",
      "provider timeout",
      300,
      "job_abc:attempt:000000000001",
    ])
    expect(subject.calls.filter((call) => call.sql.startsWith("insert into cloud_job_event"))).toHaveLength(2)
    expect(subject.calls.find((call) => call.sql.startsWith("delete from cloud_job_lease"))?.params).toEqual([job.id])
  })

  test("acknowledges the queue as failed after PostgreSQL job failure", async () => {
    const queueCalls: unknown[] = []
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000001" },
      ],
    })

    await CloudPostgresWorkerLoop.failJob({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      message: "provider timeout",
      now: () => 300,
      workerID: "worker_abc",
      queueClient: {
        ack: async (input) => {
          queueCalls.push(input)
          return { acknowledged: true }
        },
      },
    })

    expect(queueCalls).toEqual([
      {
        jobID: job.id,
        workerID: "worker_abc",
        terminalStatus: "failed",
        time: 300,
      },
    ])
  })

  test("retries failed PostgreSQL jobs through the durable queue when attempts remain", async () => {
    const queueCalls: unknown[] = []
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000001" },
      ],
      "select count(*) as count from cloud_job_attempt where job_id = $1": [{ count: 1 }],
    })

    expect(
      await CloudPostgresWorkerLoop.failJob({
        client: subject.client,
        tenantID: job.tenant_id,
        jobID: job.id,
        message: "provider timeout",
        now: () => 300,
        workerID: "worker_abc",
        queueClient: {
          retry: async (input) => {
            queueCalls.push(input)
            return { messageID: "retry_2" }
          },
        },
        retry: { maxAttempts: 3, baseDelayMS: 1000, maxDelayMS: 10_000 },
      }),
    ).toMatchObject({ status: "queued", error: "provider timeout" })
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job "))?.params).toEqual([
      "queued",
      "provider timeout",
      300,
      job.id,
      job.tenant_id,
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job_attempt"))?.params).toEqual([
      "failed",
      "provider timeout",
      300,
      "job_abc:attempt:000000000001",
    ])
    expect(queueCalls).toEqual([
      {
        queue: "cloud-runtime:standard:tenant_abc",
        tenantID: job.tenant_id,
        jobID: job.id,
        runAt: 1300,
        attempt: 2,
        reason: "provider timeout",
      },
    ])
  })

  test("acknowledges failed PostgreSQL jobs when retry attempts are exhausted", async () => {
    const queueCalls: unknown[] = []
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000003" },
      ],
      "select count(*) as count from cloud_job_attempt where job_id = $1": [{ count: 3 }],
    })

    expect(
      await CloudPostgresWorkerLoop.failJob({
        client: subject.client,
        tenantID: job.tenant_id,
        jobID: job.id,
        message: "provider timeout",
        now: () => 300,
        workerID: "worker_abc",
        queueClient: {
          ack: async (input) => {
            queueCalls.push(input)
            return { acknowledged: true }
          },
        },
        retry: { maxAttempts: 3, baseDelayMS: 1000, maxDelayMS: 10_000 },
      }),
    ).toMatchObject({ status: "failed", error: "provider timeout" })
    expect(queueCalls).toEqual([
      {
        jobID: job.id,
        workerID: "worker_abc",
        terminalStatus: "failed",
        time: 300,
      },
    ])
  })

  test("expires a leased PostgreSQL job with timeout state", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000001" },
      ],
    })

    const result = await CloudPostgresWorkerLoop.expireJob({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      message: "execution timeout",
      now: () => 400,
    })

    expect(result.status).toBe("expired")
    expect(result.error).toBe("execution timeout")
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job "))?.params).toEqual([
      "expired",
      "execution timeout",
      400,
      job.id,
      job.tenant_id,
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job_attempt"))?.params).toEqual([
      "failed",
      "execution timeout",
      400,
      "job_abc:attempt:000000000001",
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("delete from cloud_job_lease"))?.params).toEqual([job.id])
  })

  test("acknowledges the queue as expired after PostgreSQL job timeout", async () => {
    const queueCalls: unknown[] = []
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000001" },
      ],
    })

    await CloudPostgresWorkerLoop.expireJob({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      message: "execution timeout",
      now: () => 400,
      workerID: "worker_abc",
      queueClient: {
        ack: async (input) => {
          queueCalls.push(input)
          return { acknowledged: true }
        },
      },
    })

    expect(queueCalls).toEqual([
      {
        jobID: job.id,
        workerID: "worker_abc",
        terminalStatus: "expired",
        time: 400,
      },
    ])
  })

  test("cancels a leased PostgreSQL job and active attempt", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000001" },
      ],
    })

    const result = await CloudPostgresWorkerLoop.cancelJob({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      message: "user canceled",
      now: () => 500,
    })

    expect(result.status).toBe("canceled")
    expect(result.error).toBe("user canceled")
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job "))?.params).toEqual([
      "canceled",
      "user canceled",
      500,
      job.id,
      job.tenant_id,
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job_attempt"))?.params).toEqual([
      "canceled",
      "user canceled",
      500,
      "job_abc:attempt:000000000001",
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("delete from cloud_job_lease"))?.params).toEqual([job.id])
  })

  test("acknowledges the queue as canceled after PostgreSQL job cancellation", async () => {
    const queueCalls: unknown[] = []
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [{ ...job, status: "leasing", error: "user canceled" }],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [],
      "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1": [
        { id: "job_abc:attempt:000000000001" },
      ],
    })

    await CloudPostgresWorkerLoop.cancelJob({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      message: "user canceled",
      now: () => 500,
      workerID: "worker_abc",
      queueClient: {
        ack: async (input) => {
          queueCalls.push(input)
          return { acknowledged: true }
        },
      },
    })

    expect(queueCalls).toEqual([
      {
        jobID: job.id,
        workerID: "worker_abc",
        terminalStatus: "canceled",
        time: 500,
      },
    ])
  })
})
