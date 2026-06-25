import { describe, expect, test } from "bun:test"
import { CloudExampleSaaS } from "../../src/cloud/example-saas"

describe("CloudExampleSaaS", () => {
  test("builds an ordered SaaS integration flow", () => {
    expect(
      CloudExampleSaaS.analysisFlow({
        workspaceName: "Acme",
        userID: "user_123",
        fileName: "input.csv",
        fileBase64: "YSxiCg==",
        prompt: "Analyze this file",
      }).map((step) => [step.name, step.method, step.path]),
    ).toEqual([
      ["create_workspace", "POST", "/v1/workspaces"],
      ["create_session", "POST", "/v1/sessions"],
      ["upload_file", "POST", "/v1/files"],
      ["create_webhook", "POST", "/v1/webhooks"],
      ["create_job", "POST", "/v1/jobs"],
      ["get_job", "GET", "/v1/jobs/$create_job.id"],
      ["poll_events", "GET", "/v1/jobs/$create_job.id/events"],
      ["list_artifacts", "GET", "/v1/artifacts?jobID=$create_job.id"],
      ["download_artifact", "GET", "/v1/artifacts/$list_artifacts[0].id/download"],
      ["cancel_job", "POST", "/v1/jobs/$create_job.id/cancel"],
    ])
  })

  test("defaults to report and structured outputs", () => {
    expect(
      CloudExampleSaaS.analysisFlow({
        workspaceName: "Acme",
        userID: "user_123",
        fileName: "input.csv",
        fileBase64: "YSxiCg==",
        prompt: "Analyze this file",
      }).find((step) => step.name === "create_job")?.body,
    ).toMatchObject({
      outputs: ["md", "json"],
      runtime: { profile: "standard" },
    })
  })

  test("builds a compact TypeScript SDK snippet", () => {
    expect(CloudExampleSaaS.sdkSnippet({ baseURL: "https://runtime.example.com" })).toContain(
      `CloudSDK.create({ baseURL: "https://runtime.example.com", apiKey: process.env.CLOUD_RUNTIME_API_KEY! })`,
    )
    expect(CloudExampleSaaS.sdkSnippet({ baseURL: "https://runtime.example.com" })).toContain(
      `const status = await client.getJob({ jobID: job.id })`,
    )
    expect(CloudExampleSaaS.sdkSnippet({ baseURL: "https://runtime.example.com" })).toContain(
      `await client.createWebhook({ url: "https://saas.example.com/hooks/runtime", events: ["job.status", "job.artifact"], secret: webhookSecret })`,
    )
  })
})
