import { describe, expect, test } from "bun:test"
import { CloudAPIMount } from "../../src/cloud/api-mount"

describe("CloudAPIMount", () => {
  test("plans mounted cloud runtime routes behind auth and CORS", () => {
    const result = CloudAPIMount.plan({
      basePath: "cloud",
      authMode: "api_key",
      corsOrigins: ["https://saas.example.com"],
      exposeOpenAPI: true,
    })

    expect(result.basePath).toBe("/cloud")
    expect(result.middleware).toEqual([
      {
        name: "cors",
        allowOrigins: ["https://saas.example.com"],
        allowHeaders: ["authorization", "content-type", "x-cloud-runtime-tenant"],
        exposeHeaders: ["x-request-id"],
      },
      {
        name: "auth",
        mode: "api_key",
        requiredHeaders: ["authorization"],
      },
    ])
    expect(result.routes.map((route) => route.mountedPath)).toContain("/cloud/v1/files")
    expect(result.routes.map((route) => route.mountedPath)).toContain("/cloud/v1/jobs")
    expect(result.routes.map((route) => route.mountedPath)).toContain("/cloud/v1/jobs/:id")
    expect(result.routes.map((route) => route.mountedPath)).toContain("/cloud/v1/jobs/:id/cancel")
    expect(result.routes.map((route) => route.mountedPath)).toContain("/cloud/v1/jobs/:id/events/stream")
    expect(result.routes.map((route) => route.mountedPath)).toContain("/cloud/v1/webhooks")
    expect(result.routes.map((route) => route.mountedPath)).toContain("/cloud/v1/webhooks/:id")
    expect(result.routes.map((route) => `${route.method} ${route.mountedPath}`)).toContain("DELETE /cloud/v1/webhooks/:id")
    expect(result.routes.map((route) => route.mountedPath)).toContain("/cloud/openapi.json")
  })

  test("can hide health and leave routes public for internal deployments", () => {
    const result = CloudAPIMount.plan({
      basePath: "/",
      authMode: "none",
      exposeHealth: false,
    })

    expect(result.middleware).toEqual([])
    expect(result.routes.some((route) => route.path === "/health")).toBe(false)
    expect(result.routes.every((route) => route.public)).toBe(true)
  })

  test("builds a stable health response", () => {
    expect(CloudAPIMount.health({ version: "1.0.0", runtimeDefaultVersion: "1.14.28", time: 100 })).toEqual({
      healthy: true,
      service: "cloud-opencode-runtime",
      version: "1.0.0",
      runtimeDefaultVersion: "1.14.28",
      time: 100,
    })
  })
})
