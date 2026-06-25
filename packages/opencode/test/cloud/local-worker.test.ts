import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtemp, stat } from "fs/promises"
import os from "os"
import path from "path"
import { CloudMemoryQueue } from "../../src/cloud/memory-queue"
import { CloudQueueAdapter } from "../../src/cloud/queue-adapter"
import { CloudQueueRunner } from "../../src/cloud/queue-runner"
import { CloudSQLiteService } from "../../src/cloud/sqlite-service"
import { CloudSQLiteSchema } from "../../src/cloud/sqlite-schema"
import { config, kubernetesRunner, runOnce, runSteps } from "../../src/cloud/local-worker"

const tenant = {
  id: "tenant_local",
  defaultRuntimeVersion: "1.14.28",
  defaultRuntimeImage: "cloud-runtime-opencode:1.14.28",
  defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
  allowedModels: ["anthropic/claude-sonnet-4-5"],
}

function setup(input?: { inputs?: string[] }) {
  const db = new Database(":memory:")
  CloudSQLiteSchema.apply({ db })
  const service = CloudSQLiteService.create({
    db,
    tenant,
    tools: { mcp: {}, skills: {} },
    now: () => 100,
    id: (prefix) => `${prefix}_abc`,
  })
  const workspace = service.createWorkspace({ name: "Acme" })
  const session = service.createSession({ workspaceID: workspace.id, userID: "user_local" })
  const job = service.createJob({
    sessionID: session.id,
    prompt: "Run local worker",
    inputs: input?.inputs ?? [],
    outputs: ["md"],
    runtime: { profile: "standard" },
    tools: {
      webfetch: { enabled: false, allowDomains: [] },
      websearch: { enabled: false },
      mcp: [],
      skills: [],
    },
  })
  return { db, job }
}

