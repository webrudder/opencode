import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { CloudRuntimePool } from "../../src/cloud/runtime-pool"
import { CloudSQLiteRepository } from "../../src/cloud/sqlite-repository"
import { CloudSQLiteSchema } from "../../src/cloud/sqlite-schema"
import { CloudSQLiteService } from "../../src/cloud/sqlite-service"
import { CloudSQLiteWorkerLoop } from "../../src/cloud/sqlite-worker-loop"
import { CloudModelSecretStore } from "../../src/cloud/model-secret-store"

const tenant = {
  id: "tenant_abc",
  defaultRuntimeVersion: "1.14.28",
  defaultRuntimeImage: "registry.example.com/cloud-runtime-opencode:1.14.28",
  defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
  allowedModels: ["anthropic/claude-sonnet-4-5"],
}

const tools = {
  mcp: {},
  skills: {},
}

function createService() {
  const db = new Database(":memory:")
  const modelSecretStore = CloudModelSecretStore.memory()
  CloudSQLiteSchema.apply({ db })
  return {
    db,
    modelSecretStore,
    service: CloudSQLiteService.create({
      db,
      tenant,
      tools,
      now: () => 10,
      id: (prefix) => `${prefix}_abc`,
      modelSecretStore,
    }),
  }
}

describe("CloudSQLiteService", () => {
  test("creates workspace and session rows in SQLite", () => {
    const result = createService()
    const workspace = result.service.createWorkspace({ name: "Acme" })
    const session = result.service.createSession({
      workspaceID: workspace.id,
      userID: "user_abc",
      title: "Analysis",
    })

    expect(result.db.query("select id, tenant_id, name from cloud_workspace").get()).toEqual({
      id: "workspace_abc",
      tenant_id: "tenant_abc",
      name: "Acme",
    })
    expect(result.db.query("select id, workspace_id, user_id, title from cloud_session").get()).toEqual({
      id: "session_abc",
      workspace_id: "workspace_abc",
      user_id: "user_abc",
      title: "Analysis",
    })
    expect(session.workspaceID).toBe(workspace.id)
  })

  test("creates queued jobs, prompt messages, and initial events in SQLite", () => {
    const result = createService()
    const workspace = result.service.createWorkspace({ name: "Acme" })
    const session = result.service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    const job = result.service.createJob({
      sessionID: session.id,
      prompt: "Summarize files",
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

    expect(job).toMatchObject({ id: "job_abc", status: "queued", sessionID: session.id })
    expect(CloudSQLiteRepository.getJobSpec({ db: result.db, tenantID: tenant.id, id: job.id })?.outputs).toEqual([
      "md",
    ])
    expect(CloudSQLiteRepository.getJobPrompt({ db: result.db, tenantID: tenant.id, jobID: job.id })?.prompt).toBe(
      "Summarize files",
    )
    expect(result.service.listJobEvents({ jobID: job.id }).map((event) => event.type)).toEqual(["job.status"])
  })

  test("creates session messages and file metadata for API routes", () => {
    const result = createService()
    const workspace = result.service.createWorkspace({ name: "Acme" })
    const session = result.service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    const message = result.service.createSessionMessage(session.id, { content: "Continue" })

    expect(result.service.listSessionMessages({ sessionID: session.id }).map((item) => item.content)).toEqual([
      "Continue",
    ])
    expect(message.role).toBe("user")
  })

  test("creates webhook subscription rows in SQLite", () => {
    const result = createService()
    const webhook = result.service.createWebhook({
      url: "https://saas.example.com/hooks/runtime",
      events: ["job.status"],
      secret: "secret_abc",
    })

    expect(webhook).toMatchObject({
      id: "webhook_abc",
      tenantID: "tenant_abc",
      url: "https://saas.example.com/hooks/runtime",
      events: ["job.status"],
      enabled: true,
    })
    expect(result.db.query("select id, tenant_id, url, events, enabled from cloud_webhook_subscription").get()).toEqual({
      id: "webhook_abc",
      tenant_id: "tenant_abc",
      url: "https://saas.example.com/hooks/runtime",
      events: JSON.stringify(["job.status"]),
      enabled: 1,
    })
    expect(result.service.listWebhooks().map((item) => item.id)).toEqual(["webhook_abc"])
    expect(result.service.updateWebhook({ webhookID: webhook.id, enabled: false }).enabled).toBe(false)
    expect(result.db.query("select enabled from cloud_webhook_subscription where id = ?").get(webhook.id)).toEqual({
      enabled: 0,
    })
    expect(result.service.deleteWebhook({ webhookID: webhook.id }).id).toBe(webhook.id)
    expect(result.db.query("select id from cloud_webhook_subscription where id = ?").get(webhook.id)).toBeNull()
    expect(result.service.listWebhooks()).toEqual([])
  })

  test("persists runtime workers and session runtime bindings in SQLite", () => {
    const result = createService()
    const workspace = result.service.createWorkspace({ name: "Acme" })
    const session = result.service.createSession({ workspaceID: workspace.id, userID: "user_abc" })

    result.service.registerRuntimeWorker({
      runtimeID: "runtime_abc",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 4,
      maxSessions: 20,
    })
    result.service.heartbeatRuntimeWorker("runtime_abc", {
      status: "healthy",
      metrics: {
        activeJobs: 1,
        busySessions: 1,
        idleSessions: 2,
        cpuPercent: 20,
        memoryPercent: 30,
        diskPercent: 10,
        recentErrorRate: 0,
        heartbeatDelayMS: 5,
      },
    })

    expect(result.service.listRuntimeWorkers().map((runtime) => runtime.id)).toEqual(["runtime_abc"])
    expect(result.service.assignSessionRuntime({ sessionID: session.id }).runtimeID).toBe("runtime_abc")
    expect(result.db.query("select runtime_id from cloud_session_runtime_binding where session_id = ?").get(session.id)).toEqual({
      runtime_id: "runtime_abc",
    })
    expect(result.service.drainRuntimeWorker({ runtimeID: "runtime_abc" }).status).toBe("draining")
    expect(result.service.restartRuntimeWorker({ runtimeID: "runtime_abc" })).toMatchObject({
      status: "healthy",
      metrics: { activeJobs: 0, busySessions: 0, idleSessions: 0 },
    })
    expect(result.service.releaseSessionRuntime({ sessionID: session.id }).runtimeID).toBe("runtime_abc")
    expect(result.service.getSessionRuntimeBinding({ sessionID: session.id })).toBeUndefined()
  })

  test("reconciles stale runtime workers and releases their SQLite session bindings", () => {
    const result = createService()
    const workspace = result.service.createWorkspace({ name: "Acme" })
    const session = result.service.createSession({ workspaceID: workspace.id, userID: "user_abc" })

    result.service.registerRuntimeWorker({
      runtimeID: "runtime_stale",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 4,
      maxSessions: 20,
    })
    result.service.assignSessionRuntime({ sessionID: session.id })

    const reconciled = CloudSQLiteService.create({
      db: result.db,
      tenant,
      tools: { mcp: {}, skills: {} },
      now: () => 5_000,
      id: (prefix) => `${prefix}_later`,
    }).reconcileRuntimePool({ heartbeatTTLMS: 3_000 })

    expect(reconciled.offlineRuntimeIDs).toEqual(["runtime_stale"])
    expect(reconciled.releasedSessionIDs).toEqual([session.id])
    expect(result.db.query("select status, time_updated from cloud_runtime_worker where id = ?").get("runtime_stale")).toEqual({
      status: "offline",
      time_updated: 5_000,
    })
    expect(result.db.query("select runtime_id from cloud_session_runtime_binding where session_id = ?").get(session.id)).toBeNull()
  })

  test("applies runtime pool plans to SQLite runtime and binding rows", () => {
    const result = createService()
    const workspace = result.service.createWorkspace({ name: "Acme" })
    const session = result.service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    result.service.registerRuntimeWorker({
      runtimeID: "runtime_idle",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 10,
      maxSessions: 50,
    })
    result.service.registerRuntimeWorker({
      runtimeID: "runtime_offline",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 10,
      maxSessions: 50,
      status: "offline",
    })
    const binding = CloudRuntimePool.bindSession({
      tenantID: tenant.id,
      sessionID: session.id,
      runtimeID: "runtime_offline",
      now: 10,
    })
    result.db
      .query(
        `insert into cloud_session_runtime_binding (
          tenant_id, session_id, runtime_id, time_created, time_updated
        ) values (?, ?, ?, ?, ?)`,
      )
      .run(binding.tenantID, binding.sessionID, binding.runtimeID, binding.time.created, binding.time.updated)

    expect(result.service.applyRuntimePoolPlan()).toEqual({
      desiredRuntimes: 1,
      action: "scale_down",
      reason: "idle_capacity",
      drainedRuntimeIDs: ["runtime_idle"],
      releasedSessionIDs: [session.id],
      scaleOperations: [
        {
          action: "scale",
          target: "local",
          desiredRuntimes: 1,
          currentRuntimes: 2,
        },
        {
          action: "drain",
          target: "local",
          runtimeID: "runtime_idle",
        },
        {
          action: "release_session",
          target: "local",
          sessionID: session.id,
        },
      ],
    })
    expect(result.db.query("select status from cloud_runtime_worker where id = ?").get("runtime_idle")).toEqual({
      status: "draining",
    })
    expect(result.db.query("select runtime_id from cloud_session_runtime_binding where session_id = ?").get(session.id)).toBeNull()
  })

  test("persists integrator runtime policy updates in SQLite", () => {
    const result = createService()

    expect(result.service.getIntegratorRuntimePolicy({ integratorID: "integrator_abc" })).toBeUndefined()
    expect(result.service.updateIntegratorRuntimePolicy("integrator_abc", {
      defaultExecutionMode: "shared_session_pool",
      allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
      maxActiveJobs: 10,
      maxSessions: 500,
      maxConcurrentJobsPerSession: 1,
    })).toEqual({
      tenantID: tenant.id,
      integratorID: "integrator_abc",
      defaultExecutionMode: "shared_session_pool",
      allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
      maxActiveJobs: 10,
      maxSessions: 500,
      maxConcurrentJobsPerSession: 1,
    })
    expect(result.service.getIntegratorRuntimePolicy({ integratorID: "integrator_abc" })).toMatchObject({
      integratorID: "integrator_abc",
      maxSessions: 500,
    })
    expect(result.db.query("select default_execution_mode, max_sessions from cloud_integrator_runtime_policy where tenant_id = ? and integrator_id = ?").get(tenant.id, "integrator_abc")).toEqual({
      default_execution_mode: "shared_session_pool",
      max_sessions: 500,
    })
  })

  test("uses persisted integrator runtime policy when creating SQLite jobs", () => {
    const result = createService()
    const workspace = result.service.createWorkspace({ name: "Acme" })
    const session = result.service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    result.service.updateIntegratorRuntimePolicy("integrator_abc", {
      defaultExecutionMode: "isolated_job_runtime",
      allowedExecutionModes: ["isolated_job_runtime", "shared_session_pool"],
      maxActiveJobs: 10,
      maxSessions: 500,
      maxConcurrentJobsPerSession: 1,
    })

    const job = result.service.createJob({
      sessionID: session.id,
      prompt: "Run isolated",
      inputs: [],
      outputs: ["md"],
      runtime: { profile: "standard" },
      integratorID: "integrator_abc",
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: [],
        skills: [],
      },
    })

    expect(job.executionMode).toBe("isolated_job_runtime")
    expect(result.db.query("select execution_mode from cloud_job where id = ?").get(job.id)).toEqual({
      execution_mode: "isolated_job_runtime",
    })
  })

  test("freezes persisted BYOK credentials when creating SQLite jobs", () => {
    const result = createService()
    const workspace = result.service.createWorkspace({ name: "Acme" })
    const session = result.service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    const credential = result.service.createLLMCredential({
      scope: "integrator",
      ownerKey: "integrator_abc",
      name: "Customer OpenAI",
      providerType: "openai-compatible",
      provider: "openai",
      apiKey: "sk-test",
      allowedModels: ["gpt-5"],
      defaultModel: "gpt-5",
      enabled: true,
    })

    const job = result.service.createJob({
      sessionID: session.id,
      prompt: "Use customer key",
      inputs: [],
      outputs: ["md"],
      runtime: { profile: "standard" },
      integratorID: "integrator_abc",
      model: { credentialID: credential.id, provider: "openai", model: "gpt-5" },
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: [],
        skills: [],
      },
    })

    expect(job.modelConfigSnapshot).toMatchObject({
      credentialID: credential.id,
      credentialVersion: 1,
      provider: "openai",
      model: "gpt-5",
    })
    expect(result.service.getJob({ jobID: job.id }).modelConfigSnapshot).toMatchObject({
      credentialID: credential.id,
      credentialVersion: 1,
      provider: "openai",
      model: "gpt-5",
    })
    expect(result.modelSecretStore.resolve({ tenantID: "tenant_abc", secretRef: "tenant_abc/integrator_abc/Customer OpenAI" })).toBe("sk-test")
    expect(result.service.testLLMCredential({ credentialID: credential.id }).ok).toBe(true)
    expect(result.modelSecretStore.resolve({
      tenantID: "tenant_abc",
      secretRef: result.service.updateLLMCredential(credential.id, { apiKey: "sk-rotated" }).secretRef,
    })).toBe("sk-rotated")
  })

  test("rejects file creation without a staging adapter", () => {
    const result = createService()
    const workspace = result.service.createWorkspace({ name: "Acme" })

    expect(() =>
      result.service.createFile({
        workspaceID: workspace.id,
        name: "input.csv",
        contentBase64: Buffer.from("a,b\n1,2\n").toString("base64"),
      }),
    ).toThrow("Cloud file staging adapter not configured")
  })

  test("rejects session creation when the workspace is outside the tenant boundary", () => {
    const result = createService()

    expect(() => result.service.createSession({ workspaceID: "workspace_other", userID: "user_abc" })).toThrow(
      "Cloud workspace not found",
    )
  })

  test("creates jobs that the SQLite worker loop can lease", () => {
    const result = createService()
    const workspace = result.service.createWorkspace({ name: "Acme" })
    const session = result.service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    const job = result.service.createJob({
      sessionID: session.id,
      prompt: "Run from API to worker",
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

    expect(
      CloudSQLiteWorkerLoop.tick({
        db: result.db,
        tenantID: tenant.id,
        workerID: "worker_abc",
        leaseTTLMS: 1000,
        now: () => 100,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
      }),
    ).toMatchObject({
      status: "started",
      jobID: job.id,
      launch: {
        args: ["run", "Run from API to worker"],
      },
    })
    expect(result.db.query("select status from cloud_job where id = ?").get(job.id)).toEqual({ status: "leasing" })
  })
})
