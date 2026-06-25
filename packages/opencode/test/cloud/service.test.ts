import { describe, expect, test } from "bun:test"
import { CloudObjectStorage } from "../../src/cloud/object-storage"
import { CloudRuntimePool } from "../../src/cloud/runtime-pool"
import { CloudStore } from "../../src/cloud/store"
import { CloudService } from "../../src/cloud/service"
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
  return CloudService.create({
    store: CloudStore.create(),
    tenant,
    tools,
    now: () => 10,
    id: (prefix) => `${prefix}_abc`,
    signArtifactDownload: (input) => `https://storage.example.com/${input.artifact.objectKey}?expires=${input.expiresAt}`,
    stageFile: (input) => ({
      objectKey: CloudObjectStorage.fileKey({
        tenantID: input.tenantID,
        workspaceID: input.workspaceID,
        sessionID: input.sessionID,
        fileID: "file_abc",
        name: input.name,
      }),
      size: input.contentBase64 ? Buffer.from(input.contentBase64, "base64").byteLength : 0,
      sha256: input.contentBase64 ? "sha256_abc" : undefined,
    }),
  })
}

describe("CloudService", () => {
  test("creates a workspace and session inside the tenant", () => {
    const service = createService()
    const workspace = service.createWorkspace({ name: "Acme" })
    const session = service.createSession({
      workspaceID: workspace.id,
      userID: "user_abc",
      title: "Analysis",
    })

    expect(workspace).toMatchObject({ id: "workspace_abc", tenantID: "tenant_abc", name: "Acme" })
    expect(session).toMatchObject({
      id: "session_abc",
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      userID: "user_abc",
      title: "Analysis",
    })
  })

  test("creates a queued job with an initial status event", () => {
    const store = CloudStore.create()
    const service = CloudService.create({
      store,
      tenant,
      tools,
      now: () => 10,
      id: (prefix) => `${prefix}_abc`,
    })
    const workspace = service.createWorkspace({ name: "Acme" })
    const session = service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    const job = service.createJob({
      sessionID: session.id,
      prompt: "Summarize files",
      inputs: ["file_abc"],
      outputs: ["md"],
      runtime: { profile: "standard" },
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: [],
        skills: [],
      },
    })

    expect(job).toMatchObject({
      id: "job_abc",
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      status: "queued",
      runtime: { engine: "opencode", version: "1.14.28", profile: "standard" },
    })
    expect(store.getJobSpec({ tenantID: "tenant_abc", id: job.id })?.outputs).toEqual(["md"])
    expect(store.getJobPrompt({ tenantID: "tenant_abc", jobID: job.id })?.prompt).toBe("Summarize files")
    expect(service.listJobEvents({ jobID: job.id }).map((event) => event.type)).toEqual(["job.status"])
  })

  test("uses integrator runtime policy when creating a job", () => {
    const store = CloudStore.create()
    const service = CloudService.create({
      store,
      tenant,
      tools,
      now: () => 10,
      id: (prefix) => `${prefix}_abc`,
    })
    const workspace = service.createWorkspace({ name: "Acme" })
    const session = service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    service.updateIntegratorRuntimePolicy("integrator_abc", {
      defaultExecutionMode: "isolated_job_runtime",
      allowedExecutionModes: ["isolated_job_runtime", "shared_session_pool"],
      maxActiveJobs: 10,
      maxSessions: 500,
      maxConcurrentJobsPerSession: 1,
    })

    expect(service.createJob({
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
    }).executionMode).toBe("isolated_job_runtime")
  })

  test("freezes a BYOK model credential snapshot when creating a job", () => {
    const store = CloudStore.create()
    const modelSecretStore = CloudModelSecretStore.memory()
    const service = CloudService.create({
      store,
      tenant,
      tools,
      now: () => 10,
      id: (prefix) => `${prefix}_abc`,
      modelSecretStore,
    })
    const workspace = service.createWorkspace({ name: "Acme" })
    const session = service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    const credential = service.createLLMCredential({
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

    const job = service.createJob({
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
      secretRef: "tenant_abc/integrator_abc/Customer OpenAI",
    })
    expect(store.getJobSpec({ tenantID: "tenant_abc", id: job.id })?.model).toMatchObject({
      credentialID: credential.id,
      provider: "openai",
      model: "gpt-5",
    })
    expect(modelSecretStore.resolve({ tenantID: "tenant_abc", secretRef: "tenant_abc/integrator_abc/Customer OpenAI" })).toBe("sk-test")
    expect(service.testLLMCredential({ credentialID: credential.id }).ok).toBe(true)
    const rotated = service.updateLLMCredential(credential.id, { apiKey: "sk-rotated" })
    expect(modelSecretStore.resolve({ tenantID: "tenant_abc", secretRef: rotated.secretRef })).toBe("sk-rotated")
  })

  test("rejects job creation for sessions outside the service tenant", () => {
    const store = CloudStore.create()
    store.putSession({
      id: "session_other",
      tenantID: "tenant_other",
      workspaceID: "workspace_other",
      userID: "user_other",
      title: "Other",
      time: { created: 1, updated: 1 },
    })

    const service = CloudService.create({
      store,
      tenant,
      tools,
      now: () => 10,
      id: (prefix) => `${prefix}_abc`,
    })

    expect(() =>
      service.createJob({
        sessionID: "session_other",
        prompt: "Nope",
        inputs: [],
        outputs: ["json"],
        runtime: { profile: "small" },
        tools: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false },
          mcp: [],
          skills: [],
        },
      }),
    ).toThrow("Cloud session not found")
  })

  test("creates signed artifact download responses inside the tenant boundary", () => {
    const store = CloudStore.create()
    store.putArtifact({
      id: "artifact_abc",
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      jobID: "job_abc",
      name: "report.md",
      kind: "md",
      size: 120,
      objectKey: "tenant_abc/job_abc/report.md",
      time: { created: 10, updated: 10 },
    })
    store.putArtifact({
      id: "artifact_other",
      tenantID: "tenant_other",
      workspaceID: "workspace_other",
      sessionID: "session_other",
      jobID: "job_other",
      name: "other.md",
      kind: "md",
      size: 120,
      objectKey: "tenant_other/job_other/other.md",
      time: { created: 10, updated: 10 },
    })
    const service = CloudService.create({
      store,
      tenant,
      tools,
      now: () => 100,
      id: (prefix) => `${prefix}_abc`,
      signArtifactDownload: (input) => `https://storage.example.com/${input.artifact.objectKey}?expires=${input.expiresAt}`,
    })

    expect(service.getArtifactDownload({ artifactID: "artifact_abc", ttlMS: 900 })).toEqual({
      artifactID: "artifact_abc",
      url: "https://storage.example.com/tenant_abc/job_abc/report.md?expires=1000",
      expiresAt: 1000,
    })
    expect(() => service.getArtifactDownload({ artifactID: "artifact_other", ttlMS: 900 })).toThrow(
      "Cloud artifact not found",
    )
  })

  test("creates and lists session messages inside the tenant boundary", () => {
    const service = createService()
    const workspace = service.createWorkspace({ name: "Acme" })
    const session = service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    const message = service.createSessionMessage(session.id, {
      content: "Continue the analysis",
    })

    expect(message).toMatchObject({
      id: "message_abc",
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      role: "user",
      content: "Continue the analysis",
    })
    expect(service.listSessionMessages({ sessionID: session.id }).map((item) => item.id)).toEqual(["message_abc"])
  })

  test("creates file metadata through an injected staging adapter", () => {
    const service = createService()
    const workspace = service.createWorkspace({ name: "Acme" })
    const session = service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    const file = service.createFile({
      workspaceID: workspace.id,
      sessionID: session.id,
      name: "input.csv",
      mime: "text/csv",
      contentBase64: Buffer.from("a,b\n1,2\n").toString("base64"),
    })

    expect(file).toMatchObject({
      id: "file_abc",
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      name: "input.csv",
      mime: "text/csv",
      size: 8,
      objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/input.csv",
      sha256: "sha256_abc",
    })
    expect(service.listFiles({ workspaceID: workspace.id }).map((item) => item.id)).toEqual(["file_abc"])
  })

  test("registers runtime workers, updates heartbeats, and assigns session bindings", () => {
    const service = createService()
    const workspace = service.createWorkspace({ name: "Acme" })
    const session = service.createSession({ workspaceID: workspace.id, userID: "user_abc" })

    service.registerRuntimeWorker({
      runtimeID: "runtime_a",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 4,
      maxSessions: 20,
    })
    service.heartbeatRuntimeWorker("runtime_a", {
      status: "healthy",
      metrics: {
        activeJobs: 1,
        busySessions: 1,
        idleSessions: 3,
        cpuPercent: 20,
        memoryPercent: 30,
        diskPercent: 10,
        recentErrorRate: 0,
        heartbeatDelayMS: 5,
      },
    })

    expect(service.listRuntimeWorkers().map((runtime) => runtime.id)).toEqual(["runtime_a"])
    expect(service.assignSessionRuntime({ sessionID: session.id })).toMatchObject({
      tenantID: "tenant_abc",
      sessionID: session.id,
      runtimeID: "runtime_a",
    })
    expect(service.getSessionRuntimeBinding({ sessionID: session.id })?.runtimeID).toBe("runtime_a")
    expect(service.releaseSessionRuntime({ sessionID: session.id }).runtimeID).toBe("runtime_a")
    expect(service.getSessionRuntimeBinding({ sessionID: session.id })).toBeUndefined()
    expect(service.drainRuntimeWorker({ runtimeID: "runtime_a" }).status).toBe("draining")
    expect(service.restartRuntimeWorker({ runtimeID: "runtime_a" })).toMatchObject({
      status: "healthy",
      metrics: {
        activeJobs: 0,
        busySessions: 0,
        idleSessions: 0,
      },
    })
  })

  test("does not assign overloaded runtime workers", () => {
    const service = createService()
    const workspace = service.createWorkspace({ name: "Acme" })
    const session = service.createSession({ workspaceID: workspace.id, userID: "user_abc" })

    service.registerRuntimeWorker({
      runtimeID: "runtime_busy",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 1,
      maxSessions: 20,
      metrics: {
        activeJobs: 1,
        busySessions: 1,
        idleSessions: 0,
        cpuPercent: 10,
        memoryPercent: 10,
        diskPercent: 10,
        recentErrorRate: 0,
        heartbeatDelayMS: 1,
      },
    })

    expect(() => service.assignSessionRuntime({ sessionID: session.id })).toThrow("Cloud runtime capacity exhausted")
  })

  test("reconciles stale runtime workers and releases session bindings", () => {
    const store = CloudStore.create()
    const service = CloudService.create({
      store,
      tenant,
      tools,
      now: () => 10,
      id: (prefix) => `${prefix}_abc`,
    })
    const workspace = service.createWorkspace({ name: "Acme" })
    const session = service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    service.registerRuntimeWorker({
      runtimeID: "runtime_stale",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 4,
      maxSessions: 20,
    })
    service.assignSessionRuntime({ sessionID: session.id })

    const reconciled = CloudService.create({
      store,
      tenant,
      tools,
      now: () => 5_000,
      id: (prefix) => `${prefix}_later`,
    }).reconcileRuntimePool({ heartbeatTTLMS: 3_000 })

    expect(reconciled).toEqual({
      offlineRuntimeIDs: ["runtime_stale"],
      releasedSessionIDs: [session.id],
    })
    expect(service.getRuntimeWorker({ runtimeID: "runtime_stale" }).status).toBe("offline")
    expect(service.getSessionRuntimeBinding({ sessionID: session.id })).toBeUndefined()
  })

  test("applies runtime pool plans by draining idle runtimes and releasing stale bindings", () => {
    const store = CloudStore.create()
    const service = CloudService.create({
      store,
      tenant,
      tools,
      now: () => 10,
      id: (prefix) => `${prefix}_abc`,
    })
    const workspace = service.createWorkspace({ name: "Acme" })
    const session = service.createSession({ workspaceID: workspace.id, userID: "user_abc" })
    service.registerRuntimeWorker({
      runtimeID: "runtime_idle",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 10,
      maxSessions: 50,
    })
    service.registerRuntimeWorker({
      runtimeID: "runtime_offline",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 10,
      maxSessions: 50,
      status: "offline",
    })
    store.putSessionRuntimeBinding(
      CloudRuntimePool.bindSession({
        tenantID: tenant.id,
        sessionID: session.id,
        runtimeID: "runtime_offline",
        now: 10,
      }),
    )

    expect(service.applyRuntimePoolPlan()).toEqual({
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
    expect(service.getRuntimeWorker({ runtimeID: "runtime_idle" }).status).toBe("draining")
    expect(service.getSessionRuntimeBinding({ sessionID: session.id })).toBeUndefined()
  })
})
