import { describe, expect, test } from "bun:test"
import { CloudSDK } from "../../src/cloud/sdk"

describe("CloudSDK", () => {
  test("builds authenticated JSON requests for Cloud Runtime endpoints", async () => {
    const calls: Request[] = []
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return Response.json({
          id: "workspace_abc",
          name: "Acme",
          created: 10,
          updated: 10,
        })
      },
    })

    expect(await client.createWorkspace({ name: "Acme" })).toEqual({
      id: "workspace_abc",
      name: "Acme",
      created: 10,
      updated: 10,
    })
    expect(calls[0].method).toBe("POST")
    expect(calls[0].url).toBe("https://runtime.example.com/v1/workspaces")
    expect(calls[0].headers.get("authorization")).toBe("Bearer key_abc")
    expect(calls[0].headers.get("content-type")).toBe("application/json")
    expect(await calls[0].json()).toEqual({ name: "Acme" })
  })

  test("decodes typed responses for core API methods", async () => {
    const responses = [
      { id: "session_abc", workspaceID: "workspace_abc", userID: "user_abc", title: "Analysis", created: 1, updated: 1 },
      [{ id: "file_abc", workspaceID: "workspace_abc", sessionID: "session_abc", name: "input.csv", size: 8, created: 1 }],
      { id: "job_abc", status: "queued", sessionID: "session_abc", runtimeVersion: "1.14.28" },
      { id: "job_abc", status: "queued", sessionID: "session_abc", runtimeVersion: "1.14.28" },
      { id: "job_abc", status: "canceled", sessionID: "session_abc", runtimeVersion: "1.14.28" },
      [{ id: "job_abc:000000000001", jobID: "job_abc", type: "job.status", data: { status: "queued" }, time: 1 }],
      {
        id: "webhook_abc",
        url: "https://saas.example.com/hooks/runtime",
        events: ["job.status"],
        enabled: true,
        created: 1,
      },
      [
        {
          id: "webhook_abc",
          url: "https://saas.example.com/hooks/runtime",
          events: ["job.status"],
          enabled: true,
          created: 1,
        },
      ],
      {
        id: "webhook_abc",
        url: "https://saas.example.com/hooks/runtime",
        events: ["job.status"],
        enabled: false,
        created: 1,
      },
      {
        id: "webhook_abc",
        url: "https://saas.example.com/hooks/runtime",
        events: ["job.status"],
        enabled: false,
        created: 1,
      },
    ]
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com/",
      apiKey: "key_abc",
      fetch: async () => Response.json(responses.shift()),
    })

    expect(
      await client.createSession({
        workspaceID: "workspace_abc",
        userID: "user_abc",
        title: "Analysis",
      }),
    ).toMatchObject({ id: "session_abc" })
    expect(await client.listFiles({ workspaceID: "workspace_abc", sessionID: "session_abc" })).toEqual([
      { id: "file_abc", workspaceID: "workspace_abc", sessionID: "session_abc", name: "input.csv", size: 8, created: 1 },
    ])
    expect(
      await client.createJob({
        sessionID: "session_abc",
        prompt: "Analyze",
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
    ).toMatchObject({ id: "job_abc", status: "queued" })
    expect(await client.getJob({ jobID: "job_abc" })).toMatchObject({ id: "job_abc", status: "queued" })
    expect(await client.cancelJob({ jobID: "job_abc" })).toMatchObject({ id: "job_abc", status: "canceled" })
    expect(await client.listJobEvents({ jobID: "job_abc" })).toEqual([
      { id: "job_abc:000000000001", jobID: "job_abc", type: "job.status", data: { status: "queued" }, time: 1 },
    ])
    expect(
      await client.createWebhook({
        url: "https://saas.example.com/hooks/runtime",
        events: ["job.status"],
        secret: "secret_abc",
      }),
    ).toMatchObject({ id: "webhook_abc", enabled: true })
    expect(await client.listWebhooks()).toEqual([
      {
        id: "webhook_abc",
        url: "https://saas.example.com/hooks/runtime",
        events: ["job.status"],
        enabled: true,
        created: 1,
      },
    ])
    expect(await client.updateWebhook({ webhookID: "webhook_abc", enabled: false })).toMatchObject({
      id: "webhook_abc",
      enabled: false,
    })
    expect(await client.deleteWebhook({ webhookID: "webhook_abc" })).toMatchObject({
      id: "webhook_abc",
      enabled: false,
    })
  })

  test("uses job lookup and cancellation endpoints", async () => {
    const calls: Request[] = []
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return Response.json({ id: "job_abc", status: "canceled", sessionID: "session_abc", runtimeVersion: "1.14.28" })
      },
    })

    await client.getJob({ jobID: "job_abc" })
    await client.cancelJob({ jobID: "job_abc" })

    expect(calls.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://runtime.example.com/v1/jobs/job_abc"],
      ["POST", "https://runtime.example.com/v1/jobs/job_abc/cancel"],
    ])
  })

  test("uses paginated job event responses with cursor and limit", async () => {
    const calls: Request[] = []
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return Response.json({
          items: [
            { id: "job_abc:000000000002", jobID: "job_abc", type: "job.status", data: { status: "running" }, time: 2 },
          ],
          nextCursor: "job_abc:000000000002",
          hasMore: true,
        })
      },
    })

    expect(await client.listJobEventsPage({ jobID: "job_abc", cursor: "job_abc:000000000001", limit: 1 })).toEqual({
      items: [
        { id: "job_abc:000000000002", jobID: "job_abc", type: "job.status", data: { status: "running" }, time: 2 },
      ],
      nextCursor: "job_abc:000000000002",
      hasMore: true,
    })
    expect(calls[0].url).toBe(
      "https://runtime.example.com/v1/jobs/job_abc/events?cursor=job_abc%3A000000000001&limit=1",
    )
  })

  test("parses server-sent job events from the stream endpoint", async () => {
    const calls: Request[] = []
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return new Response(
          [
            "id: job_abc:000000000002",
            "event: job.status",
            'data: {"id":"job_abc:000000000002","jobID":"job_abc","type":"job.status","data":{"status":"running"},"time":2}',
            "",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })

    expect(await client.streamJobEvents({ jobID: "job_abc", cursor: "job_abc:000000000001", limit: 1 })).toEqual([
      { id: "job_abc:000000000002", jobID: "job_abc", type: "job.status", data: { status: "running" }, time: 2 },
    ])
    expect(calls[0].url).toBe(
      "https://runtime.example.com/v1/jobs/job_abc/events/stream?cursor=job_abc%3A000000000001&limit=1",
    )
  })

  test("passes follow options to the server-sent job event stream endpoint", async () => {
    const calls: Request[] = []
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return new Response("")
      },
    })

    expect(await client.streamJobEvents({ jobID: "job_abc", follow: true, pollMS: 250, timeoutMS: 5000 })).toEqual([])
    expect(calls[0].url).toBe(
      "https://runtime.example.com/v1/jobs/job_abc/events/stream?follow=true&pollMS=250&timeoutMS=5000",
    )
  })

  test("uses paginated file and artifact responses with cursor and limit", async () => {
    const calls: Request[] = []
    const responses = [
      {
        items: [{ id: "file_abc", workspaceID: "workspace_abc", name: "input.csv", size: 10, created: 1 }],
        nextCursor: "file_abc",
        hasMore: true,
      },
      {
        items: [{ id: "artifact_abc", jobID: "job_abc", name: "summary.md", kind: "md", size: 10, created: 2 }],
        nextCursor: "artifact_abc",
        hasMore: false,
      },
    ]
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return Response.json(responses.shift())
      },
    })

    expect(await client.listFilesPage({ workspaceID: "workspace_abc", cursor: "file_prev", limit: 1 })).toEqual({
      items: [{ id: "file_abc", workspaceID: "workspace_abc", name: "input.csv", size: 10, created: 1 }],
      nextCursor: "file_abc",
      hasMore: true,
    })
    expect(await client.listArtifactsPage({ jobID: "job_abc", cursor: "artifact_prev", limit: 1 })).toEqual({
      items: [{ id: "artifact_abc", jobID: "job_abc", name: "summary.md", kind: "md", size: 10, created: 2 }],
      nextCursor: "artifact_abc",
      hasMore: false,
    })
    expect(calls.map((item) => item.url)).toEqual([
      "https://runtime.example.com/v1/files?workspaceID=workspace_abc&cursor=file_prev&limit=1",
      "https://runtime.example.com/v1/artifacts?jobID=job_abc&cursor=artifact_prev&limit=1",
    ])
  })

  test("uses file listing query parameters", async () => {
    const calls: Request[] = []
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return Response.json([])
      },
    })

    await client.listFiles({ workspaceID: "workspace_abc", sessionID: "session_abc" })

    expect(calls[0].method).toBe("GET")
    expect(calls[0].url).toBe("https://runtime.example.com/v1/files?workspaceID=workspace_abc&sessionID=session_abc")
  })

  test("uses webhook creation endpoint", async () => {
    const calls: Request[] = []
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return Response.json({
          id: "webhook_abc",
          url: "https://saas.example.com/hooks/runtime",
          events: ["job.status"],
          enabled: true,
          created: 1,
        })
      },
    })

    await client.createWebhook({
      url: "https://saas.example.com/hooks/runtime",
      events: ["job.status"],
      secret: "secret_abc",
    })

    expect(calls[0].method).toBe("POST")
    expect(calls[0].url).toBe("https://runtime.example.com/v1/webhooks")
    expect(await calls[0].json()).toEqual({
      url: "https://saas.example.com/hooks/runtime",
      events: ["job.status"],
      secret: "secret_abc",
    })
  })

  test("uses webhook listing endpoint", async () => {
    const calls: Request[] = []
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return Response.json([])
      },
    })

    await client.listWebhooks()

    expect(calls[0].method).toBe("GET")
    expect(calls[0].url).toBe("https://runtime.example.com/v1/webhooks")
  })

  test("uses webhook update endpoint", async () => {
    const calls: Request[] = []
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return Response.json({
          id: "webhook_abc",
          url: "https://saas.example.com/hooks/runtime",
          events: ["job.status"],
          enabled: false,
          created: 1,
        })
      },
    })

    await client.updateWebhook({ webhookID: "webhook_abc", enabled: false })

    expect(calls[0].method).toBe("PATCH")
    expect(calls[0].url).toBe("https://runtime.example.com/v1/webhooks/webhook_abc")
    expect(await calls[0].json()).toEqual({ enabled: false })
  })

  test("uses webhook delete endpoint", async () => {
    const calls: Request[] = []
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return Response.json({
          id: "webhook_abc",
          url: "https://saas.example.com/hooks/runtime",
          events: ["job.status"],
          enabled: false,
          created: 1,
        })
      },
    })

    await client.deleteWebhook({ webhookID: "webhook_abc" })

    expect(calls[0].method).toBe("DELETE")
    expect(calls[0].url).toBe("https://runtime.example.com/v1/webhooks/webhook_abc")
  })

  test("uses LLM credential endpoints without returning secret material", async () => {
    const calls: Request[] = []
    const credential = {
      id: "llmcred_abc",
      scope: "external_user",
      ownerKey: "integrator_abc:tenant_abc:user_abc",
      name: "User Anthropic",
      providerType: "anthropic",
      provider: "anthropic",
      allowedModels: ["claude-sonnet-4-5"],
      defaultModel: "claude-sonnet-4-5",
      enabled: true,
      version: 1,
      created: 1,
      updated: 1,
    } as const
    const responses = [
      credential,
      [credential],
      credential,
      { ...credential, version: 2, enabled: false, updated: 2 },
      { ...credential, enabled: false },
      { ok: true, credentialID: "llmcred_abc", provider: "anthropic", model: "claude-sonnet-4-5" },
    ]
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return Response.json(responses.shift())
      },
    })

    expect(
      await client.createLLMCredential({
        scope: "external_user",
        ownerKey: "integrator_abc:tenant_abc:user_abc",
        name: "User Anthropic",
        providerType: "anthropic",
        provider: "anthropic",
        apiKey: "sk-user-secret",
        allowedModels: ["claude-sonnet-4-5"],
        defaultModel: "claude-sonnet-4-5",
      }),
    ).not.toHaveProperty("apiKey")
    expect(await client.listLLMCredentials()).toEqual([credential])
    expect(await client.getLLMCredential({ credentialID: "llmcred_abc" })).toEqual(credential)
    expect(await client.updateLLMCredential({ credentialID: "llmcred_abc", enabled: false })).toMatchObject({
      version: 2,
      enabled: false,
    })
    expect(await client.deleteLLMCredential({ credentialID: "llmcred_abc" })).toMatchObject({ enabled: false })
    expect(await client.testLLMCredential({ credentialID: "llmcred_abc" })).toEqual({
      ok: true,
      credentialID: "llmcred_abc",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    })
    expect(calls.map((item) => [item.method, item.url])).toEqual([
      ["POST", "https://runtime.example.com/v1/llm-credentials"],
      ["GET", "https://runtime.example.com/v1/llm-credentials"],
      ["GET", "https://runtime.example.com/v1/llm-credentials/llmcred_abc"],
      ["PATCH", "https://runtime.example.com/v1/llm-credentials/llmcred_abc"],
      ["DELETE", "https://runtime.example.com/v1/llm-credentials/llmcred_abc"],
      ["POST", "https://runtime.example.com/v1/llm-credentials/llmcred_abc/test"],
    ])
    expect(await calls[3].json()).toEqual({ enabled: false })
  })

  test("uses admin runtime pool and policy endpoints", async () => {
    const calls: Request[] = []
    const runtime = {
      id: "runtime_abc",
      executionMode: "shared_session_pool",
      status: "healthy",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 4,
      maxSessions: 40,
      metrics: {
        activeJobs: 1,
        busySessions: 1,
        idleSessions: 2,
        cpuPercent: 10,
        memoryPercent: 20,
        diskPercent: 30,
        recentErrorRate: 0,
        heartbeatDelayMS: 100,
      },
      capacity: {
        healthy: true,
        reasons: [],
        boundSessions: 3,
        remainingJobs: 3,
        remainingSessions: 37,
        loadScore: 185.1,
      },
      updated: 10,
    } as const
    const policy = {
      tenantID: "tenant_abc",
      integratorID: "integrator_abc",
      defaultExecutionMode: "shared_session_pool",
      allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
      maxActiveJobs: 10,
      maxSessions: 100,
      maxConcurrentJobsPerSession: 1,
    } as const
    const responses = [
      {
        runtimes: 1,
        healthy: 1,
        draining: 0,
        overloaded: 0,
        offline: 0,
        activeJobs: 1,
        busySessions: 1,
        idleSessions: 2,
        plan: {
          desiredRuntimes: 1,
          action: "hold",
          reason: "steady",
          availableJobSlots: 3,
          availableSessionSlots: 37,
          boundSessions: 3,
          saturatedRuntimes: 0,
          unavailableRuntimes: 0,
          drainRuntimeIDs: [],
          releaseSessionIDs: [],
        },
      },
      { offlineRuntimeIDs: ["runtime_old"], releasedSessionIDs: ["session_old"] },
      {
        desiredRuntimes: 1,
        action: "scale_down",
        reason: "idle_capacity",
        drainedRuntimeIDs: ["runtime_idle"],
        releasedSessionIDs: ["session_old"],
        scaleOperations: [
          {
            action: "scale",
            target: "kubernetes",
            desiredRuntimes: 1,
            currentRuntimes: 2,
            namespace: "runtime",
            deploymentName: "runtime-worker",
          },
        ],
      },
      [runtime],
      runtime,
      { ...runtime, status: "draining" },
      runtime,
      { sessionID: "session_abc", runtimeID: "runtime_abc", updated: 11 },
      { sessionID: "session_abc", runtimeID: "runtime_abc", updated: 11 },
      policy,
      policy,
    ]
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async (request) => {
        calls.push(request)
        return Response.json(responses.shift())
      },
    })

    expect(await client.adminGetRuntimePool()).toMatchObject({ runtimes: 1, activeJobs: 1 })
    expect(await client.adminReconcileRuntimePool({ heartbeatTTLMS: 30_000 })).toEqual({
      offlineRuntimeIDs: ["runtime_old"],
      releasedSessionIDs: ["session_old"],
    })
    expect(await client.adminApplyRuntimePoolPlan({
      target: "kubernetes",
      currentRuntimes: 2,
      namespace: "runtime",
      deploymentName: "runtime-worker",
    })).toEqual({
      desiredRuntimes: 1,
      action: "scale_down",
      reason: "idle_capacity",
      drainedRuntimeIDs: ["runtime_idle"],
      releasedSessionIDs: ["session_old"],
      scaleOperations: [
        {
          action: "scale",
          target: "kubernetes",
          desiredRuntimes: 1,
          currentRuntimes: 2,
          namespace: "runtime",
          deploymentName: "runtime-worker",
        },
      ],
    })
    expect(await client.adminListRuntimes()).toEqual([runtime])
    expect(await client.adminGetRuntime({ runtimeID: "runtime_abc" })).toEqual(runtime)
    expect(await client.adminDrainRuntime({ runtimeID: "runtime_abc" })).toMatchObject({ status: "draining" })
    expect(await client.adminRestartRuntime({ runtimeID: "runtime_abc" })).toMatchObject({ status: "healthy" })
    expect(await client.adminGetSessionRuntime({ sessionID: "session_abc" })).toEqual({
      sessionID: "session_abc",
      runtimeID: "runtime_abc",
      updated: 11,
    })
    expect(await client.adminReleaseSessionRuntime({ sessionID: "session_abc" })).toMatchObject({ runtimeID: "runtime_abc" })
    expect(await client.adminGetIntegratorRuntimePolicy({ integratorID: "integrator_abc" })).toEqual(policy)
    expect(
      await client.adminUpdateIntegratorRuntimePolicy({
        integratorID: "integrator_abc",
        defaultExecutionMode: "shared_session_pool",
        allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
        maxActiveJobs: 10,
        maxSessions: 100,
        maxConcurrentJobsPerSession: 1,
      }),
    ).toEqual(policy)
    expect(calls.map((item) => [item.method, item.url])).toEqual([
      ["GET", "https://runtime.example.com/admin/runtime-pools"],
      ["POST", "https://runtime.example.com/admin/runtime-pools/reconcile"],
      ["POST", "https://runtime.example.com/admin/runtime-pools/apply-plan"],
      ["GET", "https://runtime.example.com/admin/runtimes"],
      ["GET", "https://runtime.example.com/admin/runtimes/runtime_abc"],
      ["POST", "https://runtime.example.com/admin/runtimes/runtime_abc/drain"],
      ["POST", "https://runtime.example.com/admin/runtimes/runtime_abc/restart"],
      ["GET", "https://runtime.example.com/admin/sessions/session_abc/runtime"],
      ["POST", "https://runtime.example.com/admin/sessions/session_abc/release-runtime"],
      ["GET", "https://runtime.example.com/admin/integrators/integrator_abc/runtime-policy"],
      ["PATCH", "https://runtime.example.com/admin/integrators/integrator_abc/runtime-policy"],
    ])
    expect(await calls[1].json()).toEqual({ heartbeatTTLMS: 30000 })
    expect(await calls[2].json()).toEqual({
      target: "kubernetes",
      currentRuntimes: 2,
      namespace: "runtime",
      deploymentName: "runtime-worker",
    })
    expect(await calls[10].json()).toEqual({
      defaultExecutionMode: "shared_session_pool",
      allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
      maxActiveJobs: 10,
      maxSessions: 100,
      maxConcurrentJobsPerSession: 1,
    })
  })

  test("throws helpful errors for non-2xx responses", async () => {
    const client = CloudSDK.create({
      baseURL: "https://runtime.example.com",
      apiKey: "key_abc",
      fetch: async () => Response.json({ error: { code: "rate_limited", message: "Too many requests" } }, { status: 429 }),
    })

    await expect(client.listTools()).rejects.toThrow("Cloud SDK request failed: 429 Too many requests")
  })
})
