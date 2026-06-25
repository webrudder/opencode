import { describe, expect, test } from "bun:test"
import { CloudRoutes } from "../../src/cloud/routes"
import { CloudRuntimePool } from "../../src/cloud/runtime-pool"
import { CloudSchema } from "../../src/cloud/schema"
import { CloudService } from "../../src/cloud/service"
import { CloudStore } from "../../src/cloud/store"

const tenant = {
  id: "tenant_abc",
  defaultRuntimeVersion: "1.14.28",
  defaultRuntimeImage: "registry.example.com/cloud-runtime-opencode:1.14.28",
  defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
  allowedModels: ["anthropic/claude-sonnet-4-5"],
}

const tools = {
  mcp: {},
  skills: {
    "report-writer@1.0.0": "/internal/skills/report-writer",
  },
}

function createApp() {
  const ids = new Map<string, number>()
  const store = CloudStore.create()
  const service = CloudService.create({
    store,
    tenant,
    tools,
    now: () => 10,
    id: (prefix) => {
      const next = (ids.get(prefix) ?? 0) + 1
      ids.set(prefix, next)
      return `${prefix}_${next}`
    },
    stageFile: (input) => ({
      objectKey: `tenant_abc/${input.workspaceID}/${input.name}`,
      size: input.contentBase64 ? Buffer.from(input.contentBase64, "base64").byteLength : 0,
      sha256: input.contentBase64 ? "sha256_abc" : undefined,
    }),
    signArtifactDownload: (input) => `https://storage.example.com/${input.artifact.objectKey}?expires=${input.expiresAt}`,
  })

  const app = CloudRoutes.create({
    service,
    toolCatalog: {
      catalog: {
        mcp: {
          browser: { title: "Browser", description: "Open web pages", url: "https://mcp.internal/browser" },
        },
        skills: {
          "report-writer@1.0.0": {
            title: "Report Writer",
            description: "Create reports",
            path: "/internal/skills/report-writer",
          },
        },
        connectors: {
          slack: { title: "Slack", description: "Post messages", enabled: true, internalAuthRef: "secret" },
        },
      },
      policy: {
        webfetch: { enabled: true, allowDomains: ["docs.example.com"] },
        websearch: { enabled: true, providers: ["platform-search"] },
        mcp: ["browser"],
        skills: ["report-writer@1.0.0"],
        connectors: ["slack"],
      },
    },
  })
  return Object.assign(app, { service, store })
}

