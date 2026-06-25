import { describe, expect, test } from "bun:test"
import { CloudPostgresRepository } from "../../src/cloud/postgres-repository"
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
  time_created: "10",
  time_updated: "10",
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
        return { rows: responses[sql] ?? [] }
      },
    },
  }
}

describe("CloudPostgresRepository", () => {
  test("lists queued jobs for a tenant in creation order", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and status = 'queued' order by time_created, id": [job],
    })

    expect((await CloudPostgresRepository.listQueuedJobs({ client: subject.client, tenantID: job.tenant_id })).map((item) => item.id)).toEqual([
      job.id,
    ])
    expect(subject.calls).toEqual([
      {
        sql: "select * from cloud_job where tenant_id = $1 and status = 'queued' order by time_created, id",
        params: [job.tenant_id],
      },
    ])
  })

  test("reads job spec and prompt from persisted rows", async () => {
    const subject = setup({
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
            time_created: "11",
            time_updated: "11",
          },
        ],
    })

    expect(await CloudPostgresRepository.getJobSpec({ client: subject.client, tenantID: job.tenant_id, id: job.id })).toEqual(spec)
    expect((await CloudPostgresRepository.getJobPrompt({ client: subject.client, tenantID: job.tenant_id, jobID: job.id }))?.prompt).toBe(
      "Analyze with Postgres",
    )
  })

  test("streams job events and reads active leases", async () => {
    const subject = setup({
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_abc:000000000001",
          job_id: job.id,
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: "10",
        },
      ],
      "select * from cloud_job_lease where job_id = $1": [
        {
          job_id: job.id,
          worker_id: "worker_abc",
          expires_at: 100,
          heartbeat_at: 20,
        },
      ],
    })

    expect((await CloudPostgresRepository.listEvents({ client: subject.client, jobID: job.id })).map((event) => event.id)).toEqual([
      "job_abc:000000000001",
    ])
    expect(await CloudPostgresRepository.getLease({ client: subject.client, jobID: job.id })).toEqual({
      jobID: job.id,
      workerID: "worker_abc",
      expiresAt: 100,
      heartbeatAt: 20,
    })
  })

  test("lists runtime pool rows and persists session runtime bindings", async () => {
    const subject = setup({
      "select * from cloud_runtime_worker where tenant_id = $1 order by id": [
        {
          id: "runtime_abc",
          tenant_id: job.tenant_id,
          execution_mode: "shared_session_pool",
          status: "healthy",
          version: "1.14.28",
          profile: "standard",
          max_active_jobs: 4,
          max_sessions: 20,
          metrics: JSON.stringify({
            activeJobs: 0,
            busySessions: 0,
            idleSessions: 0,
            cpuPercent: 0,
            memoryPercent: 0,
            diskPercent: 0,
            recentErrorRate: 0,
            heartbeatDelayMS: 0,
          }),
          time_created: 10,
          time_updated: 20,
        },
      ],
      "select * from cloud_session_runtime_binding where tenant_id = $1": [
        {
          tenant_id: job.tenant_id,
          session_id: job.session_id,
          runtime_id: "runtime_abc",
          time_created: 10,
          time_updated: 20,
        },
      ],
    })

    expect((await CloudPostgresRepository.listRuntimeWorkers({ client: subject.client, tenantID: job.tenant_id })).at(0)).toMatchObject({
      id: "runtime_abc",
      maxActiveJobs: 4,
      metrics: { activeJobs: 0 },
    })
    const binding = (await CloudPostgresRepository.listSessionRuntimeBindings({ client: subject.client, tenantID: job.tenant_id })).at(0)!
    expect(binding).toMatchObject({ sessionID: job.session_id, runtimeID: "runtime_abc" })
    await CloudPostgresRepository.bindSessionRuntime({ client: subject.client, binding })
    await CloudPostgresRepository.releaseSessionRuntime({ client: subject.client, tenantID: job.tenant_id, sessionID: job.session_id })
    await CloudPostgresRepository.markRuntimeOffline({ client: subject.client, tenantID: job.tenant_id, runtimeID: "runtime_abc", now: 30 })
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_session_runtime_binding"))?.params).toEqual([
      job.tenant_id,
      job.session_id,
      "runtime_abc",
      10,
      20,
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("delete from cloud_session_runtime_binding"))?.params).toEqual([
      job.tenant_id,
      job.session_id,
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_runtime_worker set status = 'offline'"))?.params).toEqual([
      30,
      job.tenant_id,
      "runtime_abc",
    ])
  })

  test("supports postgres.js style array results", async () => {
    const calls: { sql: string; params: unknown[] }[] = []
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        return [job]
      },
    }

    expect((await CloudPostgresRepository.listQueuedJobs({ client, tenantID: job.tenant_id })).map((item) => item.id)).toEqual([job.id])
  })
})
