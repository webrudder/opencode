import { describe, expect, test } from "bun:test"
import { CloudOpenAPI } from "../../src/cloud/openapi"

describe("CloudOpenAPI", () => {
  test("builds a stable OpenAPI document for Cloud Runtime routes", () => {
    const document = CloudOpenAPI.document({ version: "local" })
    const webhookPath = document.paths["/v1/webhooks/{id}"]

    expect(document.openapi).toBe("3.1.0")
    expect(document.info).toEqual({ title: "Cloud OpenCode Runtime API", version: "local" })
    expect(document.paths["/v1/jobs/{id}/events/stream"].get).toMatchObject({
      operationId: "streamJobEvents",
      tags: ["Jobs"],
      security: [{ bearerAuth: [] }],
    })
    expect(webhookPath.delete).toMatchObject({
      operationId: "deleteWebhook",
      tags: ["Webhooks"],
      security: [{ bearerAuth: [] }],
    })
    expect(document.paths["/v1/llm-credentials/{id}/test"].post).toMatchObject({
      operationId: "testLLMCredential",
      tags: ["LLM Credentials"],
      security: [{ bearerAuth: [] }],
    })
    expect(document.paths["/admin/runtimes/{id}/drain"].post).toMatchObject({
      operationId: "adminDrainRuntime",
      tags: ["Admin"],
      security: [{ bearerAuth: [] }],
    })
    expect(document.paths["/admin/integrators/{id}/runtime-policy"].patch).toMatchObject({
      operationId: "adminUpdateIntegratorRuntimePolicy",
      tags: ["Admin"],
      security: [{ bearerAuth: [] }],
    })
    expect(document.components.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    })
  })
})