describe("CloudRoutes", () => {
  test("serves workspace, session, file, and job creation without leaking internal fields", async () => {
    const app = createApp()
    const workspaceResponse = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    })
    expect(workspaceResponse.status).toBe(200)
    const workspace = (await workspaceResponse.json()) as Record<string, unknown>
    expect(workspace).toEqual({ id: "workspace_1", name: "Acme", created: 10, updated: 10 })
    expect(workspace.tenantID).toBeUndefined()

    const sessionResponse = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceID: workspace.id, userID: "user_abc", title: "Analysis" }),
    })
    expect(sessionResponse.status).toBe(200)
    const session = (await sessionResponse.json()) as Record<string, unknown>
    expect(session).toMatchObject({ id: "session_1", workspaceID: "workspace_1", userID: "user_abc" })
    expect(session.tenantID).toBeUndefined()

    const fileResponse = await app.request("/v1/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceID: workspace.id,
        sessionID: session.id,
        name: "input.csv",
        mime: "text/csv",
        contentBase64: Buffer.from("a,b\n1,2\n").toString("base64"),
      }),
    })
    expect(fileResponse.status).toBe(200)
    const file = (await fileResponse.json()) as Record<string, unknown>
    expect(file).toMatchObject({ id: "file_1", workspaceID: "workspace_1", sessionID: "session_1", size: 8 })
    expect(file.objectKey).toBeUndefined()
    expect(file.tenantID).toBeUndefined()
    expect(await (await app.request("/v1/files?workspaceID=workspace_1&sessionID=session_1")).json()).toEqual([
      {
        id: "file_1",
        workspaceID: "workspace_1",
        sessionID: "session_1",
        name: "input.csv",
        mime: "text/csv",
        size: 8,
        sha256: "sha256_abc",
        created: 10,
      },
    ])

    const jobResponse = await app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: session.id,
        prompt: "Analyze the file",
        inputs: [file.id],
        outputs: ["md"],
        runtime: { profile: "standard" },
        tools: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false },
          mcp: [],
          skills: [],
        },
      }),
    })
    expect(jobResponse.status).toBe(200)
    expect(await jobResponse.json()).toEqual({
      id: "job_1",
      status: "queued",
      sessionID: "session_1",
      runtimeVersion: "1.14.28",
    })
    expect(await (await app.request("/v1/jobs/job_1")).json()).toEqual({
      id: "job_1",
      status: "queued",
      sessionID: "session_1",
      runtimeVersion: "1.14.28",
    })
    expect(await (await app.request("/v1/jobs/job_1/cancel", { method: "POST" })).json()).toEqual({
      id: "job_1",
      status: "canceled",
      sessionID: "session_1",
      runtimeVersion: "1.14.28",
    })
  })

  test("serves tool catalog without leaking internal connector config", async () => {
    const response = await createApp().request("/v1/tools")
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      mcp: [{ name: "browser", title: "Browser", description: "Open web pages" }],
      skills: [{ name: "report-writer@1.0.0", title: "Report Writer", description: "Create reports" }],
      connectors: [{ name: "slack", title: "Slack", description: "Post messages" }],
    })
    expect(JSON.stringify(body)).not.toContain("secret")
    expect(JSON.stringify(body)).not.toContain("mcp.internal")
  })

  test("creates jobs with approved managed skills in the runtime spec", async () => {
    const app = createApp()
    const workspace = (await (
      await app.request("/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme" }),
      })
    ).json()) as Record<string, string>
    const session = (await (
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceID: workspace.id, userID: "user_abc" }),
      })
    ).json()) as Record<string, string>

    const jobResponse = await app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: session.id,
        prompt: "Write a report",
        inputs: [],
        outputs: ["md"],
        runtime: { profile: "standard" },
        tools: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false },
          mcp: [],
          skills: ["report-writer@1.0.0"],
        },
      }),
    })

    expect(jobResponse.status).toBe(200)
    expect(await (await app.request("/v1/jobs/job_1")).json()).toMatchObject({ id: "job_1" })
    expect(JSON.stringify(app.store.getJobSpec({ tenantID: "tenant_abc", id: "job_1" }))).toContain("/internal/skills/report-writer")
  })

  test("rejects unknown managed skills", async () => {
    const app = createApp()
    const workspace = (await (
      await app.request("/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme" }),
      })
    ).json()) as Record<string, string>
    const session = (await (
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceID: workspace.id, userID: "user_abc" }),
      })
    ).json()) as Record<string, string>
    const request = (skill: string) =>
      app.request("/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionID: session.id,
          prompt: "Write a report",
          inputs: [],
          outputs: ["md"],
          runtime: { profile: "standard" },
          tools: {
            webfetch: { enabled: false, allowDomains: [] },
            websearch: { enabled: false },
            mcp: [],
            skills: [skill],
          },
        }),
      })

    expect(await (await request("unknown@1.0.0")).text()).toContain("Unknown skill: unknown@1.0.0")
  })

  test("serves LLM credential management without returning secret material", async () => {
    const app = createApp()
    const createdResponse = await app.request("/v1/llm-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "external_user",
        ownerKey: "integrator_abc/customer_abc/user_abc",
        name: "User LLM",
        providerType: "openai-compatible",
        provider: "openai-compatible",
        baseURL: "https://llm.customer.example/v1",
        apiKey: "sk-user-secret",
        allowedModels: ["qwen-max"],
        defaultModel: "qwen-max",
      }),
    })
    expect(createdResponse.status).toBe(200)
    expect(await createdResponse.json()).toEqual({
      id: "llmcred_1",
      scope: "external_user",
      ownerKey: "integrator_abc/customer_abc/user_abc",
      name: "User LLM",
      providerType: "openai-compatible",
      provider: "openai-compatible",
      baseURL: "https://llm.customer.example/v1",
      allowedModels: ["qwen-max"],
      defaultModel: "qwen-max",
      enabled: true,
      version: 1,
      created: 10,
      updated: 10,
    })
    expect(await (await app.request("/v1/llm-credentials")).json()).toEqual([
      {
        id: "llmcred_1",
        scope: "external_user",
        ownerKey: "integrator_abc/customer_abc/user_abc",
        name: "User LLM",
        providerType: "openai-compatible",
        provider: "openai-compatible",
        baseURL: "https://llm.customer.example/v1",
        allowedModels: ["qwen-max"],
        defaultModel: "qwen-max",
        enabled: true,
        version: 1,
        created: 10,
        updated: 10,
      },
    ])
    expect(JSON.stringify(await (await app.request("/v1/llm-credentials/llmcred_1")).json())).not.toContain("sk-user-secret")

    expect(await (await app.request("/v1/llm-credentials/llmcred_1/test", { method: "POST" })).json()).toEqual({
      ok: true,
      credentialID: "llmcred_1",
      provider: "openai-compatible",
      model: "qwen-max",
    })
  })

  test("serves admin runtime pool inspection and session binding controls", async () => {
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
      runtimeID: "runtime_1",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 4,
      maxSessions: 20,
    })
    service.assignSessionRuntime({ sessionID: session.id })
    const app = CloudRoutes.create({
      service,
      toolCatalog: { catalog: { mcp: {}, skills: {}, connectors: {} }, policy: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false, providers: [] }, mcp: [], skills: [], connectors: [] } },
    })

    expect(await (await app.request("/admin/runtime-pools")).json()).toEqual({
      runtimes: 1,
      healthy: 1,
      draining: 0,
      overloaded: 0,
      offline: 0,
      activeJobs: 0,
      busySessions: 0,
      idleSessions: 0,
      plan: {
        desiredRuntimes: 1,
        action: "hold",
        reason: "steady",
        availableJobSlots: 4,
        availableSessionSlots: 19,
        boundSessions: 1,
        saturatedRuntimes: 0,
        unavailableRuntimes: 0,
        drainRuntimeIDs: [],
        releaseSessionIDs: [],
      },
    })
    expect(await (await app.request("/admin/runtimes")).json()).toEqual([
      {
        id: "runtime_1",
        executionMode: "shared_session_pool",
        status: "healthy",
        version: "1.14.28",
        profile: "standard",
        maxActiveJobs: 4,
        maxSessions: 20,
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
        capacity: {
          healthy: true,
          reasons: [],
          boundSessions: 0,
          remainingJobs: 4,
          remainingSessions: 20,
          loadScore: 0,
        },
        updated: 10,
      },
    ])
    expect(await (await app.request(`/admin/sessions/${session.id}/runtime`)).json()).toEqual({
      sessionID: session.id,
      runtimeID: "runtime_1",
      updated: 10,
    })
    expect(await (await app.request("/admin/runtimes/runtime_1/drain", { method: "POST" })).json()).toMatchObject({
      id: "runtime_1",
      status: "draining",
    })
    expect(await (await app.request("/admin/runtimes/runtime_1/restart", { method: "POST" })).json()).toMatchObject({
      id: "runtime_1",
      status: "healthy",
      metrics: {
        activeJobs: 0,
        busySessions: 0,
        idleSessions: 0,
      },
    })
    expect(await (await app.request(`/admin/sessions/${session.id}/release-runtime`, { method: "POST" })).json()).toEqual({
      sessionID: session.id,
      runtimeID: "runtime_1",
      updated: 10,
    })
  })

  test("applies admin runtime pool plans by draining and releasing bindings", async () => {
    const store = CloudStore.create()
    const service = CloudService.create({
      store,
      tenant,
      tools,
      now: () => 20,
      id: (prefix) => `${prefix}_abc`,
    })
    const workspace = service.createWorkspace({ name: "Acme" })
    const stale = service.createSession({ workspaceID: workspace.id, userID: "user_stale" })
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
        sessionID: stale.id,
        runtimeID: "runtime_offline",
        now: 20,
      }),
    )
    const app = CloudRoutes.create({
      service,
      toolCatalog: { catalog: { mcp: {}, skills: {}, connectors: {} }, policy: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false, providers: [] }, mcp: [], skills: [], connectors: [] } },
    })

    expect(await (await app.request("/admin/runtime-pools/apply-plan", { method: "POST" })).json()).toEqual({
      desiredRuntimes: 1,
      action: "scale_down",
      reason: "idle_capacity",
      drainedRuntimeIDs: ["runtime_idle"],
      releasedSessionIDs: [stale.id],
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
          sessionID: stale.id,
        },
      ],
    })
    expect(service.getRuntimeWorker({ runtimeID: "runtime_idle" }).status).toBe("draining")
    expect(service.getSessionRuntimeBinding({ sessionID: stale.id })).toBeUndefined()
  })

  test("serves admin runtime pool reconciliation", async () => {
    let now = 10
    const store = CloudStore.create()
    const service = CloudService.create({
      store,
      tenant,
      tools,
      now: () => now,
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
    now = 5_000
    const app = CloudRoutes.create({
      service,
      toolCatalog: { catalog: { mcp: {}, skills: {}, connectors: {} }, policy: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false, providers: [] }, mcp: [], skills: [], connectors: [] } },
    })

    expect(await (await app.request("/admin/runtime-pools/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heartbeatTTLMS: 3_000 }),
    })).json()).toEqual({
      offlineRuntimeIDs: ["runtime_stale"],
      releasedSessionIDs: [session.id],
    })
    expect(await (await app.request("/admin/runtimes/runtime_stale")).json()).toMatchObject({
      id: "runtime_stale",
      status: "offline",
    })
  })

  test("serves admin integrator runtime policy updates", async () => {
    const app = createApp()
    const response = await app.request("/admin/integrators/integrator_abc/runtime-policy", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        defaultExecutionMode: "shared_session_pool",
        allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
        maxActiveJobs: 10,
        maxSessions: 500,
        maxConcurrentJobsPerSession: 1,
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      tenantID: "tenant_abc",
      integratorID: "integrator_abc",
      defaultExecutionMode: "shared_session_pool",
      allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
      maxActiveJobs: 10,
      maxSessions: 500,
      maxConcurrentJobsPerSession: 1,
    })
    expect(await (await app.request("/admin/integrators/integrator_abc/runtime-policy")).json()).toEqual({
      tenantID: "tenant_abc",
      integratorID: "integrator_abc",
      defaultExecutionMode: "shared_session_pool",
      allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
      maxActiveJobs: 10,
      maxSessions: 500,
      maxConcurrentJobsPerSession: 1,
    })
  })

  test("serves paginated job events when a limit is requested", async () => {
    const app = createApp()
    const workspace = await (await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    })).json() as Record<string, unknown>
    const session = await (await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceID: workspace.id, userID: "user_abc" }),
    })).json() as Record<string, unknown>
    const job = await (await app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: session.id,
        prompt: "Analyze",
        inputs: [],
        outputs: ["md"],
        runtime: { profile: "standard" },
        tools: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false },
          mcp: [],
          skills: [],
        },
      }),
    })).json() as Record<string, unknown>
    await app.request(`/v1/jobs/${job.id}/cancel`, { method: "POST" })

    expect(await (await app.request(`/v1/jobs/${job.id}/events?limit=1`)).json()).toEqual({
      items: [
        {
          id: "job_1:000000000001",
          jobID: "job_1",
          type: "job.status",
          data: { status: "queued" },
          time: 10,
        },
      ],
      nextCursor: "job_1:000000000001",
      hasMore: true,
    })
    expect(await (await app.request(`/v1/jobs/${job.id}/events?cursor=job_1:000000000001&limit=1`)).json()).toEqual({
      items: [
        {
          id: "job_1:000000000002",
          jobID: "job_1",
          type: "job.status",
          data: { status: "canceled" },
          time: 10,
        },
      ],
      nextCursor: "job_1:000000000002",
      hasMore: false,
    })
  })

  test("serves job events as server-sent events", async () => {
    const app = createApp()
    const workspace = await (await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    })).json() as Record<string, unknown>
    const session = await (await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceID: workspace.id, userID: "user_abc" }),
    })).json() as Record<string, unknown>
    const job = await (await app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: session.id,
        prompt: "Analyze",
        inputs: [],
        outputs: ["md"],
        runtime: { profile: "standard" },
        tools: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false },
          mcp: [],
          skills: [],
        },
      }),
    })).json() as Record<string, unknown>
    await app.request(`/v1/jobs/${job.id}/cancel`, { method: "POST" })

    const response = await app.request(`/v1/jobs/${job.id}/events/stream?cursor=job_1:000000000001&limit=1`)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(await response.text()).toBe(
      [
        "id: job_1:000000000002",
        "event: job.status",
        'data: {"id":"job_1:000000000002","jobID":"job_1","type":"job.status","data":{"status":"canceled"},"time":10}',
        "",
        "",
      ].join("\n"),
    )
  })

  test("follows job events as server-sent events until a terminal status", async () => {
    const eventBatches = [
      [
        {
          id: "job_abc:000000000001",
          jobID: "job_abc",
          type: "job.status" as const,
          data: { status: "running" },
          time: 1,
        },
      ],
      [
        {
          id: "job_abc:000000000002",
          jobID: "job_abc",
          type: "job.status" as const,
          data: { status: "succeeded" },
          time: 2,
        },
      ],
    ]
    const app = CloudRoutes.create({
      service: {
        createWorkspace: () => {
          throw new Error("unused")
        },
        createSession: () => {
          throw new Error("unused")
        },
        createFile: () => {
          throw new Error("unused")
        },
        listFiles: () => {
          throw new Error("unused")
        },
        createJob: () => {
          throw new Error("unused")
        },
        getJob: () => {
          throw new Error("unused")
        },
        cancelJob: () => {
          throw new Error("unused")
        },
        listJobEvents: () => eventBatches.shift() ?? [],
        createSessionMessage: () => {
          throw new Error("unused")
        },
        listSessionMessages: () => {
          throw new Error("unused")
        },
        listArtifacts: () => {
          throw new Error("unused")
        },
        getArtifactDownload: () => {
          throw new Error("unused")
        },
        createWebhook: () => {
          throw new Error("unused")
        },
        listWebhooks: () => {
          throw new Error("unused")
        },
        updateWebhook: () => {
          throw new Error("unused")
        },
        deleteWebhook: () => {
          throw new Error("unused")
        },
        createLLMCredential: () => {
          throw new Error("unused")
        },
        listLLMCredentials: () => {
          throw new Error("unused")
        },
        getLLMCredential: () => {
          throw new Error("unused")
        },
        updateLLMCredential: () => {
          throw new Error("unused")
        },
        deleteLLMCredential: () => {
          throw new Error("unused")
        },
        testLLMCredential: () => {
          throw new Error("unused")
        },
        listRuntimeWorkers: () => {
          throw new Error("unused")
        },
        getRuntimeWorker: () => {
          throw new Error("unused")
        },
        drainRuntimeWorker: () => {
          throw new Error("unused")
        },
        restartRuntimeWorker: () => {
          throw new Error("unused")
        },
        reconcileRuntimePool: () => {
          throw new Error("unused")
        },
        applyRuntimePoolPlan: () => {
          throw new Error("unused")
        },
        getSessionRuntimeBinding: () => {
          throw new Error("unused")
        },
        listSessionRuntimeBindings: () => {
          throw new Error("unused")
        },
        releaseSessionRuntime: () => {
          throw new Error("unused")
        },
        getIntegratorRuntimePolicy: () => {
          throw new Error("unused")
        },
        updateIntegratorRuntimePolicy: () => {
          throw new Error("unused")
        },
      },
      toolCatalog: {
        catalog: { mcp: {}, skills: {}, connectors: {} },
        policy: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false, providers: [] },
          mcp: [],
          skills: [],
          connectors: [],
        },
      },
    })

    const response = await app.request("/v1/jobs/job_abc/events/stream?follow=true&pollMS=1&timeoutMS=20")

    expect(await response.text()).toBe(
      [
        "id: job_abc:000000000001",
        "event: job.status",
        'data: {"id":"job_abc:000000000001","jobID":"job_abc","type":"job.status","data":{"status":"running"},"time":1}',
        "",
        "id: job_abc:000000000002",
        "event: job.status",
        'data: {"id":"job_abc:000000000002","jobID":"job_abc","type":"job.status","data":{"status":"succeeded"},"time":2}',
        "",
        "",
      ].join("\n"),
    )
  })

  test("serves paginated file lists when a limit is requested", async () => {
    const app = createApp()
    const workspace = await (await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    })).json() as Record<string, unknown>
    const session = await (await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceID: workspace.id, userID: "user_abc" }),
    })).json() as Record<string, unknown>
    await app.request("/v1/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceID: workspace.id,
        sessionID: session.id,
        name: "first.csv",
        contentBase64: Buffer.from("first").toString("base64"),
      }),
    })
    await app.request("/v1/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceID: workspace.id,
        sessionID: session.id,
        name: "second.csv",
        contentBase64: Buffer.from("second").toString("base64"),
      }),
    })

    expect(await (await app.request(`/v1/files?workspaceID=${workspace.id}&limit=1`)).json()).toEqual({
      items: [
        {
          id: "file_1",
          workspaceID: "workspace_1",
          sessionID: "session_1",
          name: "first.csv",
          size: 5,
          sha256: "sha256_abc",
          created: 10,
        },
      ],
      nextCursor: "file_1",
      hasMore: true,
    })
  })

  test("serves paginated artifact lists when a limit is requested", async () => {
    const store = CloudStore.create()
    store.putArtifact(
      CloudSchema.decodeArtifact({
        id: "artifact_1",
        tenantID: "tenant_abc",
        workspaceID: "workspace_1",
        sessionID: "session_1",
        jobID: "job_1",
        name: "first.md",
        kind: "md",
        size: 1,
        objectKey: "tenant_abc/job_1/artifacts/first.md",
        time: { created: 10, updated: 10 },
      }),
    )
    store.putArtifact(
      CloudSchema.decodeArtifact({
        id: "artifact_2",
        tenantID: "tenant_abc",
        workspaceID: "workspace_1",
        sessionID: "session_1",
        jobID: "job_1",
        name: "second.md",
        kind: "md",
        size: 2,
        objectKey: "tenant_abc/job_1/artifacts/second.md",
        time: { created: 11, updated: 11 },
      }),
    )
    const app = CloudRoutes.create({
      service: CloudService.create({
        store,
        tenant,
        tools,
        now: () => 10,
        id: (prefix) => `${prefix}_abc`,
      }),
      toolCatalog: { catalog: { mcp: {}, skills: {}, connectors: {} }, policy: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false, providers: [] }, mcp: [], skills: [], connectors: [] } },
    })

    expect(await (await app.request("/v1/artifacts?jobID=job_1&limit=1")).json()).toEqual({
      items: [
        {
          id: "artifact_1",
          jobID: "job_1",
          name: "first.md",
          kind: "md",
          size: 1,
          created: 10,
        },
      ],
      nextCursor: "artifact_1",
      hasMore: true,
    })
  })

  test("creates webhook subscriptions without leaking secrets", async () => {
    const app = createApp()
    const response = await app.request("/v1/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://saas.example.com/hooks/runtime",
        events: ["job.status", "job.artifact"],
        secret: "secret_abc",
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toEqual({
      id: "webhook_1",
      url: "https://saas.example.com/hooks/runtime",
      events: ["job.status", "job.artifact"],
      enabled: true,
      created: 10,
    })
    expect(JSON.stringify(body)).not.toContain("secret")
    expect(await (await app.request("/v1/webhooks")).json()).toEqual([body])
    expect(
      await (
        await app.request("/v1/webhooks/webhook_1", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        })
      ).json(),
    ).toEqual({
      ...body,
      enabled: false,
    })
    expect(await (await app.request("/v1/webhooks/webhook_1", { method: "DELETE" })).json()).toEqual({
      ...body,
      enabled: false,
    })
    expect(await (await app.request("/v1/webhooks")).json()).toEqual([])
  })

  test("runs an optional gateway guard before route handlers", async () => {
    const response = await CloudRoutes.create({
      service: CloudService.create({
        store: CloudStore.create(),
        tenant,
        tools,
        now: () => 10,
        id: (prefix) => `${prefix}_abc`,
      }),
      toolCatalog: {
        catalog: { mcp: {}, skills: {}, connectors: {} },
        policy: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false, providers: [] },
          mcp: [],
          skills: [],
          connectors: [],
        },
      },
      beforeRequest: () => new Response("limited", { status: 429 }),
    }).request("/v1/tools")

    expect(response.status).toBe(429)
    expect(await response.text()).toBe("limited")
  })

  test("awaits async service methods for PostgreSQL-backed adapters", async () => {
    const app = CloudRoutes.create({
      service: {
        ...CloudService.create({
          store: CloudStore.create(),
          tenant,
          tools,
          now: () => 10,
          id: (prefix) => `${prefix}_abc`,
        }),
        createWorkspace: async () => ({
          id: "workspace_async",
          tenantID: tenant.id,
          name: "Async",
          time: { created: 10, updated: 10 },
        }),
      },
      toolCatalog: {
        catalog: { mcp: {}, skills: {}, connectors: {} },
        policy: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false, providers: [] },
          mcp: [],
          skills: [],
          connectors: [],
        },
      },
    })

    expect(
      await (
        await app.request("/v1/workspaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Async" }),
        })
      ).json(),
    ).toEqual({ id: "workspace_async", name: "Async", created: 10, updated: 10 })
  })

  test("returns stable JSON errors from route handlers", async () => {
    const notFound = await createApp().request("/v1/jobs/missing")
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toEqual({
      error: {
        code: "not_found",
        message: "Cloud job not found",
      },
    })

    const badRequest = await createApp().request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userID: "user_abc" }),
    })
    expect(badRequest.status).toBe(400)
    expect(await badRequest.json()).toMatchObject({
      error: {
        code: "bad_request",
      },
    })
  })
})
