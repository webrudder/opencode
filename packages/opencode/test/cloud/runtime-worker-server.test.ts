import { describe, expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import os from "os"
import path from "path"
import { CloudRuntime } from "../../src/cloud/runtime"
import { CloudRuntimeWorkerServer } from "../../src/cloud/runtime-worker-server"
import { CloudWorker } from "../../src/cloud/worker"

const launch = CloudWorker.launchPlan(
  CloudRuntime.decodeJobSpec({
    id: "job_abc",
    tenantID: "tenant_abc",
    workspaceID: "workspace_abc",
    sessionID: "session_abc",
    runtime: {
      engine: "opencode",
      version: "1.14.28",
      image: "cloud-runtime-opencode:1.14.28",
      profile: "standard",
    },
    model: { provider: "anthropic", model: "claude-sonnet-4-5" },
    tools: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false }, mcp: {}, skills: [] },
    permissions: { filesystem: "workspace_only", shell: "restricted", network: ["storage.internal"] },
    inputs: [],
    outputs: ["md"],
  }),
  { workdir: "/runtime/sessions/session_abc/jobs/job_abc", prompt: "Analyze" },
)

describe("CloudRuntimeWorkerServer", () => {
  test("reads runtime worker server config from environment values", () => {
    expect(
      CloudRuntimeWorkerServer.config({
        env: {
          CLOUD_RUNTIME_ID: "runtime_env",
          CLOUD_RUNTIME_WORKER_PORT: "9797",
          CLOUD_RUNTIME_DATABASE_URL: "postgres://runtime",
          CLOUD_RUNTIME_TENANT_ID: "tenant_env",
          CLOUD_RUNTIME_ENDPOINT: "http://runtime-worker:8788",
          CLOUD_RUNTIME_VERSION: "1.14.28",
          CLOUD_RUNTIME_PROFILE: "large",
          CLOUD_RUNTIME_MAX_ACTIVE_JOBS: "8",
          CLOUD_RUNTIME_MAX_SESSIONS: "80",
          CLOUD_RUNTIME_HEARTBEAT_INTERVAL_MS: "15000",
        },
      }),
    ).toEqual({
      runtimeID: "runtime_env",
      port: 9797,
      databaseURL: "postgres://runtime",
      tenantID: "tenant_env",
      endpoint: "http://runtime-worker:8788",
      version: "1.14.28",
      profile: "large",
      maxActiveJobs: 8,
      maxSessions: 80,
      heartbeatIntervalMS: 15000,
    })
    expect(CloudRuntimeWorkerServer.config({ env: {} })).toEqual({
      runtimeID: "runtime-local-1",
      port: 8788,
      databaseURL: undefined,
      tenantID: "tenant_local",
      endpoint: "http://runtime-worker:8788",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 4,
      maxSessions: 20,
      heartbeatIntervalMS: 10000,
    })
  })

  test("builds a periodic heartbeat function for idle runtime workers", async () => {
    const metrics: unknown[] = []
    await CloudRuntimeWorkerServer.heartbeatIdle({
      heartbeat: async (input) => {
        metrics.push(input.metrics)
      },
    })

    expect(metrics).toEqual([
      {
        activeJobs: 0,
        busySessions: 0,
        idleSessions: 1,
        cpuPercent: 0,
        memoryPercent: 0,
        diskPercent: 0,
        recentErrorRate: 0,
        heartbeatDelayMS: 0,
      },
    ])
  })

  test("registers the runtime worker endpoint in PostgreSQL", async () => {
    const calls: { sql: string; params: unknown[] }[] = []

    await CloudRuntimeWorkerServer.register({
      client: {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params: params ?? [] })
          return { rowCount: 1 }
        },
      },
      config: {
        runtimeID: "runtime_abc",
        port: 8788,
        databaseURL: "postgres://runtime",
        tenantID: "tenant_abc",
        endpoint: "http://runtime-worker:8788",
        version: "1.14.28",
        profile: "standard",
        maxActiveJobs: 4,
        maxSessions: 20,
        heartbeatIntervalMS: 10000,
      },
      now: () => 100,
    })

    expect(calls.find((call) => call.sql.startsWith("insert into cloud_runtime_worker"))?.params).toEqual([
      "runtime_abc",
      "tenant_abc",
      "shared_session_pool",
      "healthy",
      "1.14.28",
      "standard",
      4,
      20,
      "http://runtime-worker:8788",
      JSON.stringify({
        activeJobs: 0,
        busySessions: 0,
        idleSessions: 0,
        cpuPercent: 0,
        memoryPercent: 0,
        diskPercent: 0,
        recentErrorRate: 0,
        heartbeatDelayMS: 0,
      }),
      100,
      100,
    ])
  })

  test("bootstraps PostgreSQL schema before registering the runtime worker", async () => {
    const calls: { sql: string; params: unknown[] }[] = []

    await CloudRuntimeWorkerServer.bootstrap({
      client: {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params: params ?? [] })
          return { rowCount: 1 }
        },
      },
      config: {
        runtimeID: "runtime_abc",
        port: 8788,
        databaseURL: "postgres://runtime",
        tenantID: "tenant_abc",
        endpoint: "http://runtime-worker:8788",
        version: "1.14.28",
        profile: "standard",
        maxActiveJobs: 4,
        maxSessions: 20,
        heartbeatIntervalMS: 10000,
      },
      now: () => 100,
    })

    expect(calls[0]?.sql).toBe("select pg_advisory_lock(8213477)")
    expect(calls[1]?.sql).toStartWith("create table if not exists cloud_tenant")
    expect(calls.some((call) => call.sql === "select pg_advisory_unlock(8213477)")).toBe(true)
    expect(calls.findIndex((call) => call.sql.startsWith("insert into cloud_runtime_worker"))).toBeGreaterThan(0)
  })

  test("heartbeats runtime worker load metrics to PostgreSQL", async () => {
    const calls: { sql: string; params: unknown[] }[] = []

    await CloudRuntimeWorkerServer.heartbeat({
      client: {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params: params ?? [] })
          if (sql === "select * from cloud_runtime_worker where tenant_id = $1 and id = $2") {
            return {
              rows: [
                {
                  id: "runtime_abc",
                  tenant_id: "tenant_abc",
                  execution_mode: "shared_session_pool",
                  status: "healthy",
                  version: "1.14.28",
                  profile: "standard",
                  max_active_jobs: 4,
                  max_sessions: 20,
                  endpoint: "http://runtime-worker:8788",
                  metrics: {
                    activeJobs: 0,
                    busySessions: 0,
                    idleSessions: 0,
                    cpuPercent: 0,
                    memoryPercent: 0,
                    diskPercent: 0,
                    recentErrorRate: 0,
                    heartbeatDelayMS: 0,
                  },
                  time_created: 100,
                  time_updated: 100,
                },
              ],
            }
          }
          return { rowCount: 1 }
        },
      },
      config: {
        runtimeID: "runtime_abc",
        port: 8788,
        databaseURL: "postgres://runtime",
        tenantID: "tenant_abc",
        endpoint: "http://runtime-worker:8788",
        version: "1.14.28",
        profile: "standard",
        maxActiveJobs: 4,
        maxSessions: 20,
        heartbeatIntervalMS: 10000,
      },
      metrics: {
        activeJobs: 1,
        busySessions: 1,
        idleSessions: 0,
        cpuPercent: 10,
        memoryPercent: 20,
        diskPercent: 30,
        recentErrorRate: 0,
        heartbeatDelayMS: 0,
      },
      now: () => 200,
    })

    expect(calls.find((call) => call.sql.startsWith("update cloud_runtime_worker set"))?.params).toEqual([
      "healthy",
      JSON.stringify({
        activeJobs: 1,
        busySessions: 1,
        idleSessions: 0,
        cpuPercent: 10,
        memoryPercent: 20,
        diskPercent: 30,
        recentErrorRate: 0,
        heartbeatDelayMS: 0,
      }),
      200,
      "tenant_abc",
      "runtime_abc",
    ])
  })

  test("executes shared-session runtime jobs through the local executor boundary", async () => {
    const jobs: string[] = []
    const manifests: string[] = []
    const server = CloudRuntimeWorkerServer.create({
      runtimeID: "runtime_abc",
      execute: async (input) => {
        jobs.push(`${input.runtimeID}:${input.jobID}:${input.launch.command}`)
        manifests.push(input.launch.env.OPENCODE_RUNTIME_ARTIFACT_MANIFEST)
        return {
          status: "succeeded",
          manifest: { version: 1, jobID: input.jobID, artifacts: [] },
          sizeByPath: {},
        }
      },
    })

    const response = await server.app.request("/v1/runtime/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeID: "runtime_abc",
        jobID: "job_abc",
        launch,
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: "succeeded",
      manifest: { version: 1, jobID: "job_abc", artifacts: [] },
      sizeByPath: {},
    })
    expect(jobs).toEqual(["runtime_abc:job_abc:opencode"])
    expect(manifests).toEqual([launch.artifactManifest])
  })

  test("heartbeats busy and idle metrics around runtime job execution", async () => {
    const metrics: unknown[] = []
    const server = CloudRuntimeWorkerServer.create({
      runtimeID: "runtime_abc",
      heartbeat: async (input) => {
        metrics.push(input.metrics)
      },
      execute: async (input) => ({
        status: "succeeded",
        manifest: { version: 1, jobID: input.jobID, artifacts: [] },
        sizeByPath: {},
      }),
    })

    await server.app.request("/v1/runtime/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeID: "runtime_abc",
        jobID: "job_abc",
        launch,
      }),
    })

    expect(metrics).toEqual([
      {
        activeJobs: 1,
        busySessions: 1,
        idleSessions: 0,
        cpuPercent: 0,
        memoryPercent: 0,
        diskPercent: 0,
        recentErrorRate: 0,
        heartbeatDelayMS: 0,
      },
      {
        activeJobs: 0,
        busySessions: 0,
        idleSessions: 1,
        cpuPercent: 0,
        memoryPercent: 0,
        diskPercent: 0,
        recentErrorRate: 0,
        heartbeatDelayMS: 0,
      },
    ])
  })

  test("heartbeats idle metrics when runtime job execution throws", async () => {
    const metrics: unknown[] = []
    const server = CloudRuntimeWorkerServer.create({
      runtimeID: "runtime_abc",
      heartbeat: async (input) => {
        metrics.push(input.metrics)
      },
      execute: async () => {
        throw new Error("boom")
      },
    })

    const response = await server.app.request("/v1/runtime/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeID: "runtime_abc",
        jobID: "job_abc",
        launch,
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "failed", message: "boom" })
    expect(metrics.map((item) => (item as { activeJobs: number }).activeJobs)).toEqual([1, 0])
  })

  test("redacts model secrets from runtime worker failure responses", async () => {
    const secretLaunch = {
      ...launch,
      env: {
        ...launch.env,
        OPENAI_API_KEY: "sk-user-secret",
      },
    }
    const server = CloudRuntimeWorkerServer.create({
      runtimeID: "runtime_abc",
      execute: async () => {
        throw new Error("provider rejected OPENAI_API_KEY=sk-user-secret")
      },
    })

    const response = await server.app.request("/v1/runtime/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeID: "runtime_abc",
        jobID: "job_abc",
        launch: secretLaunch,
      }),
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ status: "failed", message: "provider rejected OPENAI_API_KEY=[redacted]" })
    expect(JSON.stringify(body)).not.toContain("sk-user-secret")
  })

  test("redacts model secrets from executor-returned failed results", async () => {
    const server = CloudRuntimeWorkerServer.create({
      runtimeID: "runtime_abc",
      execute: async () => ({
        status: "failed",
        message: "opencode stderr contained ANTHROPIC_API_KEY=sk-ant-secret",
      }),
    })

    const response = await server.app.request("/v1/runtime/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeID: "runtime_abc",
        jobID: "job_abc",
        launch: {
          ...launch,
          env: {
            ...launch.env,
            ANTHROPIC_API_KEY: "sk-ant-secret",
          },
        },
      }),
    })
    const body = await response.json()

    expect(body).toEqual({ status: "failed", message: "opencode stderr contained ANTHROPIC_API_KEY=[redacted]" })
    expect(JSON.stringify(body)).not.toContain("sk-ant-secret")
  })

  test("executes runtime jobs even when heartbeat storage is unavailable", async () => {
    const jobs: string[] = []
    const server = CloudRuntimeWorkerServer.create({
      runtimeID: "runtime_abc",
      heartbeat: async () => {
        throw new Error("postgres unavailable")
      },
      execute: async (input) => {
        jobs.push(input.jobID)
        return {
          status: "succeeded",
          manifest: { version: 1, jobID: input.jobID, artifacts: [] },
          sizeByPath: {},
        }
      },
    })

    const response = await server.app.request("/v1/runtime/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeID: "runtime_abc",
        jobID: "job_abc",
        launch,
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: "succeeded",
      manifest: { version: 1, jobID: "job_abc", artifacts: [] },
      sizeByPath: {},
    })
    expect(jobs).toEqual(["job_abc"])
  })

  test("can execute a modeless smoke job without invoking opencode", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-runtime-worker-modeless-"))
    const modelessLaunch = {
      ...launch,
      cwd: directory,
      artifactManifest: path.join(directory, ".opencode-cloud", "artifacts.json"),
    }
    const server = CloudRuntimeWorkerServer.create({
      runtimeID: "runtime_abc",
      modelessSmoke: true,
    })

    const response = await server.app.request("/v1/runtime/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeID: "runtime_abc",
        jobID: "job_abc",
        launch: modelessLaunch,
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "succeeded",
      manifest: {
        version: 1,
        jobID: "job_abc",
        artifacts: [
          {
            name: "modeless-smoke-report.md",
            kind: "md",
            path: "modeless-smoke-report.md",
            mime: "text/markdown",
          },
        ],
      },
    })
    expect(await Bun.file(path.join(directory, "modeless-smoke-report.md")).text()).toContain("Modeless shared-session smoke")
    expect(await Bun.file(modelessLaunch.artifactManifest).json()).toMatchObject({ jobID: "job_abc" })
  })

  test("rejects jobs for a different runtime id", async () => {
    const server = CloudRuntimeWorkerServer.create({ runtimeID: "runtime_abc" })
    const response = await server.app.request("/v1/runtime/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeID: "runtime_other",
        jobID: "job_abc",
        launch,
      }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      status: "failed",
      message: "Runtime worker runtime_abc cannot execute job for runtime_other",
    })
  })
})
