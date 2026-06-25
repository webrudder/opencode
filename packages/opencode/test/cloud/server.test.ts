import { describe, expect, test } from "bun:test"
import { CloudAPIKey } from "../../src/cloud/api-key"
import { CloudServer } from "../../src/cloud/server"
import { CloudSkillRegistry } from "../../src/cloud/skill-registry"

describe("CloudServer", () => {
  test("serves health and the v1 Cloud Runtime routes", async () => {
    const server = CloudServer.create({ now: () => 100, serviceVersion: "local" })

    expect(await (await server.app.request("/health")).json()).toEqual({
      healthy: true,
      service: "cloud-opencode-runtime",
      version: "local",
      runtimeDefaultVersion: "1.14.28",
      time: 100,
    })

    const workspace = (await (
      await server.app.request("/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme" }),
      })
    ).json()) as Record<string, unknown>

    expect(workspace).toMatchObject({ id: "workspace_1", name: "Acme" })
  })

  test("serves an OpenAPI document for local API consumers", async () => {
    const response = await CloudServer.create({ serviceVersion: "local" }).app.request("/openapi.json")
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body.openapi).toBe("3.1.0")
    expect(body.info).toEqual({ title: "Cloud OpenCode Runtime API", version: "local" })
    expect(Object.keys(body.paths as Record<string, unknown>)).toContain("/v1/jobs")
    expect(Object.keys(body.paths as Record<string, unknown>)).toContain("/v1/webhooks/{id}")
  })

  test("serves CORS preflight for configured SaaS origins", async () => {
    const server = CloudServer.create({ corsOrigins: ["https://saas.example.com"] })
    const response = await server.app.request("/v1/jobs", {
      method: "OPTIONS",
      headers: {
        origin: "https://saas.example.com",
        "access-control-request-method": "POST",
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("https://saas.example.com")
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization, content-type, x-cloud-runtime-tenant")
  })

  test("returns request IDs on local API responses", async () => {
    const server = CloudServer.create({ requestID: () => "req_generated" })
    const generated = await server.app.request("/health")
    const existing = await server.app.request("/health", { headers: { "x-request-id": "req_client" } })

    expect(generated.headers.get("x-request-id")).toBe("req_generated")
    expect(existing.headers.get("x-request-id")).toBe("req_client")
  })

  test("can protect routes with issued API keys", async () => {
    const key = CloudAPIKey.issue({
      id: "key_local",
      tenantID: "tenant_local",
      prefix: "ocrt",
      secret: "secret",
      now: 100,
    })
    const server = CloudServer.create({ now: () => 100, apiKeys: [key.record] })
    const unauthorized = await server.app.request("/v1/tools")

    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Cloud API key is missing or invalid",
      },
    })
    expect(
      (
        await server.app.request("/v1/tools", {
          headers: { authorization: `Bearer ${key.key}` },
        })
      ).status,
    ).toBe(200)
  })

  test("loads managed skills from environment without exposing runtime paths", async () => {
    const server = CloudServer.create({
      env: {
        CLOUD_RUNTIME_SKILL_CATALOG_JSON: JSON.stringify({
          "report-writer@1.0.0": {
            title: "Report Writer",
            description: "Create reports",
            path: "/runtime/skills/report-writer/1.0.0",
          },
        }),
        CLOUD_RUNTIME_ALLOWED_SKILLS: "report-writer@1.0.0",
      },
    })
    const tools = await (await server.app.request("/v1/tools")).json()

    expect(tools).toMatchObject({
      skills: [{ name: "report-writer@1.0.0", title: "Report Writer", description: "Create reports" }],
    })
    expect(JSON.stringify(tools)).not.toContain("/runtime/skills")
  })

  test("rejects invalid managed skill environment configuration", () => {
    expect(() =>
      CloudSkillRegistry.fromEnv({
        CLOUD_RUNTIME_SKILL_CATALOG_JSON: JSON.stringify({
          "report-writer@1.0.0": { title: "Report Writer" },
        }),
        CLOUD_RUNTIME_ALLOWED_SKILLS: "report-writer@1.0.0",
      }),
    ).toThrow("Cloud skill registry entry report-writer@1.0.0 requires path")
    expect(() =>
      CloudSkillRegistry.fromEnv({
        CLOUD_RUNTIME_SKILL_CATALOG_JSON: "{not-json",
      }),
    ).toThrow("Invalid CLOUD_RUNTIME_SKILL_CATALOG_JSON")
  })
})
