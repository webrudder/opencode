import { describe, expect, test } from "bun:test"
import { CloudAPI } from "../../src/cloud/api"
import { CloudConnector } from "../../src/cloud/connector"
import { CloudOrchestrator } from "../../src/cloud/orchestrator"

const tenant = {
  id: "tenant_abc",
  defaultRuntimeVersion: "1.14.28",
  defaultRuntimeImage: "registry.example.com/cloud-runtime-opencode:1.14.28",
  defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
  allowedModels: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
}

const session = {
  id: "session_abc",
  workspaceID: "workspace_abc",
  model: { provider: "openai", model: "gpt-5" },
}

const tools = {
  mcp: {
    browser: {
      type: "remote" as const,
      url: "https://mcp.internal/browser",
    },
  },
  skills: {
    "report-writer@1.0.0": "/bundles/skills/report-writer/1.0.0",
  },
}

describe("CloudOrchestrator", () => {
  test("plans a runtime job spec from a public API request", () => {
    const request = CloudAPI.decodeCreateJobRequest({
      sessionID: "session_abc",
      prompt: "Write a report",
      inputs: ["file_abc"],
      outputs: ["md", "pdf"],
      runtime: { profile: "standard" },
      tools: {
        webfetch: { enabled: true, allowDomains: ["docs.example.com"] },
        websearch: { enabled: true, provider: "platform-search" },
        mcp: ["browser"],
        skills: ["report-writer@1.0.0"],
      },
    })

    expect(
      CloudOrchestrator.planJob({
        id: "job_abc",
        tenant,
        session,
        request,
        tools,
      }),
    ).toMatchObject({
      id: "job_abc",
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      runtime: {
        engine: "opencode",
        version: "1.14.28",
        image: "registry.example.com/cloud-runtime-opencode:1.14.28",
        profile: "standard",
      },
      model: {
        provider: "openai",
        model: "gpt-5",
      },
      tools: {
        webfetch: { enabled: true, allowDomains: ["docs.example.com"] },
        websearch: { enabled: true, provider: "platform-search" },
        mcp: {
          browser: {
            type: "remote",
            url: "https://mcp.internal/browser",
          },
        },
        skills: [{ name: "report-writer", version: "1.0.0", path: "/bundles/skills/report-writer/1.0.0" }],
      },
      permissions: {
        filesystem: "workspace_only",
        shell: "restricted",
        network: ["mcp.internal", "storage.internal"],
      },
      inputs: ["file_abc"],
      outputs: ["md", "pdf"],
    })
  })

  test("job model override wins when allowed", () => {
    const request = CloudAPI.decodeCreateJobRequest({
      sessionID: "session_abc",
      prompt: "Use requested model",
      inputs: [],
      outputs: ["json"],
      runtime: { profile: "small" },
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: [],
        skills: [],
      },
    })

    expect(CloudOrchestrator.planJob({ id: "job_abc", tenant, session, request, tools }).model).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    })
  })

  test("rejects models outside the tenant allowlist", () => {
    const request = CloudAPI.decodeCreateJobRequest({
      sessionID: "session_abc",
      prompt: "Use forbidden model",
      inputs: [],
      outputs: ["json"],
      runtime: { profile: "small" },
      model: { provider: "unknown", model: "model" },
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: [],
        skills: [],
      },
    })

    expect(() => CloudOrchestrator.planJob({ id: "job_abc", tenant, session, request, tools })).toThrow(
      "not allowed for tenant",
    )
  })

  test("rejects unknown MCP servers and skills", () => {
    const request = CloudAPI.decodeCreateJobRequest({
      sessionID: "session_abc",
      prompt: "Use missing tools",
      inputs: [],
      outputs: ["json"],
      runtime: { profile: "small" },
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: ["missing"],
        skills: ["missing@1.0.0"],
      },
    })

    expect(() => CloudOrchestrator.planJob({ id: "job_abc", tenant, session, request, tools })).toThrow(
      "Unknown MCP server",
    )
  })

  test("uses customer credential snapshots before platform defaults", () => {
    const request = CloudAPI.decodeCreateJobRequest({
      sessionID: "session_abc",
      prompt: "Use BYOK",
      inputs: [],
      outputs: ["json"],
      runtime: { profile: "small" },
      model: { provider: "openai-compatible", model: "qwen-max", credentialID: "cred_user" },
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: [],
        skills: [],
      },
    })

    expect(
      CloudOrchestrator.planJob({
        id: "job_abc",
        tenant,
        session,
        request,
        tools,
        now: 30,
        modelCredentials: [
          {
            id: "cred_user",
            scope: "external_user",
            ownerKey: "integrator_abc/customer_abc/user_abc",
            providerType: "openai-compatible",
            provider: "openai-compatible",
            baseURL: "https://llm.customer.example/v1",
            secretRef: "secret/user",
            allowedModels: ["qwen-max"],
            defaultModel: "qwen-max",
            enabled: true,
            version: 2,
            time: { created: 10, updated: 20 },
          },
        ],
        modelContext: {
          integratorID: "integrator_abc",
          externalTenantID: "customer_abc",
          externalUserID: "user_abc",
        },
      }),
    ).toMatchObject({
      model: {
        provider: "openai-compatible",
        model: "qwen-max",
        credentialID: "cred_user",
      },
      modelConfigSnapshot: {
        jobID: "job_abc",
        credentialID: "cred_user",
        credentialVersion: 2,
        provider: "openai-compatible",
        model: "qwen-max",
      },
    })
  })

  test("applies tenant tool policy before planning a job", () => {
    const request = CloudAPI.decodeCreateJobRequest({
      sessionID: "session_abc",
      prompt: "Use unapproved web domain",
      inputs: [],
      outputs: ["json"],
      runtime: { profile: "small" },
      tools: {
        webfetch: { enabled: true, allowDomains: ["private.example.com"] },
        websearch: { enabled: false },
        mcp: [],
        skills: [],
      },
    })

    expect(() =>
      CloudOrchestrator.planJob({
        id: "job_abc",
        tenant,
        session,
        request,
        tools,
        toolPolicy: {
          webfetch: { enabled: true, allowDomains: ["docs.example.com"] },
          websearch: { enabled: false, providers: [] },
          mcp: [],
          skills: [],
        },
      }),
    ).toThrow("Cloud tool policy denied webfetch domain")
  })

  test("uses runtime version policy when provided", () => {
    const request = CloudAPI.decodeCreateJobRequest({
      sessionID: "session_abc",
      prompt: "Use selected runtime",
      inputs: [],
      outputs: ["json"],
      runtime: { profile: "standard" },
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: [],
        skills: [],
      },
    })

    expect(
      CloudOrchestrator.planJob({
        id: "job_abc",
        tenant,
        session,
        request,
        tools,
        runtime: {
          defaults: {
            version: "1.14.28",
            image: "registry.example.com/cloud-runtime-opencode:1.14.28",
            imageDigest: "sha256:stable",
          },
          canary: { version: "1.15.0", percent: 100 },
          versions: {
            "1.14.28": {
              version: "1.14.28",
              image: "registry.example.com/cloud-runtime-opencode:1.14.28",
              imageDigest: "sha256:stable",
            },
            "1.15.0": {
              version: "1.15.0",
              image: "registry.example.com/cloud-runtime-opencode:1.15.0",
              imageDigest: "sha256:canary",
            },
          },
        },
      }).runtime,
    ).toMatchObject({
      version: "1.15.0",
      image: "registry.example.com/cloud-runtime-opencode:1.15.0",
      imageDigest: "sha256:canary",
    })
  })

  test("injects scoped connector grant headers into remote MCP config", () => {
    const request = CloudAPI.decodeCreateJobRequest({
      sessionID: "session_abc",
      prompt: "Use connector-backed MCP",
      inputs: [],
      outputs: ["json"],
      runtime: { profile: "standard" },
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: ["browser"],
        skills: [],
      },
    })

    expect(
      CloudOrchestrator.planJob({
        id: "job_abc",
        tenant,
        session,
        request,
        tools,
        connectorGrants: {
          browser: CloudConnector.grant({
            tenantID: "tenant_abc",
            connector: {
              name: "browser",
              authRef: "secret/oauth/browser",
              scopes: ["web:read"],
            },
            request: {
              jobID: "job_abc",
              sessionID: "session_abc",
              scopes: ["web:read"],
            },
            token: {
              value: "short-lived-token",
              expiresAt: 1010,
            },
          }),
        },
      }).tools.mcp.browser,
    ).toEqual({
      type: "remote",
      url: "https://mcp.internal/browser",
      headers: {
        "x-cloud-connector": "browser",
        "x-cloud-connector-token": "short-lived-token",
      },
    })
  })
})
