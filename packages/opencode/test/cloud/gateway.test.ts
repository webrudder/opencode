import { describe, expect, test } from "bun:test"
import { CloudAPIKey } from "../../src/cloud/api-key"
import { CloudGateway } from "../../src/cloud/gateway"

describe("CloudGateway", () => {
  test("builds a reusable API key guard with stable JSON errors", async () => {
    const key = CloudAPIKey.issue({
      id: "key_local",
      tenantID: "tenant_local",
      prefix: "ocrt",
      secret: "secret",
      now: 100,
    })
    const guard = CloudGateway.apiKeyGuard({ apiKeys: [key.record] })

    expect(guard?.(new Request("https://runtime.example.com/v1/tools", { headers: { authorization: `Bearer ${key.key}` } }))).toBeUndefined()

    const unauthorized = guard?.(new Request("https://runtime.example.com/v1/tools"))
    expect(unauthorized?.status).toBe(401)
    expect(await unauthorized?.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Cloud API key is missing or invalid",
      },
    })
  })

  test("handles CORS preflight and response headers for allowed origins", () => {
    const middleware = CloudGateway.cors({
      origins: ["https://saas.example.com"],
      allowHeaders: ["authorization", "content-type", "x-cloud-runtime-tenant"],
      exposeHeaders: ["x-request-id"],
    })
    const preflight = middleware?.(
      new Request("https://runtime.example.com/v1/jobs", {
        method: "OPTIONS",
        headers: {
          origin: "https://saas.example.com",
          "access-control-request-method": "POST",
        },
      }),
    )
    const response = new Response("ok", { status: 200 })

    expect(preflight?.status).toBe(204)
    expect(preflight?.headers.get("access-control-allow-origin")).toBe("https://saas.example.com")
    expect(preflight?.headers.get("access-control-allow-headers")).toBe("authorization, content-type, x-cloud-runtime-tenant")
    expect(CloudGateway.withCORS({ request: new Request("https://runtime.example.com/v1/jobs", { headers: { origin: "https://saas.example.com" } }), response, origins: ["https://saas.example.com"], exposeHeaders: ["x-request-id"] }).headers.get("access-control-expose-headers")).toBe("x-request-id")
  })

  test("uses incoming request IDs or generates stable response headers", () => {
    const generated = CloudGateway.requestID({
      request: new Request("https://runtime.example.com/v1/jobs"),
      id: () => "req_generated",
    })
    const existing = CloudGateway.requestID({
      request: new Request("https://runtime.example.com/v1/jobs", { headers: { "x-request-id": "req_client" } }),
      id: () => "req_generated",
    })

    expect(generated).toBe("req_generated")
    expect(existing).toBe("req_client")
    expect(CloudGateway.withRequestID({ response: new Response("ok"), requestID: existing }).headers.get("x-request-id")).toBe(
      "req_client",
    )
  })
})
