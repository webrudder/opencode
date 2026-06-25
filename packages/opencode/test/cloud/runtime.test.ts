import { describe, expect, test } from "bun:test"
import { CloudRuntime } from "../../src/cloud/runtime"

const spec = CloudRuntime.decodeJobSpec({
  id: "job_123",
  tenantID: "tenant_abc",
  sessionID: "session_123",
  workspaceID: "workspace_123",
  runtime: {
    engine: "opencode",
    version: "1.14.28",
    image: "registry.example.com/cloud-runtime-opencode:1.14.28",
    imageDigest: "sha256:abc",
    profile: "standard",
  },
  model: {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    maxTokens: 8000,
    temperature: 0.2,
    budgetUSD: 2,
  },
  tools: {
    webfetch: { enabled: true, allowDomains: ["docs.example.com"] },
    websearch: { enabled: true, provider: "platform-search" },
    mcp: {
      browser: {
        type: "remote",
        url: "https://mcp.internal/browser",
        headers: { authorization: "Bearer token" },
      },
    },
    skills: [
      { name: "data-analysis", version: "1.0.0", path: "/bundles/skills/data-analysis/1.0.0" },
      { name: "report-writer", version: "1.0.0", path: "/bundles/skills/report-writer/1.0.0" },
    ],
  },
  permissions: {
    filesystem: "workspace_only",
    shell: "restricted",
    network: ["storage.internal", "mcp.internal"],
  },
  inputs: ["file_1", "file_2"],
  outputs: ["csv", "xlsx", "png", "html", "md", "pdf", "json"],
})

describe("CloudRuntime", () => {
  test("builds opencode config without enabling local autoupdate", () => {
    expect(CloudRuntime.opencodeConfig(spec)).toEqual({
      autoupdate: false,
      model: "anthropic/claude-sonnet-4-5",
      mcp: {
        browser: {
          type: "remote",
          url: "https://mcp.internal/browser",
          headers: { authorization: "Bearer token" },
        },
      },
      permission: {
        bash: {
          "*": "ask",
        },
        edit: {
          "*": "allow",
        },
        external_directory: {
          "*": "deny",
        },
        read: {
          "*": "allow",
        },
        webfetch: "allow",
        websearch: "allow",
      },
      skills: {
        paths: ["/bundles/skills/data-analysis/1.0.0", "/bundles/skills/report-writer/1.0.0"],
      },
      tool_output: {
        max_bytes: 1048576,
        max_lines: 4000,
      },
    })
  })

  test("injects model credential base URL into opencode provider options", () => {
    const next = CloudRuntime.decodeJobSpec({
      ...spec,
      model: {
        provider: "anthropic",
        model: "glm-5.1",
        credentialID: "llmcred_123",
      },
      modelConfigSnapshot: {
        jobID: "job_123",
        credentialID: "llmcred_123",
        credentialVersion: 1,
        providerType: "anthropic",
        provider: "anthropic",
        baseURL: "https://dashscope.aliyuncs.com/apps/anthropic",
        secretRef: "tenant/llmcred/key",
        model: "glm-5.1",
        time: {
          created: 100,
          updated: 100,
        },
      },
    })

    expect(CloudRuntime.opencodeConfig(next).provider).toEqual({
      anthropic: {
        options: {
          baseURL: "https://dashscope.aliyuncs.com/apps/anthropic",
        },
        models: {
          "glm-5.1": {
            id: "glm-5.1",
            name: "glm-5.1",
            tool_call: true,
            temperature: true,
            limit: {
              context: 200_000,
              output: 8_192,
            },
          },
        },
      },
    })
  })

  test("allows restricted shell with explicit network-denied defaults", () => {
    const next = CloudRuntime.decodeJobSpec({
      ...spec,
      permissions: {
        ...spec.permissions,
        shell: "restricted",
      },
      tools: {
        ...spec.tools,
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
      },
    })

    expect(CloudRuntime.opencodeConfig(next).permission).toMatchObject({
      bash: { "*": "ask" },
      webfetch: "deny",
      websearch: "deny",
    })
  })

  test("keeps domain allowlists in the cloud network policy", () => {
    expect(CloudRuntime.networkPolicy(spec)).toEqual({
      allowHosts: ["docs.example.com", "mcp.internal", "storage.internal"],
    })
  })

  test("builds deterministic runtime environment attributes", () => {
    expect(
      CloudRuntime.opencodeEnvironment(spec, {
        OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=staging,service.namespace=cloud-runtime",
      }),
    ).toEqual({
      OPENCODE_CLIENT: "cloud-runtime",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_RUNTIME_JOB_ID: "job_123",
      OPENCODE_RUNTIME_TENANT_ID: "tenant_abc",
      OPENCODE_RUNTIME_SESSION_ID: "session_123",
      OPENCODE_RUNTIME_WORKSPACE_ID: "workspace_123",
      OPENCODE_RUNTIME_VERSION: "1.14.28",
      OTEL_RESOURCE_ATTRIBUTES:
        "deployment.environment.name=staging,service.namespace=cloud-runtime,tenant.id=tenant_abc,workspace.id=workspace_123,session.id=session_123,job.id=job_123,runtime.engine=opencode,runtime.version=1.14.28,runtime.profile=standard,container.image.digest=sha256%3Aabc",
    })
  })

  test("rejects non-opencode runtime engines", () => {
    expect(() =>
      CloudRuntime.decodeJobSpec({
        ...spec,
        runtime: {
          ...spec.runtime,
          engine: "python",
        },
      }),
    ).toThrow()
  })
})