describe("CloudLocalWorker", () => {
  test("reads SQLite worker config from environment values", () => {
    expect(
      config({
        env: {
          CLOUD_RUNTIME_SQLITE_PATH: "/tmp/cloud-runtime.sqlite",
          CLOUD_RUNTIME_WORKER_ID: "worker_a",
          CLOUD_RUNTIME_TENANT_ID: "tenant_a",
          CLOUD_RUNTIME_LEASE_TTL_MS: "120000",
          CLOUD_RUNTIME_POLL_INTERVAL_MS: "250",
          CLOUD_RUNTIME_WORKER_STEPS: "3",
          CLOUD_RUNTIME_EXECUTION_MODE: "kubernetes",
          CLOUD_RUNTIME_SHARED_RUNTIME_ID: "runtime_env",
          CLOUD_RUNTIME_SHARED_RUNTIME_VERSION: "1.14.29",
          CLOUD_RUNTIME_SHARED_RUNTIME_PROFILE: "large",
          CLOUD_RUNTIME_SHARED_RUNTIME_MAX_ACTIVE_JOBS: "8",
          CLOUD_RUNTIME_SHARED_RUNTIME_MAX_SESSIONS: "80",
          CLOUD_RUNTIME_SANDBOX_ROOT: "/sandbox",
          CLOUD_RUNTIME_OBJECT_BUCKET: "bucket",
          CLOUD_RUNTIME_K8S_NAMESPACE: "runtime",
          CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example",
          CLOUD_RUNTIME_K8S_TOKEN: "token_123",
          CLOUD_RUNTIME_K8S_POLL_INTERVAL_MS: "25",
          CLOUD_RUNTIME_K8S_MAX_POLLS: "5",
          CLOUD_RUNTIME_RETRY_MAX_ATTEMPTS: "3",
          CLOUD_RUNTIME_RETRY_BASE_DELAY_MS: "1000",
          CLOUD_RUNTIME_RETRY_MAX_DELAY_MS: "10000",
          CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "5000",
          CLOUD_RUNTIME_SESSION_CACHE_TTL_MS: "600000",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example/v1/metrics",
          OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer token_123",
          OTEL_SERVICE_NAME: "cloud-runtime-worker",
        },
      }),
    ).toEqual({
      sqlitePath: "/tmp/cloud-runtime.sqlite",
      workerID: "worker_a",
      tenantID: "tenant_a",
      leaseTTLMS: 120000,
      pollIntervalMS: 250,
      steps: 3,
      executionMode: "kubernetes",
      sharedRuntimeID: "runtime_env",
      sharedRuntimeVersion: "1.14.29",
      sharedRuntimeProfile: "large",
      sharedRuntimeMaxActiveJobs: 8,
      sharedRuntimeMaxSessions: 80,
      sandboxRoot: "/sandbox",
      bucket: "bucket",
      namespace: "runtime",
      k8sServerURL: "https://kubernetes.example",
      k8sToken: "token_123",
      k8sPollIntervalMS: 25,
      k8sMaxPolls: 5,
      retry: {
        maxAttempts: 3,
        baseDelayMS: 1000,
        maxDelayMS: 10000,
      },
      executionTimeoutMS: 5000,
      sessionCacheTTLMS: 600000,
      otelEndpoint: "https://otel.example/v1/metrics",
      otelToken: "token_123",
      otelServiceName: "cloud-runtime-worker",
      modelSecretResolver: expect.any(Function),
    })
  })

  test("reads shared session worker execution mode from environment values", () => {
    expect(
      config({
        env: {
          CLOUD_RUNTIME_EXECUTION_MODE: "shared-session",
        },
      }).executionMode,
    ).toBe("shared-session")
  })

  test("defaults local worker execution to shared session pool mode", () => {
    expect(config({ env: {} }).executionMode).toBe("shared-session")
  })

  test("keeps explicit local worker lease execution mode for compatibility", () => {
    expect(config({ env: { CLOUD_RUNTIME_EXECUTION_MODE: "lease" } }).executionMode).toBe("lease")
  })

  test("builds a model secret resolver from local worker environment", async () => {
    const cfg = config({
      env: {
        CLOUD_RUNTIME_MODEL_SECRET_SECRET_USER_KEY: "sk-user",
      },
    })

    expect(
      await cfg.modelSecretResolver?.("secret/user/key", {
        jobID: "job_123",
        credentialID: "cred_user",
        credentialVersion: 1,
        providerType: "openai-compatible",
        provider: "openai-compatible",
        secretRef: "secret/user/key",
        model: "qwen-max",
        time: { created: 10, updated: 10 },
      }),
    ).toBe("sk-user")
  })

  test("builds a Kubernetes runner from worker config", async () => {
    const result = setup()
    const requests: Array<{ method: string; path: string }> = []

    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "kubernetes",
      kubernetesRunner: kubernetesRunner({
        namespace: "cloud-runtime",
        serverURL: "https://kubernetes.example",
        token: "token_123",
        pollIntervalMS: 0,
        maxPolls: 2,
        fetch: async (request, init) => {
          requests.push({ method: init?.method ?? "GET", path: new URL(String(request)).pathname })
          if (String(request).includes("/log")) return new Response("done")
          if ((init?.method ?? "GET") === "GET") {
            return Response.json({
              status: {
                phase: "Succeeded",
                containerStatuses: [{ state: { terminated: { exitCode: 0 } } }],
              },
            })
          }
          return Response.json({ metadata: { name: "ok" } })
        },
      }),
    })

    expect(requests.map((request) => request.method)).toEqual(["PATCH", "POST", "GET", "GET", "DELETE", "DELETE"])
    expect(result.db.query("select status from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "succeeded",
    })
  })

  test("runs one SQLite worker tick", async () => {
    const result = setup()

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
      }),
    ).toMatchObject({
      status: "started",
      jobID: result.job.id,
    })
    expect(result.db.query("select status from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "leasing",
    })
  })

  test("can simulate successful local execution after leasing", async () => {
    const result = setup()

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "simulate",
      }),
    ).toMatchObject({
      status: "completed",
      jobID: result.job.id,
    })
    expect(result.db.query("select status from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "succeeded",
    })
  })

  test("exports job metrics after simulated local execution completes", async () => {
    const result = setup()
    const exports: Array<{ name: string; value: number; attributes: Record<string, string> }[]> = []

    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "simulate",
      metricsExporter: async (metrics) => {
        exports.push(metrics)
      },
    })

    expect(exports).toHaveLength(1)
    expect(exports[0].map((item) => item.name)).toEqual([
      "cloud_runtime_job_duration_ms",
      "cloud_runtime_job_cost_usd",
      "cloud_runtime_job_tokens_total",
    ])
    expect(exports[0][0]).toMatchObject({
      value: 100,
      attributes: {
        tenant_id: "tenant_local",
        job_id: result.job.id,
        job_status: "succeeded",
        runtime_engine: "opencode",
      },
    })
  })

  test("leases and acknowledges queued jobs through a queue client", async () => {
    const result = setup()
    const queue = CloudMemoryQueue.create({ now: () => 200 })
    const client = CloudMemoryQueue.client(queue)

    await CloudQueueRunner.run({
      client,
      operations: [
        CloudQueueAdapter.enqueue({
          tenantID: "tenant_local",
          jobID: result.job.id,
          now: 100,
          profile: "standard",
        }),
      ],
    })

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "simulate",
        queueClient: client,
      }),
    ).toMatchObject({
      status: "completed",
      jobID: result.job.id,
    })
    expect(CloudMemoryQueue.snapshot(queue).map((item) => [item.jobID, item.status, item.terminalStatus])).toEqual([
      [result.job.id, "acked", "succeeded"],
    ])
  })

  test("does not lease SQLite work when the queue client rejects the lease", async () => {
    const result = setup()

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "simulate",
        queueClient: {
          lease: async () => ({ leased: false, reason: "missing" }),
        },
      }),
    ).toEqual({ status: "idle", reason: "queue:missing" })
    expect(result.db.query("select status from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "queued",
    })
  })

  test("cleans expired shared session cache even when the worker is idle", async () => {
    const db = new Database(":memory:")
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-shared-cache-idle-"))
    let ids = 0
    CloudSQLiteSchema.apply({ db })
    const service = CloudSQLiteService.create({
      db,
      tenant,
      tools: { mcp: {}, skills: {} },
      now: () => 100,
      id: (prefix) => `${prefix}_${++ids}`,
    })
    const workspace = service.createWorkspace({ name: "Acme" })
    const oldSession = service.createSession({ workspaceID: workspace.id, userID: "user_old" })
    const freshSession = service.createSession({ workspaceID: workspace.id, userID: "user_fresh" })
    db.query("update cloud_session set time_updated = ? where id = ?").run(1_000, oldSession.id)
    db.query("update cloud_session set time_updated = ? where id = ?").run(9_000, freshSession.id)
    await Bun.write(path.join(runtimeRoot, `sessions/${oldSession.id}/workspace/cache.txt`), "old")
    await Bun.write(path.join(runtimeRoot, `sessions/${freshSession.id}/workspace/cache.txt`), "fresh")

    expect(
      await runOnce({
        db,
        now: () => 10_000,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: runtimeRoot,
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "shared-session",
        sessionCacheTTLMS: 3_000,
      }),
    ).toMatchObject({ status: "idle" })
    expect(await Bun.file(path.join(runtimeRoot, `sessions/${oldSession.id}/workspace/cache.txt`)).exists()).toBe(false)
    expect(await Bun.file(path.join(runtimeRoot, `sessions/${freshSession.id}/workspace/cache.txt`)).text()).toBe("fresh")
  })

  test("heartbeats sampled shared runtime metrics while idle", async () => {
    const db = new Database(":memory:")
    CloudSQLiteSchema.apply({ db })
    CloudSQLiteService.create({
      db,
      tenant,
      tools: { mcp: {}, skills: {} },
      now: () => 100,
      id: (prefix) => `${prefix}_abc`,
    }).createWorkspace({ name: "Acme" })

    expect(
      await runOnce({
        db,
        now: () => 10_000,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: "/shared-runtime",
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "shared-session",
        runtimeMetrics: async () => ({
          cpuPercent: 42,
          memoryPercent: 43,
          diskPercent: 44,
          childProcesses: 5,
          openFiles: 12,
        }),
      }),
    ).toMatchObject({ status: "idle" })
    expect(JSON.parse((db.query("select metrics from cloud_runtime_worker where id = ?").get("worker_local") as { metrics: string }).metrics)).toEqual({
      activeJobs: 0,
      busySessions: 0,
      idleSessions: 0,
      cpuPercent: 42,
      memoryPercent: 43,
      diskPercent: 44,
      recentErrorRate: 0,
      heartbeatDelayMS: 0,
      childProcesses: 5,
      openFiles: 12,
    })
  })

  test("can complete a job through the real opencode execution mode", async () => {
    const result = setup()

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "opencode",
        localExecutor: async () => ({
          status: "succeeded",
          manifest: {
            version: 1,
            jobID: result.job.id,
            artifacts: [{ name: "summary.md", path: "summary.md", kind: "md", mime: "text/markdown" }],
          },
          sizeByPath: { "summary.md": 9 },
        }),
      }),
    ).toMatchObject({
      status: "completed",
      jobID: result.job.id,
    })
    expect(result.db.query("select status from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "succeeded",
    })
    expect(result.db.query("select name, size from cloud_artifact where job_id = ?").get(result.job.id)).toEqual({
      name: "summary.md",
      size: 9,
    })
  })

  test("injects resolved BYOK model credentials into opencode execution env", async () => {
    const result = setup()
    const row = result.db.query("select job_spec from cloud_job where id = ?").get(result.job.id) as { job_spec: string }
    result.db.query("update cloud_job set job_spec = ? where id = ?").run(
      JSON.stringify({
        ...JSON.parse(row.job_spec),
        model: { provider: "openai-compatible", model: "qwen-max", credentialID: "cred_user" },
        modelConfigSnapshot: {
          jobID: result.job.id,
          credentialID: "cred_user",
          credentialVersion: 4,
          providerType: "openai-compatible",
          provider: "openai-compatible",
          baseURL: "https://llm.customer.example/v1",
          secretRef: "secret/user/key",
          model: "qwen-max",
          time: { created: 100, updated: 100 },
        },
      }),
      result.job.id,
    )
    const envs: Record<string, string>[] = []

    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "opencode",
      modelSecretResolver: async (secretRef) => secretRef === "secret/user/key" ? "sk-user" : undefined,
      localExecutor: async (input) => {
        envs.push(input.launch.env)
        return {
          status: "succeeded",
          manifest: {
            version: 1,
            jobID: result.job.id,
            artifacts: [{ name: "summary.md", path: "summary.md", kind: "md", mime: "text/markdown" }],
          },
          sizeByPath: { "summary.md": 9 },
        }
      },
    })

    expect(envs[0].OPENAI_API_KEY).toBe("sk-user")
    expect(envs[0].OPENAI_BASE_URL).toBe("https://llm.customer.example/v1")
    expect(JSON.parse(envs[0].OPENCODE_CONFIG_CONTENT).model).toBe("openai-compatible/qwen-max")
  })

  test("can complete a job through shared session pool execution mode", async () => {
    const result = setup({ inputs: ["file_input"] })
    const service = CloudSQLiteService.create({
      db: result.db,
      tenant,
      tools: { mcp: {}, skills: {} },
      now: () => 150,
      id: (prefix) => `${prefix}_runtime`,
    })
    result.db
      .query(
        `insert into cloud_file (
          id, tenant_id, workspace_id, session_id, name, mime, size, object_key, sha256, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "file_input",
        "tenant_local",
        "workspace_abc",
        "session_abc",
        "input.csv",
        "text/csv",
        10,
        "tenant_local/workspace_abc/session_abc/files/file_input/input.csv",
        null,
        100,
        100,
      )
    service.registerRuntimeWorker({
      runtimeID: "runtime_shared",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 2,
      maxSessions: 20,
    })
    const runtimes: string[] = []

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: "/shared-runtime",
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "shared-session",
        sharedRuntime: async (input) => {
          runtimes.push(input.runtimeID)
          expect(input.launch.cwd).toBe("/shared-runtime/sessions/session_abc/jobs/job_abc")
          expect(input.launch.artifactManifest).toBe(
            "/shared-runtime/sessions/session_abc/jobs/job_abc/.opencode-cloud/artifacts.json",
          )
          expect(input.launch.env.OPENCODE_RUNTIME_WORKSPACE_DIR).toBe(
            "/shared-runtime/sessions/session_abc/workspace",
          )
          expect(input.launch.env.OPENCODE_RUNTIME_INPUT_DIR).toBe(
            "/shared-runtime/sessions/session_abc/jobs/job_abc/input",
          )
          expect(input.launch.env.OPENCODE_RUNTIME_OUTPUT_DIR).toBe(
            "/shared-runtime/sessions/session_abc/jobs/job_abc/output",
          )
          expect(input.launch.env.OPENCODE_RUNTIME_ARTIFACT_MANIFEST).toBe(
            "/shared-runtime/sessions/session_abc/jobs/job_abc/.opencode-cloud/artifacts.json",
          )
          expect(input.workspace.downloads).toEqual([
            {
              source: "file",
              id: "file_input",
              objectKey: "tenant_local/workspace_abc/session_abc/files/file_input/input.csv",
              targetPath: "/shared-runtime/sessions/session_abc/jobs/job_abc/input/file_input-input.csv",
            },
          ])
          return {
            status: "succeeded",
            manifest: {
              version: 1,
              jobID: result.job.id,
              artifacts: [{ name: "summary.md", path: "summary.md", kind: "md", mime: "text/markdown" }],
            },
            sizeByPath: { "summary.md": 12 },
          }
        },
      }),
    ).toMatchObject({
      status: "completed",
      jobID: result.job.id,
      runtimeID: "runtime_shared",
    })
    expect(runtimes).toEqual(["runtime_shared"])
    expect(result.db.query("select runtime_id from cloud_session_runtime_binding where session_id = ?").get("session_abc")).toEqual({
      runtime_id: "runtime_shared",
    })
    expect(result.db.query("select name, size from cloud_artifact where job_id = ?").get(result.job.id)).toEqual({
      name: "summary.md",
      size: 12,
    })
  })

  test("auto-registers a local shared runtime worker before assigning jobs", async () => {
    const result = setup()

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: "/shared-runtime",
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "shared-session",
        sharedRuntimeVersion: "1.14.28",
        sharedRuntimeProfile: "standard",
        sharedRuntimeMaxActiveJobs: 3,
        sharedRuntimeMaxSessions: 30,
        sharedRuntime: async () => ({
          status: "succeeded",
          manifest: {
            version: 1,
            jobID: result.job.id,
            artifacts: [],
          },
          sizeByPath: {},
        }),
      }),
    ).toMatchObject({
      status: "completed",
      jobID: result.job.id,
      runtimeID: "worker_local",
    })
    expect(
      result.db
        .query("select id, version, profile, max_active_jobs, max_sessions from cloud_runtime_worker where id = ?")
        .get("worker_local"),
    ).toEqual({
      id: "worker_local",
      version: "1.14.28",
      profile: "standard",
      max_active_jobs: 3,
      max_sessions: 30,
    })
  })

  test("updates shared runtime load metrics while a job is running", async () => {
    const result = setup()
    const observed: unknown[] = []

    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: "/shared-runtime",
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "shared-session",
      sharedRuntimeMaxActiveJobs: 3,
      sharedRuntimeMaxSessions: 30,
      sharedRuntime: async () => {
        observed.push(JSON.parse((result.db.query("select metrics from cloud_runtime_worker where id = ?").get("worker_local") as { metrics: string }).metrics))
        return {
          status: "succeeded",
          manifest: {
            version: 1,
            jobID: result.job.id,
            artifacts: [],
          },
          sizeByPath: {},
        }
      },
    })

    expect(observed).toEqual([
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
    ])
    expect(JSON.parse((result.db.query("select metrics from cloud_runtime_worker where id = ?").get("worker_local") as { metrics: string }).metrics)).toEqual({
      activeJobs: 0,
      busySessions: 0,
      idleSessions: 1,
      cpuPercent: 0,
      memoryPercent: 0,
      diskPercent: 0,
      recentErrorRate: 0,
      heartbeatDelayMS: 0,
    })
  })

  test("does not reactivate a drained shared runtime during auto-registration", async () => {
    const result = setup()
    const service = CloudSQLiteService.create({
      db: result.db,
      tenant,
      tools: { mcp: {}, skills: {} },
      now: () => 150,
      id: (prefix) => `${prefix}_runtime`,
    })
    service.registerRuntimeWorker({
      runtimeID: "worker_local",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 3,
      maxSessions: 30,
    })
    service.drainRuntimeWorker({ runtimeID: "worker_local" })

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: "/shared-runtime",
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "shared-session",
        sharedRuntime: async () => {
          throw new Error("drained runtime should not start")
        },
      }),
    ).toMatchObject({
      status: "failed",
      jobID: result.job.id,
    })
    expect(result.db.query("select status from cloud_runtime_worker where id = ?").get("worker_local")).toEqual({
      status: "draining",
    })
    expect(result.db.query("select status, error from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "failed",
      error: "Cloud runtime capacity exhausted",
    })
  })

  test("restores shared session inputs before execution and cleans job workspace after artifact upload", async () => {
    const result = setup({ inputs: ["file_input"] })
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-shared-worker-"))
    const service = CloudSQLiteService.create({
      db: result.db,
      tenant,
      tools: { mcp: {}, skills: {} },
      now: () => 150,
      id: (prefix) => `${prefix}_runtime`,
    })
    result.db
      .query(
        `insert into cloud_file (
          id, tenant_id, workspace_id, session_id, name, mime, size, object_key, sha256, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "file_input",
        "tenant_local",
        "workspace_abc",
        "session_abc",
        "input.csv",
        "text/csv",
        10,
        "tenant_local/workspace_abc/session_abc/files/file_input/input.csv",
        null,
        100,
        100,
      )
    service.registerRuntimeWorker({
      runtimeID: "runtime_shared",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 2,
      maxSessions: 20,
    })
    const gets: string[] = []
    const puts: Array<{ objectKey: string; body: Uint8Array }> = []

    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: runtimeRoot,
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "shared-session",
      storageClient: {
        getObject: async (input) => {
          gets.push(input.objectKey)
          return "a,b\n1,2\n"
        },
        putObject: async (input) => {
          puts.push({ objectKey: input.objectKey, body: input.body as Uint8Array })
          return { etag: "etag_summary" }
        },
      },
      sharedRuntime: async (input) => {
        expect(await Bun.file(path.join(input.launch.cwd, "input/file_input-input.csv")).text()).toBe("a,b\n1,2\n")
        await Bun.write(path.join(input.launch.cwd, "summary.md"), "# Shared Summary\n")
        return {
          status: "succeeded",
          manifest: {
            version: 1,
            jobID: result.job.id,
            artifacts: [{ name: "summary.md", path: "summary.md", kind: "md", mime: "text/markdown" }],
          },
          sizeByPath: { "summary.md": 17 },
        }
      },
    })

    expect(gets).toEqual(["tenant_local/workspace_abc/session_abc/files/file_input/input.csv"])
    expect(puts).toEqual([
      {
        objectKey: "tenant_local/job_abc/artifacts/summary.md",
        body: new Uint8Array(Buffer.from("# Shared Summary\n")),
      },
    ])
    expect(await Bun.file(path.join(runtimeRoot, "sessions/session_abc/jobs/job_abc/summary.md")).exists()).toBe(false)
    expect((await stat(path.join(runtimeRoot, "sessions/session_abc/workspace"))).isDirectory()).toBe(true)
  })

  test("restores previous shared-session artifacts from object storage before the next job", async () => {
    const db = new Database(":memory:")
    CloudSQLiteSchema.apply({ db })
    const ids: Record<string, number> = {}
    const service = CloudSQLiteService.create({
      db,
      tenant,
      tools: { mcp: {}, skills: {} },
      now: () => 100,
      id: (prefix) => `${prefix}_${ids[prefix] = (ids[prefix] ?? 0) + 1}`,
    })
    const workspace = service.createWorkspace({ name: "Acme" })
    const session = service.createSession({ workspaceID: workspace.id, userID: "user_local" })
    const first = service.createJob({
      sessionID: session.id,
      prompt: "Create first summary",
      inputs: [],
      outputs: ["md"],
      runtime: { profile: "standard" },
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: [],
        skills: [],
      },
    })
    service.registerRuntimeWorker({
      runtimeID: "runtime_shared",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 2,
      maxSessions: 20,
    })
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-shared-worker-continuity-"))
    const objects: Record<string, Uint8Array> = {}
    const storageClient = {
      getObject: async (input: { objectKey: string }) => {
        const body = objects[input.objectKey]
        if (!body) throw new Error(`missing object ${input.objectKey}`)
        return body
      },
      putObject: async (input: { objectKey: string; body: string | Uint8Array | ArrayBuffer | Blob }) => {
        objects[input.objectKey] = input.body instanceof Blob || typeof input.body === "string"
          ? new Uint8Array(await new Response(input.body).arrayBuffer())
          : new Uint8Array(input.body)
        return { etag: `etag_${input.objectKey}` }
      },
    }

    await runOnce({
      db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: runtimeRoot,
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "shared-session",
      storageClient,
      sharedRuntime: async (input) => {
        await Bun.write(path.join(input.launch.cwd, "summary.md"), "# First Summary\n")
        return {
          status: "succeeded",
          manifest: {
            version: 1,
            jobID: first.id,
            artifacts: [{ name: "summary.md", path: "summary.md", kind: "md", mime: "text/markdown" }],
          },
          sizeByPath: { "summary.md": 16 },
        }
      },
    })

    const second = service.createJob({
      sessionID: session.id,
      prompt: "Use previous summary",
      inputs: [],
      outputs: ["md"],
      runtime: { profile: "standard" },
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: [],
        skills: [],
      },
    })
    const restored: string[] = []

    await runOnce({
      db,
      now: () => 300,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: runtimeRoot,
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "shared-session",
      storageClient,
      sharedRuntime: async (input) => {
        restored.push(...input.workspace.downloads.filter((download) => download.source === "artifact").map((download) => download.targetPath))
        expect(await Bun.file(restored[0]).text()).toBe("# First Summary\n")
        await Bun.write(path.join(input.launch.cwd, "followup.md"), "# Followup\n")
        return {
          status: "succeeded",
          manifest: {
            version: 1,
            jobID: second.id,
            artifacts: [{ name: "followup.md", path: "followup.md", kind: "md", mime: "text/markdown" }],
          },
          sizeByPath: { "followup.md": 11 },
        }
      },
    })

    expect(restored).toEqual([
      path.join(runtimeRoot, "sessions/session_1/workspace/artifacts/job_1/job_1-artifact-000000000001-summary.md"),
    ])
    expect(db.query("select status from cloud_job where id = ?").get(second.id)).toEqual({ status: "succeeded" })
  })

  test("fails a shared session job when input restore fails", async () => {
    const result = setup({ inputs: ["file_input"] })
    const service = CloudSQLiteService.create({
      db: result.db,
      tenant,
      tools: { mcp: {}, skills: {} },
      now: () => 150,
      id: (prefix) => `${prefix}_runtime`,
    })
    result.db
      .query(
        `insert into cloud_file (
          id, tenant_id, workspace_id, session_id, name, mime, size, object_key, sha256, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "file_input",
        "tenant_local",
        "workspace_abc",
        "session_abc",
        "input.csv",
        "text/csv",
        10,
        "tenant_local/workspace_abc/session_abc/files/file_input/input.csv",
        null,
        100,
        100,
      )
    service.registerRuntimeWorker({
      runtimeID: "runtime_shared",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 2,
      maxSessions: 20,
    })

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: await mkdtemp(path.join(os.tmpdir(), "opencode-shared-worker-restore-fail-")),
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "shared-session",
        storageClient: {
          getObject: async () => {
            throw new Error("storage unavailable")
          },
        },
        sharedRuntime: async () => {
          throw new Error("runtime should not start")
        },
      }),
    ).toMatchObject({
      status: "failed",
      jobID: result.job.id,
    })
    expect(result.db.query("select status, error from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "failed",
      error: "storage unavailable",
    })
  })

  test("can complete a job through Kubernetes execution mode", async () => {
    const result = setup()

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "kubernetes",
        kubernetesRunner: async () => ({
          jobID: result.job.id,
          podName: "opencode-job-abc",
          status: "succeeded",
          logs: "done",
          podStatus: { phase: "Succeeded", exitCode: 0 },
          manifest: {
            version: 1,
            jobID: result.job.id,
            artifacts: [{ name: "summary.md", path: "summary.md", kind: "md", mime: "text/markdown" }],
          },
          sizeByPath: { "summary.md": 11 },
        }),
      }),
    ).toMatchObject({
      status: "completed",
      jobID: result.job.id,
    })
    expect(result.db.query("select status from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "succeeded",
    })
    expect(result.db.query("select name, size from cloud_artifact where job_id = ?").get(result.job.id)).toEqual({
      name: "summary.md",
      size: 11,
    })
  })

  test("fails a job when Kubernetes execution fails", async () => {
    const result = setup()

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "kubernetes",
        kubernetesRunner: async () => ({
          jobID: result.job.id,
          podName: "opencode-job-abc",
          status: "failed",
          logs: "runtime failed",
          podStatus: { phase: "Failed", exitCode: 1, reason: "Error" },
        }),
      }),
    ).toMatchObject({
      status: "failed",
      jobID: result.job.id,
    })
    expect(result.db.query("select status, error from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "failed",
      error: "Kubernetes sandbox opencode-job-abc failed: runtime failed",
    })
  })

  test("acknowledges the queue as succeeded after Kubernetes execution completes", async () => {
    const result = setup()
    const queue = CloudMemoryQueue.create({ now: () => 200 })
    const client = CloudMemoryQueue.client(queue)

    await CloudQueueRunner.run({
      client,
      operations: [
        CloudQueueAdapter.enqueue({
          tenantID: "tenant_local",
          jobID: result.job.id,
          now: 100,
          profile: "standard",
        }),
      ],
    })
    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "kubernetes",
      queueClient: client,
      kubernetesRunner: async () => ({
        jobID: result.job.id,
        podName: "opencode-job-abc",
        status: "succeeded",
        logs: "done",
        podStatus: { phase: "Succeeded", exitCode: 0 },
      }),
    })

    expect([...queue.messages.values()].map((message) => [message.status, message.terminalStatus])).toEqual([
      ["acked", "succeeded"],
    ])
  })

  test("uploads Kubernetes artifacts to object storage before completing the job", async () => {
    const result = setup()
    const calls: unknown[] = []

    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: path.join(process.env.TMPDIR ?? "/tmp", "opencode-k8s-worker-upload"),
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "kubernetes",
      storageClient: {
        putObject: async (input) => {
          calls.push(input)
          return { etag: "etag_abc" }
        },
      },
      kubernetesRunner: async (input) => {
        await Bun.write(path.join(input.launch.cwd, "summary.md"), "# Kubernetes Summary\n")
        return {
          jobID: result.job.id,
          podName: "opencode-job-abc",
          status: "succeeded",
          logs: "done",
          podStatus: { phase: "Succeeded", exitCode: 0 },
          manifest: {
            version: 1,
            jobID: result.job.id,
            artifacts: [{ name: "summary.md", path: "summary.md", kind: "md", mime: "text/markdown", sha256: "sha_k8s" }],
          },
          sizeByPath: { "summary.md": 21 },
        }
      },
    })

    expect(calls).toEqual([
      {
        bucket: "runtime",
        objectKey: "tenant_local/job_abc/artifacts/summary.md",
        body: new Uint8Array(Buffer.from("# Kubernetes Summary\n")),
        contentType: "text/markdown",
        contentLength: 21,
        metadata: {
          "tenant-id": "tenant_local",
          "workspace-id": "workspace_abc",
          "session-id": "session_abc",
          "job-id": "job_abc",
          sha256: "sha_k8s",
        },
      },
    ])
    expect(result.db.query("select status from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "succeeded",
    })
  })

  test("fails the job when Kubernetes artifact upload fails", async () => {
    const result = setup()

    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: path.join(process.env.TMPDIR ?? "/tmp", "opencode-k8s-worker-upload-fail"),
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "kubernetes",
      storageClient: {
        putObject: async () => {
          throw new Error("k8s storage unavailable")
        },
      },
      kubernetesRunner: async (input) => {
        await Bun.write(path.join(input.launch.cwd, "summary.md"), "# Kubernetes Summary\n")
        return {
          jobID: result.job.id,
          podName: "opencode-job-abc",
          status: "succeeded",
          logs: "done",
          podStatus: { phase: "Succeeded", exitCode: 0 },
          manifest: {
            version: 1,
            jobID: result.job.id,
            artifacts: [{ name: "summary.md", path: "summary.md", kind: "md", mime: "text/markdown" }],
          },
          sizeByPath: { "summary.md": 21 },
        }
      },
    })

    expect(result.db.query("select status, error from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "failed",
      error: "k8s storage unavailable",
    })
    expect(result.db.query("select count(*) as count from cloud_artifact where job_id = ?").get(result.job.id)).toEqual({
      count: 0,
    })
  })

  test("uploads opencode artifacts to object storage before completing the job", async () => {
    const result = setup()
    const calls: unknown[] = []

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: path.join(process.env.TMPDIR ?? "/tmp", "opencode-local-worker-upload"),
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "opencode",
        storageClient: {
          putObject: async (input) => {
            calls.push(input)
            return { etag: "etag_abc" }
          },
        },
        localExecutor: async (input) => {
          await Bun.write(path.join(input.launch.cwd, "summary.md"), "# Summary\n")
          return {
            status: "succeeded",
            manifest: {
              version: 1,
              jobID: result.job.id,
              artifacts: [{ name: "summary.md", path: "summary.md", kind: "md", mime: "text/markdown", sha256: "sha_abc" }],
            },
            sizeByPath: { "summary.md": 10 },
          }
        },
      }),
    ).toMatchObject({
      status: "completed",
      jobID: result.job.id,
    })
    expect(calls).toEqual([
      {
        bucket: "runtime",
        objectKey: "tenant_local/job_abc/artifacts/summary.md",
        body: new Uint8Array(Buffer.from("# Summary\n")),
        contentType: "text/markdown",
        contentLength: 10,
        metadata: {
          "tenant-id": "tenant_local",
          "workspace-id": "workspace_abc",
          "session-id": "session_abc",
          "job-id": "job_abc",
          sha256: "sha_abc",
        },
      },
    ])
    expect(result.db.query("select status from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "succeeded",
    })
  })

  test("fails the job when artifact upload fails", async () => {
    const result = setup()

    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: path.join(process.env.TMPDIR ?? "/tmp", "opencode-local-worker-upload-fail"),
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "opencode",
      storageClient: {
        putObject: async () => {
          throw new Error("storage unavailable")
        },
      },
      localExecutor: async (input) => {
        await Bun.write(path.join(input.launch.cwd, "summary.md"), "# Summary\n")
        return {
          status: "succeeded",
          manifest: {
            version: 1,
            jobID: result.job.id,
            artifacts: [{ name: "summary.md", path: "summary.md", kind: "md", mime: "text/markdown" }],
          },
          sizeByPath: { "summary.md": 10 },
        }
      },
    })

    expect(result.db.query("select status, error from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "failed",
      error: "storage unavailable",
    })
    expect(result.db.query("select count(*) as count from cloud_artifact where job_id = ?").get(result.job.id)).toEqual({
      count: 0,
    })
  })

  test("fails a job when opencode execution fails", async () => {
    const result = setup()

    expect(
      await runOnce({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
        executionMode: "opencode",
        localExecutor: async () => ({
          status: "failed",
          exitCode: 1,
          message: "Local opencode executor exited with code 1: boom",
          stdout: "",
          stderr: "boom",
        }),
      }),
    ).toMatchObject({
      status: "failed",
      jobID: result.job.id,
    })
    expect(result.db.query("select status, error from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "failed",
      error: "Local opencode executor exited with code 1: boom",
    })
    expect(result.db.query("select status, error from cloud_job_attempt where job_id = ?").get(result.job.id)).toEqual({
      status: "failed",
      error: "Local opencode executor exited with code 1: boom",
    })
    expect(
      result.db
        .query("select type from cloud_job_event where job_id = ? order by sequence")
        .all(result.job.id)
        .map((row) => (row as { type: string }).type),
    ).toContain("job.error")
  })

  test("acknowledges the queue as failed when opencode execution fails", async () => {
    const result = setup()
    const queue = CloudMemoryQueue.create({ now: () => 200 })
    const client = CloudMemoryQueue.client(queue)

    await CloudQueueRunner.run({
      client,
      operations: [
        CloudQueueAdapter.enqueue({
          tenantID: "tenant_local",
          jobID: result.job.id,
          now: 100,
          profile: "standard",
        }),
      ],
    })
    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "opencode",
      queueClient: client,
      localExecutor: async () => ({
        status: "failed",
        exitCode: 1,
        message: "Local opencode executor exited with code 1: boom",
        stdout: "",
        stderr: "boom",
      }),
    })

    expect(CloudMemoryQueue.snapshot(queue).map((item) => [item.jobID, item.status, item.terminalStatus])).toEqual([
      [result.job.id, "acked", "failed"],
    ])
  })

  test("retries failed opencode execution through configured queue backoff", async () => {
    const result = setup()
    const queue = CloudMemoryQueue.create({ now: () => 200 })
    const client = CloudMemoryQueue.client(queue)

    await CloudQueueRunner.run({
      client,
      operations: [
        CloudQueueAdapter.enqueue({
          tenantID: "tenant_local",
          jobID: result.job.id,
          now: 100,
          profile: "standard",
        }),
      ],
    })
    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "opencode",
      queueClient: client,
      retry: { maxAttempts: 3, baseDelayMS: 1000, maxDelayMS: 10_000 },
      localExecutor: async () => ({
        status: "failed",
        exitCode: 1,
        message: "Local opencode executor exited with code 1: boom",
        stdout: "",
        stderr: "boom",
      }),
    })

    expect(result.db.query("select status, error from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "queued",
      error: "Local opencode executor exited with code 1: boom",
    })
    expect(CloudMemoryQueue.snapshot(queue).map((item) => [item.jobID, item.status, item.runAt, item.attempt, item.reason])).toEqual([
      [result.job.id, "queued", 1200, 2, "Local opencode executor exited with code 1: boom"],
    ])
  })

  test("expires opencode execution when configured timeout elapses", async () => {
    const result = setup()
    const queue = CloudMemoryQueue.create({ now: () => 200 })
    const client = CloudMemoryQueue.client(queue)

    await CloudQueueRunner.run({
      client,
      operations: [
        CloudQueueAdapter.enqueue({
          tenantID: "tenant_local",
          jobID: result.job.id,
          now: 100,
          profile: "standard",
        }),
      ],
    })
    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "opencode",
      executionTimeoutMS: 1,
      queueClient: client,
      localExecutor: async () => {
        await Bun.sleep(20)
        return {
          status: "failed",
          message: "late failure",
        }
      },
    })

    expect(result.db.query("select status, error from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "expired",
      error: "execution timeout",
    })
    expect(CloudMemoryQueue.snapshot(queue).map((item) => [item.jobID, item.status, item.terminalStatus])).toEqual([
      [result.job.id, "acked", "expired"],
    ])
  })

  test("acknowledges canceled jobs when opencode returns after API cancellation", async () => {
    const result = setup()
    const queue = CloudMemoryQueue.create({ now: () => 200 })
    const client = CloudMemoryQueue.client(queue)

    await CloudQueueRunner.run({
      client,
      operations: [
        CloudQueueAdapter.enqueue({
          tenantID: "tenant_local",
          jobID: result.job.id,
          now: 100,
          profile: "standard",
        }),
      ],
    })
    await runOnce({
      db: result.db,
      now: () => 200,
      workerID: "worker_local",
      tenantID: "tenant_local",
      leaseTTLMS: 1000,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
      executionMode: "opencode",
      queueClient: client,
      localExecutor: async () => {
        result.db
          .query("update cloud_job set status = 'canceled', error = ?, time_updated = ? where id = ?")
          .run("user canceled", 150, result.job.id)
        return {
          status: "succeeded",
          manifest: { version: 1, jobID: result.job.id, artifacts: [] },
          sizeByPath: {},
        }
      },
    })

    expect(result.db.query("select status, error from cloud_job where id = ?").get(result.job.id)).toEqual({
      status: "canceled",
      error: "user canceled",
    })
    expect(result.db.query("select status, error from cloud_job_attempt where job_id = ?").get(result.job.id)).toEqual({
      status: "canceled",
      error: "user canceled",
    })
    expect(CloudMemoryQueue.snapshot(queue).map((item) => [item.jobID, item.status, item.terminalStatus])).toEqual([
      [result.job.id, "acked", "canceled"],
    ])
  })

  test("runs a bounded worker poll loop for local development", async () => {
    const result = setup()

    expect(
      await runSteps({
        db: result.db,
        now: () => 200,
        workerID: "worker_local",
        tenantID: "tenant_local",
        leaseTTLMS: 1000,
        pollIntervalMS: 0,
        steps: 2,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
      }),
    ).toEqual({
      steps: 2,
      started: 1,
      idle: 1,
      errors: 0,
    })
  })
})
