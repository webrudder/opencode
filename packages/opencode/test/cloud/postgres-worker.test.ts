import { describe, expect, test } from "bun:test"
import { CloudPostgresWorker } from "../../src/cloud/postgres-worker"
import { CloudRuntime } from "../../src/cloud/runtime"

const runtime = {
  engine: "opencode" as const,
  version: "1.14.28",
  image: "cloud-runtime-opencode:1.14.28",
  profile: "standard" as const,
}
const job = {
  id: "job_abc",
  tenant_id: "tenant_local",
  workspace_id: "workspace_abc",
  session_id: "session_abc",
  status: "queued",
  runtime,
  cost: { estimatedUSD: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
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
const byokSpec = CloudRuntime.decodeJobSpec({
  ...spec,
  model: { provider: "openai-compatible", model: "qwen-max", credentialID: "cred_user" },
  modelConfigSnapshot: {
    jobID: job.id,
    credentialID: "cred_user",
    credentialVersion: 3,
    providerType: "openai-compatible",
    provider: "openai-compatible",
    baseURL: "https://llm.customer.example/v1",
    secretRef: "secret/user/key",
    model: "qwen-max",
    time: { created: 10, updated: 10 },
  },
})

function queuedClient(input?: { spec?: typeof spec }) {
  const responses: Record<string, Record<string, unknown>[]> = {
    "select * from cloud_job where tenant_id = $1 and status = 'queued' order by time_created, id": [job],
    "select * from cloud_job where tenant_id = $1 and id = $2": [job],
    "select job_spec from cloud_job where tenant_id = $1 and id = $2": [{ job_spec: input?.spec ?? spec }],
    "select * from cloud_message where tenant_id = $1 and job_id = $2 and role = 'user' order by time_created desc, id desc limit 1": [
      {
        id: "message_abc",
        tenant_id: job.tenant_id,
        workspace_id: job.workspace_id,
        session_id: job.session_id,
        job_id: job.id,
        role: "user",
        content: "Analyze with Postgres worker",
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
  }
  return {
    query: async (sql: string) => {
      if (sql.startsWith("update cloud_queue_message set")) return { rows: [{ job_id: job.id, lease_expires_at: 1100 }], rowCount: 1 }
      if (sql.startsWith("select")) return { rows: responses[sql] ?? [] }
      return { rowCount: 1 }
    },
  }
}

function queuedClientWithRuntime() {
  const calls: { sql: string; params: unknown[] }[] = []
  const base = queuedClient()
  return {
    calls,
    client: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        if (sql === "select * from cloud_runtime_worker where tenant_id = $1 order by id") {
          return {
            rows: [
              {
                id: "runtime_pg",
                tenant_id: "tenant_local",
                execution_mode: "shared_session_pool",
                status: "healthy",
                version: "1.14.28",
                profile: "standard",
                max_active_jobs: 4,
                max_sessions: 20,
                endpoint: "http://runtime-pg.internal",
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
                time_created: 10,
                time_updated: 10,
              },
            ],
          }
        }
        if (sql === "select * from cloud_session_runtime_binding where tenant_id = $1") return { rows: [] }
        return base.query(sql)
      },
    },
  }
}

function queuedClientWithRuntimeWithoutEndpoint() {
  const calls: { sql: string; params: unknown[] }[] = []
  const base = queuedClient()
  return {
    calls,
    client: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        if (sql === "select * from cloud_runtime_worker where tenant_id = $1 order by id") {
          return {
            rows: [
              {
                id: "runtime_pg",
                tenant_id: "tenant_local",
                execution_mode: "shared_session_pool",
                status: "healthy",
                version: "1.14.28",
                profile: "standard",
                max_active_jobs: 4,
                max_sessions: 20,
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
                time_created: 10,
                time_updated: 10,
              },
            ],
          }
        }
        if (sql === "select * from cloud_session_runtime_binding where tenant_id = $1") return { rows: [] }
        if (sql === "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1") {
          return { rows: [{ id: "job_abc:attempt:000001" }] }
        }
        return base.query(sql)
      },
    },
  }
}

