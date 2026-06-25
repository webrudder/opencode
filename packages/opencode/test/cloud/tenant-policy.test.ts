import { describe, expect, test } from "bun:test"
import { CloudTenantPolicy } from "../../src/cloud/tenant-policy"

const tenant = {
  id: "tenant_abc",
  defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
  allowedModels: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
  budget: {
    dailyUSD: 100,
    jobUSD: 5,
  },
  runtime: {
    defaultVersion: "1.14.28",
    defaultImage: "registry.example.com/cloud-runtime-opencode:1.14.28",
    defaultImageDigest: "sha256:stable",
    pinnedVersion: "1.14.28",
  },
  tools: {
    webfetch: { enabled: true, allowDomains: ["docs.example.com"] },
    websearch: { enabled: true, providers: ["platform-search"] },
    mcp: ["browser"],
    skills: ["report-writer@1.0.0"],
  },
  rateLimits: {
    "jobs.create": { limit: 20, windowMS: 60_000 },
  },
}

describe("CloudTenantPolicy", () => {
  test("builds orchestrator policy from tenant configuration", () => {
    expect(
      CloudTenantPolicy.orchestrator({
        tenant,
        runtimeVersions: {
          "1.14.28": {
            version: "1.14.28",
            image: "registry.example.com/cloud-runtime-opencode:1.14.28",
            imageDigest: "sha256:stable",
          },
        },
      }),
    ).toEqual({
      tenant: {
        id: "tenant_abc",
        defaultRuntimeVersion: "1.14.28",
        defaultRuntimeImage: "registry.example.com/cloud-runtime-opencode:1.14.28",
        defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
        allowedModels: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
      },
      toolPolicy: {
        webfetch: { enabled: true, allowDomains: ["docs.example.com"] },
        websearch: { enabled: true, providers: ["platform-search"] },
        mcp: ["browser"],
        skills: ["report-writer@1.0.0"],
      },
      runtime: {
        defaults: {
          version: "1.14.28",
          image: "registry.example.com/cloud-runtime-opencode:1.14.28",
          imageDigest: "sha256:stable",
        },
        tenantPinnedVersion: "1.14.28",
        versions: {
          "1.14.28": {
            version: "1.14.28",
            image: "registry.example.com/cloud-runtime-opencode:1.14.28",
            imageDigest: "sha256:stable",
          },
        },
      },
    })
  })

  test("builds budget and rate limit guardrail inputs", () => {
    expect(CloudTenantPolicy.budget(tenant)).toEqual({
      tenantBudgetUSD: 100,
      jobBudgetUSD: 5,
    })
    expect(CloudTenantPolicy.rateLimit({ tenant, action: "jobs.create" })).toEqual({
      tenantID: "tenant_abc",
      action: "jobs.create",
      limit: 20,
      windowMS: 60_000,
    })
  })

  test("rejects model overrides outside tenant allowlist", () => {
    expect(() =>
      CloudTenantPolicy.assertModel({
        tenant,
        model: { provider: "unknown", model: "model" },
      }),
    ).toThrow("Cloud tenant model denied: unknown/model")
  })

  test("normalizes integrator runtime policy for admin updates", () => {
    expect(
      CloudTenantPolicy.integratorRuntimePolicy({
        tenantID: "tenant_abc",
        integratorID: "integrator_abc",
        defaultExecutionMode: "shared_session_pool",
        allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
        maxActiveJobs: 10,
        maxSessions: 500,
        maxConcurrentJobsPerSession: 1,
      }),
    ).toEqual({
      tenantID: "tenant_abc",
      integratorID: "integrator_abc",
      defaultExecutionMode: "shared_session_pool",
      allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
      maxActiveJobs: 10,
      maxSessions: 500,
      maxConcurrentJobsPerSession: 1,
    })
  })

  test("rejects invalid integrator runtime policy updates", () => {
    expect(() =>
      CloudTenantPolicy.integratorRuntimePolicy({
        tenantID: "tenant_abc",
        integratorID: "integrator_abc",
        defaultExecutionMode: "local_dev",
        allowedExecutionModes: ["shared_session_pool"],
        maxActiveJobs: 0,
        maxSessions: 10,
        maxConcurrentJobsPerSession: 2,
      }),
    ).toThrow("Cloud runtime policy default execution mode denied: local_dev")
  })
})
