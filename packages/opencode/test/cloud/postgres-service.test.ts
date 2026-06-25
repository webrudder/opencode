import { describe, expect, test } from "bun:test"
import { CloudPostgresService } from "../../src/cloud/postgres-service"
import { CloudModelSecretStore, type Store as ModelSecretStore } from "../../src/cloud/model-secret-store"

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

function setup(
  responses: Record<string, Record<string, unknown>[]>,
  options?: {
    signArtifactDownload?: (input: { artifact: { objectKey: string }; expiresAt: number }) => string
    modelSecretStore?: ModelSecretStore
  },
) {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    service: CloudPostgresService.create({
      client: {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params: params ?? [] })
          return sql.startsWith("select") ? { rows: responses[sql] ?? [] } : { rowCount: 1 }
        },
      },
      tenant,
      tools,
      now: () => 10,
      id: (prefix) => `${prefix}_abc`,
      stageFile: (request) => ({
        objectKey: `${request.tenantID}/${request.workspaceID}/${request.name}`,
        size: request.contentBase64 ? Buffer.from(request.contentBase64, "base64").byteLength : 0,
        sha256: request.contentBase64 ? "sha256_abc" : undefined,
      }),
      signArtifactDownload: options?.signArtifactDownload,
      modelSecretStore: options?.modelSecretStore,
    }),
  }
}