describe("CloudPostgresWorker", () => {
  test("reads PostgreSQL worker config from environment values", () => {
    expect(
      CloudPostgresWorker.config({
        env: {
          CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:opencode@postgres:5432/cloud_runtime",
          CLOUD_RUNTIME_WORKER_ID: "worker_postgres",
          CLOUD_RUNTIME_TENANT_ID: "tenant_local",
          CLOUD_RUNTIME_LEASE_TTL_MS: "120000",
          CLOUD_RUNTIME_SANDBOX_ROOT: "/tmp/runtime",
          CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
          CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://minio:9000",
          CLOUD_RUNTIME_OBJECT_REGION: "us-east-1",
          CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID: "opencode",
          CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY: "secret",
          CLOUD_RUNTIME_K8S_NAMESPACE: "cloud-runtime",
          CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example",
          CLOUD_RUNTIME_K8S_TOKEN: "token_123",
          CLOUD_RUNTIME_K8S_POLL_INTERVAL_MS: "250",
          CLOUD_RUNTIME_K8S_MAX_POLLS: "10",
          CLOUD_RUNTIME_EXECUTION_MODE: "kubernetes",
          CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE: "1",
        },
      }),
    ).toMatchObject({
      databaseURL: "postgres://opencode:opencode@postgres:5432/cloud_runtime",
      workerID: "worker_postgres",
      tenantID: "tenant_local",
      leaseTTLMS: 120000,
      sandboxRoot: "/tmp/runtime",
      bucket: "runtime-artifacts",
      objectEndpoint: "http://minio:9000",
      objectRegion: "us-east-1",
      objectAccessKeyID: "opencode",
      objectSecretAccessKey: "secret",
      namespace: "cloud-runtime",
      k8sServerURL: "https://kubernetes.example",
      k8sToken: "token_123",
      k8sPollIntervalMS: 250,
      k8sMaxPolls: 10,
      executionMode: "kubernetes",
      baseEnv: {
        CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE: "1",
      },
    })
  })

  test("defaults PostgreSQL worker execution to shared session pool mode", () => {
    expect(CloudPostgresWorker.config({ env: {} })).toMatchObject({
      executionMode: "shared-session",
    })
  })

  test("runs one idle PostgreSQL worker tick from an injected query client", async () => {
    const calls: string[] = []
    const result = await CloudPostgresWorker.runOnce({
      client: {
        query: async (sql) => {
          calls.push(sql)
          return { rows: [] }
        },
      },
      tenantID: "tenant_local",
      workerID: "worker_postgres",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/tmp/runtime",
      bucket: "runtime-artifacts",
      namespace: "cloud-runtime",
    })

    expect(result).toEqual({ status: "idle" })
    expect(calls).toContain("select * from cloud_job where tenant_id = $1 and status = 'queued' order by time_created, id")
  })

  test("executes a leased PostgreSQL job through the configured Kubernetes completion helper", async () => {
    const completed: string[] = []
    const result = await CloudPostgresWorker.runOnce({
      client: queuedClient(),
      tenantID: "tenant_local",
      workerID: "worker_postgres",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/tmp/runtime",
      bucket: "runtime-artifacts",
      namespace: "cloud-runtime",
      kubernetesRunner: async () => ({
        jobID: job.id,
        status: "succeeded",
        podName: "runtime-job-abc",
        podStatus: { phase: "Succeeded", exitCode: 0 },
        logs: "done",
      }),
      completeKubernetesJob: async (input) => {
        completed.push(input.jobID)
        return { status: "completed" as const, jobID: input.jobID }
      },
    })

    expect(result).toEqual({ status: "completed", jobID: job.id })
    expect(completed).toEqual([job.id])
  })

  test("passes modeless smoke flags into PostgreSQL Kubernetes launch plans", async () => {
    const commands: string[] = []
    const result = await CloudPostgresWorker.runOnce({
      client: queuedClient(),
      tenantID: "tenant_local",
      workerID: "worker_postgres",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/tmp/runtime",
      bucket: "runtime-artifacts",
      namespace: "cloud-runtime",
      executionMode: "kubernetes",
      baseEnv: {
        CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE: "1",
      },
      kubernetesRunner: async () => {
        throw new Error("completion helper should replace the Kubernetes runner")
      },
      completeKubernetesJob: async (input) => {
        commands.push(input.launch.command)
        return { status: "completed" as const, jobID: input.jobID }
      },
    })

    expect(result).toEqual({ status: "completed", jobID: job.id })
    expect(commands).toEqual(["/bin/sh"])
  })

  test("executes a leased PostgreSQL job through the configured shared-session completion helper", async () => {
    const completed: string[] = []
    const result = await CloudPostgresWorker.runOnce({
      client: queuedClient(),
      tenantID: "tenant_local",
      workerID: "worker_postgres",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/tmp/runtime",
      bucket: "runtime-artifacts",
      namespace: "cloud-runtime",
      executionMode: "shared-session",
      kubernetesRunner: async () => {
        throw new Error("shared-session mode should not run Kubernetes")
      },
      completeSharedSessionJob: async (input) => {
        completed.push(input.jobID)
        return { status: "completed" as const, jobID: input.jobID, runtimeID: "runtime_shared" }
      },
    })

    expect(result).toMatchObject({ status: "completed", jobID: job.id, runtimeID: "runtime_shared" })
    expect(completed).toEqual([job.id])
  })

  test("injects resolved BYOK model credentials before shared-session completion", async () => {
    const envs: Record<string, string>[] = []
    const result = await CloudPostgresWorker.runOnce({
      client: queuedClient({ spec: byokSpec }),
      tenantID: "tenant_local",
      workerID: "worker_postgres",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/tmp/runtime",
      bucket: "runtime-artifacts",
      namespace: "cloud-runtime",
      executionMode: "shared-session",
      modelSecretResolver: async (secretRef) => secretRef === "secret/user/key" ? "sk-user" : undefined,
      completeSharedSessionJob: async (input) => {
        envs.push(input.launch.env)
        return { status: "completed" as const, jobID: input.jobID, runtimeID: "runtime_shared" }
      },
    })

    expect(result).toMatchObject({ status: "completed", jobID: job.id, runtimeID: "runtime_shared" })
    expect(envs[0].OPENAI_API_KEY).toBe("sk-user")
    expect(envs[0].OPENAI_BASE_URL).toBe("https://llm.customer.example/v1")
    expect(JSON.parse(envs[0].OPENCODE_CONFIG_CONTENT).model).toBe("openai-compatible/qwen-max")
  })

  test("fails a PostgreSQL job before runtime dispatch when BYOK secret is missing", async () => {
    const subject = queuedClient({ spec: byokSpec })
    const result = await CloudPostgresWorker.runOnce({
      client: subject,
      tenantID: "tenant_local",
      workerID: "worker_postgres",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/tmp/runtime",
      bucket: "runtime-artifacts",
      namespace: "cloud-runtime",
      executionMode: "shared-session",
      modelSecretResolver: async () => undefined,
      completeSharedSessionJob: async () => {
        throw new Error("should not dispatch runtime")
      },
    })

    expect(result).toMatchObject({ status: "failed", jobID: job.id })
  })

  test("executes a leased PostgreSQL job through the default shared-session production helper", async () => {
    const result = await CloudPostgresWorker.runOnce({
      client: queuedClient(),
      tenantID: "tenant_local",
      workerID: "worker_postgres",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/tmp/runtime",
      bucket: "runtime-artifacts",
      namespace: "cloud-runtime",
      executionMode: "shared-session",
      sharedRuntime: async () => ({
        status: "succeeded",
        runtimeID: "runtime_shared",
        manifest: {
          version: 1,
          jobID: job.id,
          artifacts: [],
        },
        sizeByPath: {},
      }),
    })

    expect(result).toMatchObject({ status: "completed", jobID: job.id, runtimeID: "runtime_shared" })
  })

  test("assigns a Postgres runtime pool worker for shared-session execution", async () => {
    const subject = queuedClientWithRuntime()
    const invoked: string[] = []
    const result = await CloudPostgresWorker.runOnce({
      client: subject.client,
      tenantID: "tenant_local",
      workerID: "worker_postgres",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/tmp/runtime",
      bucket: "runtime-artifacts",
      namespace: "cloud-runtime",
      executionMode: "shared-session",
      sharedRuntimeClient: async (input) => {
        invoked.push(input.runtimeID)
        return {
          status: "succeeded",
          manifest: {
            version: 1,
            jobID: input.jobID,
            artifacts: [],
          },
          sizeByPath: {},
        }
      },
    })

    expect(result).toMatchObject({ status: "completed", jobID: job.id, runtimeID: "runtime_pg" })
    expect(invoked).toEqual(["runtime_pg"])
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_session_runtime_binding"))?.params).toEqual([
      "tenant_local",
      "session_abc",
      "runtime_pg",
      100,
      100,
    ])
  })

  test("uses the registered runtime endpoint for shared-session execution without an inline runtime", async () => {
    const subject = queuedClientWithRuntime()
    const endpoints: string[] = []
    const result = await CloudPostgresWorker.runOnce({
      client: subject.client,
      tenantID: "tenant_local",
      workerID: "worker_postgres",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/tmp/runtime",
      bucket: "runtime-artifacts",
      namespace: "cloud-runtime",
      executionMode: "shared-session",
      sharedRuntimeEndpointClient: {
        runJob: async (input) => {
          endpoints.push(input.endpoint)
          return {
            status: "succeeded",
            manifest: {
              version: 1,
              jobID: input.jobID,
              artifacts: [],
            },
            sizeByPath: {},
          }
        },
      },
    })

    expect(result).toMatchObject({ status: "completed", jobID: job.id, runtimeID: "runtime_pg" })
    expect(endpoints).toEqual(["http://runtime-pg.internal"])
  })

  test("fails a shared-session job when the assigned runtime has no endpoint", async () => {
    const subject = queuedClientWithRuntimeWithoutEndpoint()
    const result = await CloudPostgresWorker.runOnce({
      client: subject.client,
      tenantID: "tenant_local",
      workerID: "worker_postgres",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/tmp/runtime",
      bucket: "runtime-artifacts",
      namespace: "cloud-runtime",
      executionMode: "shared-session",
    })

    expect(result).toMatchObject({ status: "failed", jobID: job.id, runtimeID: "runtime_pg" })
    expect(subject.calls.filter((call) => call.sql.startsWith("update cloud_job set status = $1")).map((call) => call.params[0])).toContain(
      "failed",
    )
  })

  test("assembles queue and storage clients for Kubernetes completion", async () => {
    const received: string[] = []
    const result = await CloudPostgresWorker.run({
      env: {
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:opencode@postgres:5432/cloud_runtime",
        CLOUD_RUNTIME_WORKER_STEPS: "1",
        CLOUD_RUNTIME_EXECUTION_MODE: "kubernetes",
        CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://minio:9000",
        CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID: "opencode",
        CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY: "secret",
        CLOUD_RUNTIME_POLL_INTERVAL_MS: "0",
      },
      client: queuedClient(),
      schema: async () => undefined,
      kubernetesRunner: async () => ({
        jobID: job.id,
        status: "succeeded",
        podName: "runtime-job-abc",
        podStatus: { phase: "Succeeded", exitCode: 0 },
        logs: "done",
      }),
      completeKubernetesJob: async (input) => {
        if (input.queueClient) received.push("queue")
        if (input.storageClient) received.push("storage")
        return { status: "completed" as const, jobID: input.jobID }
      },
    })

    expect(result).toMatchObject({ steps: 1, started: 1, idle: 0, errors: 0 })
    expect(received).toEqual(["queue", "storage"])
  })

  test("assembles queue and storage clients for shared-session completion", async () => {
    const received: string[] = []
    const result = await CloudPostgresWorker.run({
      env: {
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:opencode@postgres:5432/cloud_runtime",
        CLOUD_RUNTIME_WORKER_STEPS: "1",
        CLOUD_RUNTIME_EXECUTION_MODE: "shared-session",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://minio:9000",
        CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID: "opencode",
        CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY: "secret",
        CLOUD_RUNTIME_POLL_INTERVAL_MS: "0",
      },
      client: queuedClient(),
      schema: async () => undefined,
      completeSharedSessionJob: async (input) => {
        if (input.queueClient) received.push("queue")
        if (input.storageClient) received.push("storage")
        return { status: "completed" as const, jobID: input.jobID, runtimeID: "runtime_shared" }
      },
    })

    expect(result).toMatchObject({ steps: 1, started: 1, idle: 0, errors: 0 })
    expect(received).toEqual(["queue", "storage"])
  })

  test("uses environment-backed model secrets from the PostgreSQL worker run entrypoint", async () => {
    const envs: Record<string, string>[] = []
    const result = await CloudPostgresWorker.run({
      env: {
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:opencode@postgres:5432/cloud_runtime",
        CLOUD_RUNTIME_WORKER_STEPS: "1",
        CLOUD_RUNTIME_EXECUTION_MODE: "shared-session",
        CLOUD_RUNTIME_POLL_INTERVAL_MS: "0",
        CLOUD_RUNTIME_MODEL_SECRET_SECRET_USER_KEY: "sk-user",
      },
      client: queuedClient({ spec: byokSpec }),
      schema: async () => undefined,
      completeSharedSessionJob: async (input) => {
        envs.push(input.launch.env)
        return { status: "completed" as const, jobID: input.jobID, runtimeID: "runtime_shared" }
      },
    })

    expect(result).toMatchObject({ steps: 1, started: 1, idle: 0, errors: 0 })
    expect(envs[0].OPENAI_API_KEY).toBe("sk-user")
  })
})
