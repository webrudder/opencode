import { describe, expect, test } from "bun:test"
import { CloudSchema } from "../../src/cloud/schema"

describe("CloudSchema", () => {
  test("decodes the core cloud runtime records", () => {
    const tenant = CloudSchema.decodeTenant({
      id: "tenant_abc",
      name: "Acme",
      defaultRuntimeVersion: "1.14.28",
      allowedModels: ["anthropic/claude-sonnet-4-5"],
      budget: { dailyUSD: 100, monthlyUSD: 1000 },
      time: { created: 1, updated: 1 },
    })
    const workspace = CloudSchema.decodeWorkspace({
      id: "workspace_abc",
      tenantID: tenant.id,
      externalID: "saas-workspace-1",
      name: "Acme Workspace",
      time: { created: 1, updated: 1 },
    })
    const session = CloudSchema.decodeSession({
      id: "session_abc",
      tenantID: tenant.id,
      workspaceID: workspace.id,
      userID: "user_abc",
      title: "Runtime session",
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      time: { created: 1, updated: 1 },
    })

    expect(
      CloudSchema.decodeJob({
        id: "job_abc",
        tenantID: tenant.id,
        workspaceID: workspace.id,
        sessionID: session.id,
        status: "queued",
        runtime: { engine: "opencode", version: "1.14.28", profile: "standard" },
        cost: { estimatedUSD: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
        time: { created: 1, updated: 1 },
      }).runtime.version,
    ).toBe("1.14.28")
  })

  test("allows the planned happy-path job status transitions", () => {
    expect(CloudSchema.transitionJobStatus("queued", "leasing")).toBe("leasing")
    expect(CloudSchema.transitionJobStatus("leasing", "starting")).toBe("starting")
    expect(CloudSchema.transitionJobStatus("starting", "running")).toBe("running")
    expect(CloudSchema.transitionJobStatus("running", "uploading")).toBe("uploading")
    expect(CloudSchema.transitionJobStatus("uploading", "succeeded")).toBe("succeeded")
  })

  test("allows jobs to fail, cancel, or expire while active", () => {
    expect(CloudSchema.transitionJobStatus("leasing", "failed")).toBe("failed")
    expect(CloudSchema.transitionJobStatus("running", "canceled")).toBe("canceled")
    expect(CloudSchema.transitionJobStatus("starting", "expired")).toBe("expired")
  })

  test("rejects skipped and terminal job status transitions", () => {
    expect(() => CloudSchema.transitionJobStatus("queued", "succeeded")).toThrow("Invalid cloud job transition")
    expect(() => CloudSchema.transitionJobStatus("succeeded", "running")).toThrow("Invalid cloud job transition")
    expect(() => CloudSchema.transitionJobStatus("failed", "queued")).toThrow("Invalid cloud job transition")
  })
})
