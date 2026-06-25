import { describe, expect, test } from "bun:test"
import { CloudPostgresSharedRuntime } from "../../src/cloud/postgres-shared-runtime"

const metrics = {
  activeJobs: 0,
  busySessions: 0,
  idleSessions: 0,
  cpuPercent: 0,
  memoryPercent: 0,
  diskPercent: 0,
  recentErrorRate: 0,
  heartbeatDelayMS: 0,
}

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

function launch() {
  return {
    command: "opencode" as const,
    args: ["run", "Analyze"],
    cwd: "/tmp/runtime/session_abc/jobs/job_abc",
    env: {},
    artifactManifest: "/tmp/runtime/session_abc/jobs/job_abc/.opencode-cloud/artifacts.json",
    network: { allowHosts: [] },
    sandbox: {
      jobID: "job_abc",
      tenantID: "tenant_abc",
      image: "cloud-runtime-opencode:1.14.28",
      isolation: "container" as const,
      resources: { cpu: 2, memoryMB: 4096, diskMB: 10240, timeoutMS: 1_800_000 },
      security: {
        runAsNonRoot: true,
        readOnlyRootFilesystem: true,
        allowPrivilegeEscalation: false,
      },
      network: { allowHosts: [] },
    },
  }
}

describe("CloudPostgresSharedRuntime", () => {
  test("assigns a healthy runtime, binds the session, and invokes the selected runtime", async () => {
    const subject = setup({
      "select * from cloud_runtime_worker where tenant_id = $1 order by id": [
        {
          id: "runtime_busy",
          tenant_id: "tenant_abc",
          execution_mode: "shared_session_pool",
          status: "healthy",
          version: "1.14.28",
          profile: "standard",
          max_active_jobs: 4,
          max_sessions: 20,
          metrics: { ...metrics, activeJobs: 3, busySessions: 3, cpuPercent: 80 },
          time_created: 10,
          time_updated: 10,
        },
        {
          id: "runtime_cool",
          tenant_id: "tenant_abc",
          execution_mode: "shared_session_pool",
          status: "healthy",
          version: "1.14.28",
          profile: "standard",
          max_active_jobs: 4,
          max_sessions: 20,
          metrics,
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_session_runtime_binding where tenant_id = $1": [],
    })
    const invoked: string[] = []

    const result = await CloudPostgresSharedRuntime.run({
      client: subject.client,
      tenantID: "tenant_abc",
      sessionID: "session_abc",
      jobID: "job_abc",
      launch: launch(),
      now: () => 100,
      runtime: async (input) => {
        invoked.push(input.runtimeID)
        return {
          status: "succeeded",
          manifest: { version: 1, jobID: input.jobID, artifacts: [] },
          sizeByPath: {},
        }
      },
    })

    expect(result).toEqual({
      status: "succeeded",
      runtimeID: "runtime_cool",
      manifest: { version: 1, jobID: "job_abc", artifacts: [] },
      sizeByPath: {},
    })
    expect(invoked).toEqual(["runtime_cool"])
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_session_runtime_binding"))?.params).toEqual([
      "tenant_abc",
      "session_abc",
      "runtime_cool",
      100,
      100,
    ])
  })

  test("uses the assigned runtime endpoint when no inline runtime is provided", async () => {
    const subject = setup({
      "select * from cloud_runtime_worker where tenant_id = $1 order by id": [
        {
          id: "runtime_http",
          tenant_id: "tenant_abc",
          execution_mode: "shared_session_pool",
          status: "healthy",
          version: "1.14.28",
          profile: "standard",
          max_active_jobs: 4,
          max_sessions: 20,
          endpoint: "http://runtime-http.internal",
          metrics,
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_session_runtime_binding where tenant_id = $1": [],
    })
    const endpoints: string[] = []

    const result = await CloudPostgresSharedRuntime.run({
      client: subject.client,
      tenantID: "tenant_abc",
      sessionID: "session_abc",
      jobID: "job_abc",
      launch: launch(),
      now: () => 100,
      runtimeClient: {
        runJob: async (input) => {
          endpoints.push(input.endpoint)
          return {
            status: "succeeded",
            manifest: { version: 1, jobID: input.jobID, artifacts: [] },
            sizeByPath: {},
          }
        },
      },
    })

    expect(result).toMatchObject({ status: "succeeded", runtimeID: "runtime_http" })
    expect(endpoints).toEqual(["http://runtime-http.internal"])
  })

  test("moves a bound session away from a draining runtime on the next job", async () => {
    const subject = setup({
      "select * from cloud_runtime_worker where tenant_id = $1 order by id": [
        {
          id: "runtime_draining",
          tenant_id: "tenant_abc",
          execution_mode: "shared_session_pool",
          status: "draining",
          version: "1.14.28",
          profile: "standard",
          max_active_jobs: 4,
          max_sessions: 20,
          metrics,
          time_created: 10,
          time_updated: 10,
        },
        {
          id: "runtime_healthy",
          tenant_id: "tenant_abc",
          execution_mode: "shared_session_pool",
          status: "healthy",
          version: "1.14.28",
          profile: "standard",
          max_active_jobs: 4,
          max_sessions: 20,
          metrics,
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_session_runtime_binding where tenant_id = $1": [
        {
          tenant_id: "tenant_abc",
          session_id: "session_abc",
          runtime_id: "runtime_draining",
          time_created: 10,
          time_updated: 20,
        },
      ],
    })
    const invoked: string[] = []

    const result = await CloudPostgresSharedRuntime.run({
      client: subject.client,
      tenantID: "tenant_abc",
      sessionID: "session_abc",
      jobID: "job_abc",
      launch: launch(),
      now: () => 100,
      runtime: async (input) => {
        invoked.push(input.runtimeID)
        return {
          status: "succeeded",
          manifest: { version: 1, jobID: input.jobID, artifacts: [] },
          sizeByPath: {},
        }
      },
    })

    expect(result).toMatchObject({ status: "succeeded", runtimeID: "runtime_healthy" })
    expect(invoked).toEqual(["runtime_healthy"])
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_session_runtime_binding"))?.params).toEqual([
      "tenant_abc",
      "session_abc",
      "runtime_healthy",
      100,
      100,
    ])
  })

  test("releases the session binding and marks runtime offline when the runtime endpoint is unavailable", async () => {
    const subject = setup({
      "select * from cloud_runtime_worker where tenant_id = $1 order by id": [
        {
          id: "runtime_http",
          tenant_id: "tenant_abc",
          execution_mode: "shared_session_pool",
          status: "healthy",
          version: "1.14.28",
          profile: "standard",
          max_active_jobs: 4,
          max_sessions: 20,
          endpoint: "http://runtime-http.internal",
          metrics,
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_session_runtime_binding where tenant_id = $1": [],
    })

    const result = await CloudPostgresSharedRuntime.run({
      client: subject.client,
      tenantID: "tenant_abc",
      sessionID: "session_abc",
      jobID: "job_abc",
      launch: launch(),
      now: () => 100,
      runtimeClient: {
        runJob: async () => ({
          status: "failed",
          message: "connection refused",
          runtimeUnavailable: true,
        }),
      },
    })

    expect(result).toEqual({
      status: "failed",
      runtimeID: "runtime_http",
      message: "connection refused",
      runtimeUnavailable: true,
    })
    expect(subject.calls.find((call) => call.sql.startsWith("delete from cloud_session_runtime_binding"))?.params).toEqual([
      "tenant_abc",
      "session_abc",
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_runtime_worker set status = 'offline'"))?.params).toEqual([
      100,
      "tenant_abc",
      "runtime_http",
    ])
  })

  test("keeps the session binding when the runtime endpoint returns a job failure", async () => {
    const subject = setup({
      "select * from cloud_runtime_worker where tenant_id = $1 order by id": [
        {
          id: "runtime_http",
          tenant_id: "tenant_abc",
          execution_mode: "shared_session_pool",
          status: "healthy",
          version: "1.14.28",
          profile: "standard",
          max_active_jobs: 4,
          max_sessions: 20,
          endpoint: "http://runtime-http.internal",
          metrics,
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_session_runtime_binding where tenant_id = $1": [],
    })

    const result = await CloudPostgresSharedRuntime.run({
      client: subject.client,
      tenantID: "tenant_abc",
      sessionID: "session_abc",
      jobID: "job_abc",
      launch: launch(),
      now: () => 100,
      runtimeClient: {
        runJob: async () => ({
          status: "failed",
          message: "analysis failed",
        }),
      },
    })

    expect(result).toEqual({
      status: "failed",
      runtimeID: "runtime_http",
      message: "analysis failed",
    })
    expect(subject.calls.some((call) => call.sql.startsWith("delete from cloud_session_runtime_binding"))).toBe(false)
    expect(subject.calls.some((call) => call.sql.startsWith("update cloud_runtime_worker set status = 'offline'"))).toBe(false)
  })
})