describe("CloudPostgresService", () => {
  test("stores BYOK secrets through the injected PostgreSQL service secret store", async () => {
    const modelSecretStore = CloudModelSecretStore.memory()
    const subject = setup({}, { modelSecretStore })
    const credential = await subject.service.createLLMCredential({
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

    expect(modelSecretStore.resolve({ tenantID: "tenant_abc", secretRef: credential.secretRef })).toBe("sk-test")
    expect(subject.calls.some((call) => call.sql.includes("insert into cloud_llm_credential"))).toBe(true)
  })

  test("creates workspace and session rows through PostgreSQL transactions", async () => {
    const subject = setup({
      "select * from cloud_workspace where tenant_id = $1 and id = $2": [
        {
          id: "workspace_abc",
          tenant_id: tenant.id,
          external_id: null,
          name: "Acme",
          time_created: 10,
          time_updated: 10,
        },
      ],
    })

    const workspace = await subject.service.createWorkspace({ name: "Acme" })
    const session = await subject.service.createSession({
      workspaceID: workspace.id,
      userID: "user_abc",
      title: "Analysis",
    })

    expect(workspace).toMatchObject({ id: "workspace_abc", tenantID: tenant.id, name: "Acme" })
    expect(session).toMatchObject({ id: "session_abc", workspaceID: workspace.id, userID: "user_abc" })
    expect(subject.calls.map((call) => call.sql)).toContain(
      "insert into cloud_workspace (id, tenant_id, external_id, name, time_created, time_updated) values ($1, $2, $3, $4, $5, $6)",
    )
    expect(subject.calls.map((call) => call.sql)).toContain(
      "insert into cloud_session (id, tenant_id, workspace_id, user_id, title, model, summary, time_created, time_updated) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_user"))?.params).toEqual([
      "user_abc",
      tenant.id,
      "user_abc",
      10,
      10,
    ])
  })

  test("creates queued jobs, prompt messages, and initial events in PostgreSQL", async () => {
    const subject = setup({
      "select * from cloud_session where tenant_id = $1 and id = $2": [
        {
          id: "session_abc",
          tenant_id: tenant.id,
          workspace_id: "workspace_abc",
          user_id: "user_abc",
          title: "Analysis",
          model: null,
          summary: null,
          time_created: 10,
          time_updated: 10,
        },
      ],
    })

    const job = await subject.service.createJob({
      sessionID: "session_abc",
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

    expect(job).toMatchObject({ id: "job_abc", status: "queued", sessionID: "session_abc" })
    expect(subject.calls.map((call) => call.sql)).toContain(
      "insert into cloud_job (id, tenant_id, workspace_id, session_id, status, execution_mode, runtime, job_spec, cost, error, time_created, time_updated) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    )
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_job "))?.params.at(7)).toContain(
      '"outputs":["md"]',
    )
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_message"))?.params).toContain(
      "Summarize files",
    )
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_job_event"))?.params).toContain(
      JSON.stringify({ status: "queued" }),
    )
  })

  test("uses persisted integrator runtime policy when creating PostgreSQL jobs", async () => {
    const subject = setup({
      "select * from cloud_session where tenant_id = $1 and id = $2": [
        {
          id: "session_abc",
          tenant_id: tenant.id,
          workspace_id: "workspace_abc",
          user_id: "user_abc",
          title: "Analysis",
          model: null,
          summary: null,
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_integrator_runtime_policy where tenant_id = $1 and integrator_id = $2": [
        {
          tenant_id: tenant.id,
          integrator_id: "integrator_abc",
          default_execution_mode: "isolated_job_runtime",
          allowed_execution_modes: ["isolated_job_runtime", "shared_session_pool"],
          max_active_jobs: 10,
          max_sessions: 500,
          max_concurrent_jobs_per_session: 1,
          time_created: 10,
          time_updated: 10,
        },
      ],
    })

    const job = await subject.service.createJob({
      sessionID: "session_abc",
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
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_job "))?.params.at(5)).toBe(
      "isolated_job_runtime",
    )
  })

  test("freezes persisted BYOK credentials when creating PostgreSQL jobs", async () => {
    const subject = setup({
      "select * from cloud_session where tenant_id = $1 and id = $2": [
        {
          id: "session_abc",
          tenant_id: tenant.id,
          workspace_id: "workspace_abc",
          user_id: "user_abc",
          title: "Analysis",
          model: null,
          summary: null,
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_llm_credential where tenant_id = $1 order by time_created, id": [
        {
          id: "llmcred_abc",
          tenant_id: tenant.id,
          scope: "integrator",
          owner_key: "integrator_abc",
          name: "Customer OpenAI",
          provider_type: "openai-compatible",
          provider: "openai",
          base_url: null,
          secret_ref: "tenant_abc/integrator_abc/Customer OpenAI",
          allowed_models: ["gpt-5"],
          default_model: "gpt-5",
          enabled: true,
          version: 1,
          last_used_at: null,
          time_created: 10,
          time_updated: 10,
        },
      ],
    })

    const job = await subject.service.createJob({
      sessionID: "session_abc",
      prompt: "Use customer key",
      inputs: [],
      outputs: ["md"],
      runtime: { profile: "standard" },
      integratorID: "integrator_abc",
      model: { credentialID: "llmcred_abc", provider: "openai", model: "gpt-5" },
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: [],
        skills: [],
      },
    })

    expect(job.modelConfigSnapshot).toMatchObject({
      credentialID: "llmcred_abc",
      credentialVersion: 1,
      provider: "openai",
      model: "gpt-5",
    })
    expect(JSON.parse(`${subject.calls.find((call) => call.sql.startsWith("insert into cloud_job "))?.params.at(8)}`)).toMatchObject({
      credentialID: "llmcred_abc",
      credentialVersion: 1,
      provider: "openai",
      model: "gpt-5",
    })
  })

  test("reads jobs and job events back through PostgreSQL repositories", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [
        {
          id: "job_abc",
          tenant_id: tenant.id,
          workspace_id: "workspace_abc",
          session_id: "session_abc",
          status: "queued",
          runtime: { engine: "opencode", version: "1.14.28", profile: "standard" },
          cost: {
            estimatedUSD: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
          error: null,
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_abc:000000000001",
          job_id: "job_abc",
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: 10,
        },
      ],
    })

    expect((await subject.service.getJob({ jobID: "job_abc" })).status).toBe("queued")
    expect((await subject.service.listJobEvents({ jobID: "job_abc" })).map((event) => event.type)).toEqual([
      "job.status",
    ])
  })

  test("creates and lists session messages through PostgreSQL", async () => {
    const subject = setup({
      "select * from cloud_session where tenant_id = $1 and id = $2": [
        {
          id: "session_abc",
          tenant_id: tenant.id,
          workspace_id: "workspace_abc",
          user_id: "user_abc",
          title: "Analysis",
          model: null,
          summary: null,
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_message where tenant_id = $1 and session_id = $2 order by time_created, id": [
        {
          id: "message_abc",
          tenant_id: tenant.id,
          workspace_id: "workspace_abc",
          session_id: "session_abc",
          job_id: null,
          role: "user",
          content: "Continue",
          time_created: 10,
          time_updated: 10,
        },
      ],
    })

    const message = await subject.service.createSessionMessage("session_abc", { content: "Continue" })

    expect(message).toMatchObject({ id: "message_abc", role: "user", content: "Continue" })
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_message"))?.params).toEqual([
      "message_abc",
      tenant.id,
      "workspace_abc",
      "session_abc",
      null,
      "user",
      "Continue",
      10,
      10,
    ])
    expect((await subject.service.listSessionMessages({ sessionID: "session_abc" })).map((item) => item.content)).toEqual([
      "Continue",
    ])
  })

  test("creates and lists file metadata through PostgreSQL", async () => {
    const subject = setup({
      "select * from cloud_workspace where tenant_id = $1 and id = $2": [
        {
          id: "workspace_abc",
          tenant_id: tenant.id,
          external_id: null,
          name: "Acme",
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_session where tenant_id = $1 and id = $2": [
        {
          id: "session_abc",
          tenant_id: tenant.id,
          workspace_id: "workspace_abc",
          user_id: "user_abc",
          title: "Analysis",
          model: null,
          summary: null,
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_file where tenant_id = $1 and ($2::text is null or workspace_id = $3) and ($4::text is null or session_id = $5) and ($6::text is null or id > $7) order by time_created, id limit $8":
        [
          {
            id: "file_abc",
            tenant_id: tenant.id,
            workspace_id: "workspace_abc",
            session_id: "session_abc",
            name: "input.csv",
            mime: "text/csv",
            size: 8,
            object_key: `${tenant.id}/workspace_abc/input.csv`,
            sha256: "sha256_abc",
            time_created: 10,
            time_updated: 10,
          },
        ],
    })

    const file = await subject.service.createFile({
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      name: "input.csv",
      mime: "text/csv",
      contentBase64: Buffer.from("a,b\n1,2\n").toString("base64"),
    })

    expect(file).toMatchObject({ id: "file_abc", workspaceID: "workspace_abc", sessionID: "session_abc", size: 8 })
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_file"))?.params).toEqual([
      "file_abc",
      tenant.id,
      "workspace_abc",
      "session_abc",
      "input.csv",
      "text/csv",
      8,
      `${tenant.id}/workspace_abc/input.csv`,
      "sha256_abc",
      10,
      10,
    ])
    expect((await subject.service.listFiles({ workspaceID: "workspace_abc", sessionID: "session_abc" })).map((item) => item.id)).toEqual([
      "file_abc",
    ])
  })

  test("cancels queued jobs and appends a status event through PostgreSQL", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [
        {
          id: "job_abc",
          tenant_id: tenant.id,
          workspace_id: "workspace_abc",
          session_id: "session_abc",
          status: "queued",
          runtime: { engine: "opencode", version: "1.14.28", profile: "standard" },
          cost: {
            estimatedUSD: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
          error: null,
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_abc:000000000001",
          job_id: "job_abc",
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: 10,
        },
      ],
    })

    const canceled = await subject.service.cancelJob({ jobID: "job_abc" })

    expect(canceled.status).toBe("canceled")
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job"))?.params).toEqual([
      "job_abc",
      tenant.id,
      "workspace_abc",
      "session_abc",
      "canceled",
      JSON.stringify({ engine: "opencode", version: "1.14.28", profile: "standard" }),
      null,
      JSON.stringify({
        estimatedUSD: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      null,
      10,
      10,
      "job_abc",
      tenant.id,
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_job_event"))?.params).toContain(
      JSON.stringify({ status: "canceled" }),
    )
  })

  test("lists artifacts and builds signed artifact downloads through PostgreSQL", async () => {
    const subject = setup({
      "select * from cloud_artifact where tenant_id = $1 and ($2::text is null or job_id = $3) and ($4::text is null or id > $5) order by time_created, id limit $6": [
        {
          id: "artifact_abc",
          tenant_id: tenant.id,
          workspace_id: "workspace_abc",
          session_id: "session_abc",
          job_id: "job_abc",
          name: "report.md",
          kind: "md",
          mime: "text/markdown",
          size: 123,
          object_key: `${tenant.id}/job_abc/report.md`,
          sha256: "sha256_report",
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_artifact where tenant_id = $1 and id = $2": [
        {
          id: "artifact_abc",
          tenant_id: tenant.id,
          workspace_id: "workspace_abc",
          session_id: "session_abc",
          job_id: "job_abc",
          name: "report.md",
          kind: "md",
          mime: "text/markdown",
          size: 123,
          object_key: `${tenant.id}/job_abc/report.md`,
          sha256: "sha256_report",
          time_created: 10,
          time_updated: 10,
        },
      ],
    }, {
      signArtifactDownload: ({ artifact, expiresAt }) => `https://storage.example.com/${artifact.objectKey}?expires=${expiresAt}`,
    })

    expect((await subject.service.listArtifacts({ jobID: "job_abc" })).map((artifact) => artifact.id)).toEqual([
      "artifact_abc",
    ])
    expect(await subject.service.getArtifactDownload({ artifactID: "artifact_abc", ttlMS: 90 })).toEqual({
      artifactID: "artifact_abc",
      url: `https://storage.example.com/${tenant.id}/job_abc/report.md?expires=100`,
      expiresAt: 100,
    })
  })

  test("creates, lists, updates, and deletes webhooks through PostgreSQL", async () => {
    const row = {
      id: "webhook_abc",
      tenant_id: tenant.id,
      url: "https://saas.example.com/hooks/runtime",
      secret_ref: "secret/webhook/webhook_abc",
      events: ["job.status"],
      enabled: true,
      time_created: "10",
      time_updated: "10",
    }
    const disabled = { ...row, enabled: false }
    const subject = setup({
      "select * from cloud_webhook_subscription where tenant_id = $1 order by time_created, id": [row],
      "select * from cloud_webhook_subscription where tenant_id = $1 and id = $2": [row, disabled],
    })

    const webhook = await subject.service.createWebhook({
      url: "https://saas.example.com/hooks/runtime",
      events: ["job.status"],
      secret: "secret_abc",
    })

    expect(webhook.enabled).toBe(true)
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_webhook_subscription"))?.params).toEqual([
      "webhook_abc",
      tenant.id,
      "https://saas.example.com/hooks/runtime",
      "secret/webhook/webhook_abc",
      JSON.stringify(["job.status"]),
      true,
      10,
      10,
    ])
    expect((await subject.service.listWebhooks()).map((item) => item.id)).toEqual(["webhook_abc"])
    expect((await subject.service.updateWebhook({ webhookID: "webhook_abc", enabled: false })).enabled).toBe(false)
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_webhook_subscription"))?.params.at(5)).toBe(false)
    expect((await subject.service.deleteWebhook({ webhookID: "webhook_abc" })).id).toBe("webhook_abc")
    expect(subject.calls.find((call) => call.sql.startsWith("delete from cloud_webhook_subscription"))?.params).toEqual([
      "webhook_abc",
      tenant.id,
    ])
  })

  test("persists runtime workers and session runtime bindings through PostgreSQL", async () => {
    const runtimeRow = {
      id: "runtime_abc",
      tenant_id: tenant.id,
      execution_mode: "shared_session_pool",
      status: "healthy",
      version: "1.14.28",
      profile: "standard",
      max_active_jobs: "4",
      max_sessions: "20",
      endpoint: "http://runtime-abc.internal",
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
    }
    const bindingRow = {
      tenant_id: tenant.id,
      session_id: "session_abc",
      runtime_id: "runtime_abc",
      time_created: 10,
      time_updated: 10,
    }
    const subject = setup({
      "select * from cloud_runtime_worker where tenant_id = $1 and id = $2": [runtimeRow],
      "select * from cloud_runtime_worker where tenant_id = $1 order by id": [runtimeRow],
      "select * from cloud_session where tenant_id = $1 and id = $2": [
        {
          id: "session_abc",
          tenant_id: tenant.id,
          workspace_id: "workspace_abc",
          user_id: "user_abc",
          title: "Analysis",
          model: null,
          summary: null,
          time_created: 10,
          time_updated: 10,
        },
      ],
      "select * from cloud_session_runtime_binding where tenant_id = $1": [],
      "select * from cloud_session_runtime_binding where tenant_id = $1 and session_id = $2": [bindingRow],
    })

    expect((await subject.service.registerRuntimeWorker({
      runtimeID: "runtime_abc",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 4,
      maxSessions: 20,
      endpoint: "http://runtime-abc.internal",
    })).id).toBe("runtime_abc")
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_runtime_worker"))?.params.at(8)).toBe(
      "http://runtime-abc.internal",
    )
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_runtime_worker"))?.params.at(9)).toBe(
      JSON.stringify(runtimeRow.metrics),
    )
    expect((await subject.service.heartbeatRuntimeWorker("runtime_abc", { status: "healthy" })).id).toBe("runtime_abc")
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_runtime_worker"))?.params).toEqual([
      "healthy",
      JSON.stringify(runtimeRow.metrics),
      10,
      tenant.id,
      "runtime_abc",
    ])
    expect((await subject.service.listRuntimeWorkers()).map((runtime) => runtime.maxActiveJobs)).toEqual([4])
    expect((await subject.service.assignSessionRuntime({ sessionID: "session_abc" })).runtimeID).toBe("runtime_abc")
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_session_runtime_binding"))?.params).toEqual([
      tenant.id,
      "session_abc",
      "runtime_abc",
      10,
      10,
    ])
    expect((await subject.service.drainRuntimeWorker({ runtimeID: "runtime_abc" })).status).toBe("draining")
    expect((await subject.service.restartRuntimeWorker({ runtimeID: "runtime_abc" }))).toMatchObject({
      status: "healthy",
      metrics: { activeJobs: 0, busySessions: 0, idleSessions: 0 },
    })
    expect((await subject.service.releaseSessionRuntime({ sessionID: "session_abc" })).runtimeID).toBe("runtime_abc")
  })

  test("persists integrator runtime policy updates through PostgreSQL", async () => {
    const policyRow = {
      tenant_id: tenant.id,
      integrator_id: "integrator_abc",
      default_execution_mode: "shared_session_pool",
      allowed_execution_modes: ["shared_session_pool", "isolated_job_runtime"],
      max_active_jobs: 10,
      max_sessions: 500,
      max_concurrent_jobs_per_session: 1,
      time_created: 10,
      time_updated: 10,
    }
    const subject = setup({
      "select * from cloud_integrator_runtime_policy where tenant_id = $1 and integrator_id = $2": [policyRow],
    })

    expect(await subject.service.getIntegratorRuntimePolicy({ integratorID: "integrator_abc" })).toMatchObject({
      tenantID: tenant.id,
      integratorID: "integrator_abc",
      maxActiveJobs: 10,
    })
    expect(await subject.service.updateIntegratorRuntimePolicy("integrator_abc", {
      defaultExecutionMode: "shared_session_pool",
      allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
      maxActiveJobs: 10,
      maxSessions: 500,
      maxConcurrentJobsPerSession: 1,
    })).toMatchObject({
      integratorID: "integrator_abc",
      maxSessions: 500,
    })
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_integrator_runtime_policy"))?.params).toEqual([
      tenant.id,
      "integrator_abc",
      "shared_session_pool",
      JSON.stringify(["shared_session_pool", "isolated_job_runtime"]),
      10,
      500,
      1,
      10,
      10,
    ])
  })

  test("rejects session creation when the workspace is outside the tenant boundary", async () => {
    const subject = setup({
      "select * from cloud_workspace where tenant_id = $1 and id = $2": [],
    })

    await expect(subject.service.createSession({ workspaceID: "workspace_other", userID: "user_abc" })).rejects.toThrow(
      "Cloud workspace not found",
    )
  })
})
