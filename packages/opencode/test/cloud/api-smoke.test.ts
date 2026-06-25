import { describe, expect, test } from "bun:test"
import { CloudAPISmoke } from "../../src/cloud/api-smoke"

describe("CloudAPISmoke", () => {
  test("runs the public API workflow against the local app", async () => {
    const result = await CloudAPISmoke.runCLI({
      env: {
        CLOUD_RUNTIME_API_SMOKE_HOSTNAME: "127.0.0.1",
        CLOUD_RUNTIME_API_SMOKE_PORT: "0",
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime API smoke: passed")
    expect(result.output).toContain("[passed] health")
    expect(result.output).toContain("[passed] create-llm-credential")
    expect(result.output).toContain("[passed] admin-runtime-policy")
    expect(result.output).toContain("[passed] create-job")
    expect(result.output).toContain("[passed] cancel-job")
  })

  test("renders JSON evidence for the public API smoke", async () => {
    const result = await CloudAPISmoke.runCLI({
      env: {
        CLOUD_RUNTIME_API_SMOKE_HOSTNAME: "127.0.0.1",
        CLOUD_RUNTIME_API_SMOKE_PORT: "0",
      },
      json: true,
    })
    const evidence = JSON.parse(result.output) as {
      schemaVersion: number
      status: string
      steps: Array<{ name: string; ok: boolean }>
      ids: Record<string, string>
    }

    expect(result.exitCode).toBe(0)
    expect(evidence.schemaVersion).toBe(1)
    expect(evidence.status).toBe("passed")
    expect(evidence.steps.every((item) => item.ok)).toBe(true)
    expect(evidence.ids.jobID).toBe("job_1")
    expect(evidence.ids.credentialID).toBe("llmcred_1")
  })

  test("can smoke an externally supplied base URL without starting a local server", async () => {
    const requests: Array<{ method: string; path: string }> = []
    const result = await CloudAPISmoke.runCLI({
      env: {
        CLOUD_RUNTIME_API_SMOKE_BASE_URL: "https://runtime.example.com",
      },
      serve: async () => {
        throw new Error("should not start a local server")
      },
      fetch: async (request) => {
        requests.push({ method: request.method, path: new URL(request.url).pathname + new URL(request.url).search })
        const path = new URL(request.url).pathname
        if (path === "/health") {
          return Response.json({ healthy: true })
        }
        if (path === "/openapi.json") {
          return Response.json({ paths: { "/v1/jobs": {}, "/v1/llm-credentials": {}, "/admin/runtime-pools": {} } })
        }
        if (path === "/v1/llm-credentials" && request.method === "POST") {
          return Response.json({
            id: "llmcred_1",
            scope: "external_user",
            ownerKey: "smoke_integrator:smoke_tenant:smoke_user",
            name: "Smoke BYOK",
            providerType: "anthropic",
            provider: "anthropic",
            allowedModels: ["claude-sonnet-4-5"],
            defaultModel: "claude-sonnet-4-5",
            enabled: true,
            version: 1,
            created: 1,
            updated: 1,
          })
        }
        if (path === "/v1/llm-credentials" && request.method === "GET") {
          return Response.json([])
        }
        if (path === "/v1/llm-credentials/llmcred_1/test") {
          return Response.json({ ok: true, credentialID: "llmcred_1", provider: "anthropic", model: "claude-sonnet-4-5" })
        }
        if (path === "/v1/llm-credentials/llmcred_1") {
          return Response.json({
            id: "llmcred_1",
            scope: "external_user",
            ownerKey: "smoke_integrator:smoke_tenant:smoke_user",
            name: "Smoke BYOK",
            providerType: "anthropic",
            provider: "anthropic",
            allowedModels: ["claude-sonnet-4-5"],
            defaultModel: "claude-sonnet-4-5",
            enabled: false,
            version: 2,
            created: 1,
            updated: 2,
          })
        }
        if (path === "/admin/runtime-pools") {
          return Response.json({ runtimes: 0, healthy: 0, draining: 0, overloaded: 0, offline: 0, activeJobs: 0, busySessions: 0, idleSessions: 0 })
        }
        if (path === "/admin/integrators/smoke_integrator/runtime-policy") {
          return Response.json({
            tenantID: "tenant_abc",
            integratorID: "smoke_integrator",
            defaultExecutionMode: "shared_session_pool",
            allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
            maxActiveJobs: 10,
            maxSessions: 100,
            maxConcurrentJobsPerSession: 1,
          })
        }
        if (path === "/v1/workspaces") {
          return Response.json({ id: "workspace_1" })
        }
        if (path === "/v1/sessions") {
          return Response.json({ id: "session_1" })
        }
        if (path === "/v1/files") {
          return Response.json({ id: "file_1" })
        }
        if (path === "/v1/jobs") {
          return Response.json({ id: "job_1" })
        }
        if (path === "/v1/tools") {
          return Response.json({ mcp: {}, skills: {}, connectors: {} })
        }
        if (path === "/v1/artifacts") {
          return Response.json([])
        }
        if (path === "/v1/jobs/job_1/events") {
          return Response.json([])
        }
        if (path === "/v1/jobs/job_1/cancel") {
          return Response.json({ id: "job_1" })
        }
        return Response.json({ error: { code: "not_found", message: path } }, { status: 404 })
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("https://runtime.example.com")
    expect(requests.map((item) => [item.method, item.path])).toContainEqual(["POST", "/v1/jobs/job_1/cancel"])
  })

  test("can start and stop an injected real-server smoke target", async () => {
    const lifecycle: string[] = []
    const result = await CloudAPISmoke.runCLI({
      env: {
        CLOUD_RUNTIME_API_SMOKE_REAL_SERVER: "1",
        CLOUD_RUNTIME_API_SMOKE_PORT: "8789",
      },
      serve: async () => {
        lifecycle.push("start")
        return {
          server: {
            hostname: "127.0.0.1",
            port: 8789,
            stop: async () => {
              lifecycle.push("stop")
            },
          },
        }
      },
      fetch: async (request) => {
        const path = new URL(request.url).pathname
        if (path === "/health") return Response.json({ healthy: true })
        if (path === "/openapi.json") return Response.json({ paths: { "/v1/jobs": {}, "/v1/llm-credentials": {}, "/admin/runtime-pools": {} } })
        if (path === "/v1/llm-credentials" && request.method === "POST") {
          return Response.json({
            id: "llmcred_1",
            scope: "external_user",
            ownerKey: "smoke_integrator:smoke_tenant:smoke_user",
            name: "Smoke BYOK",
            providerType: "anthropic",
            provider: "anthropic",
            allowedModels: ["claude-sonnet-4-5"],
            defaultModel: "claude-sonnet-4-5",
            enabled: true,
            version: 1,
            created: 1,
            updated: 1,
          })
        }
        if (path === "/v1/llm-credentials" && request.method === "GET") return Response.json([])
        if (path === "/v1/llm-credentials/llmcred_1/test") {
          return Response.json({ ok: true, credentialID: "llmcred_1", provider: "anthropic", model: "claude-sonnet-4-5" })
        }
        if (path === "/v1/llm-credentials/llmcred_1") {
          return Response.json({
            id: "llmcred_1",
            scope: "external_user",
            ownerKey: "smoke_integrator:smoke_tenant:smoke_user",
            name: "Smoke BYOK",
            providerType: "anthropic",
            provider: "anthropic",
            allowedModels: ["claude-sonnet-4-5"],
            defaultModel: "claude-sonnet-4-5",
            enabled: false,
            version: 2,
            created: 1,
            updated: 2,
          })
        }
        if (path === "/admin/runtime-pools") {
          return Response.json({ runtimes: 0, healthy: 0, draining: 0, overloaded: 0, offline: 0, activeJobs: 0, busySessions: 0, idleSessions: 0 })
        }
        if (path === "/admin/integrators/smoke_integrator/runtime-policy") {
          return Response.json({
            tenantID: "tenant_abc",
            integratorID: "smoke_integrator",
            defaultExecutionMode: "shared_session_pool",
            allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
            maxActiveJobs: 10,
            maxSessions: 100,
            maxConcurrentJobsPerSession: 1,
          })
        }
        if (path === "/v1/workspaces") return Response.json({ id: "workspace_1" })
        if (path === "/v1/sessions") return Response.json({ id: "session_1" })
        if (path === "/v1/files") return Response.json({ id: "file_1" })
        if (path === "/v1/jobs") return Response.json({ id: "job_1" })
        if (path === "/v1/tools") return Response.json({ mcp: {}, skills: {}, connectors: {} })
        if (path === "/v1/artifacts") return Response.json([])
        if (path === "/v1/jobs/job_1/events") return Response.json([])
        if (path === "/v1/jobs/job_1/cancel") return Response.json({ id: "job_1" })
        return Response.json({ error: { code: "not_found", message: path } }, { status: 404 })
      },
    })

    expect(result.exitCode).toBe(0)
    expect(lifecycle).toEqual(["start", "stop"])
    expect(result.output).toContain("http://127.0.0.1:8789")
  })

  test("exposes package scripts for API smoke checks", async () => {
    const scripts = (await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts

    expect(scripts["cloud:api:smoke"]).toBe("bun run ./src/cloud/api-smoke.ts")
    expect(scripts["cloud:api:smoke:json"]).toBe("bun run ./src/cloud/api-smoke.ts --json")
    expect(scripts["cloud:api:smoke:server"]).toBe("CLOUD_RUNTIME_API_SMOKE_REAL_SERVER=1 bun run ./src/cloud/api-smoke.ts")
  })
})
