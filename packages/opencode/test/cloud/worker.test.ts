import { describe, expect, test } from "bun:test"
import { CloudRuntime } from "../../src/cloud/runtime"
import { CloudWorker } from "../../src/cloud/worker"

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
    websearch: { enabled: false },
    mcp: {},
    skills: [],
  },
  permissions: {
    filesystem: "workspace_only",
    shell: "restricted",
    network: ["storage.internal"],
  },
  inputs: ["file_1"],
  outputs: ["md", "json"],
})

describe("CloudWorker", () => {
  test("builds a deterministic opencode launch plan", () => {
    const plan = CloudWorker.launchPlan(spec, {
      workdir: "/sandbox/work",
      prompt: "Summarize the inputs",
      baseEnv: {
        OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=staging",
        PATH: "/usr/bin",
      },
    })

    expect(plan).toMatchObject({
      command: "opencode",
      args: ["run", "Summarize the inputs"],
      cwd: "/sandbox/work",
      artifactManifest: "/sandbox/work/.opencode-cloud/artifacts.json",
      network: { allowHosts: ["docs.example.com", "storage.internal"] },
      sandbox: {
        jobID: "job_123",
        isolation: "container",
        resources: {
          cpu: 2,
          memoryMB: 4096,
        },
      },
    })
    expect(plan.env.PATH).toBe("/usr/bin")
    expect(plan.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("true")
    expect(JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT)).toMatchObject({
      autoupdate: false,
      model: "anthropic/claude-sonnet-4-5",
      permission: {
        bash: { "*": "ask" },
        webfetch: "allow",
        websearch: "deny",
      },
    })
    expect(plan.env.OTEL_RESOURCE_ATTRIBUTES).toContain("job.id=job_123")
  })

  test("escapes the prompt as a single argument instead of shell text", () => {
    const plan = CloudWorker.launchPlan(spec, {
      workdir: "/sandbox/work",
      prompt: "hello && rm -rf /",
    })

    expect(plan.args).toEqual(["run", "hello && rm -rf /"])
  })

  test("allows deployments to pin the opencode executable path", () => {
    const plan = CloudWorker.launchPlan(spec, {
      workdir: "/sandbox/work",
      prompt: "Summarize the inputs",
      baseEnv: {
        CLOUD_RUNTIME_OPENCODE_COMMAND: "/opt/opencode/bin/opencode",
      },
    })

    expect(plan.command).toBe("/opt/opencode/bin/opencode")
  })

  test("can build a modeless Kubernetes smoke launch plan when explicitly allowed", () => {
    const plan = CloudWorker.launchPlan(spec, {
      workdir: "/sandbox/work",
      prompt: "Summarize the inputs",
      baseEnv: {
        CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE: "1",
      },
    })

    expect(plan.command).toBe("/bin/sh")
    expect(plan.args[0]).toBe("-lc")
    expect(plan.args[1]).toContain("mkdir -p .opencode-cloud")
    expect(plan.args[1]).toContain("cloud-runtime-modeless-smoke")
    expect(plan.args[1]).toContain("\"jobID\":\"job_123\"")
    expect(plan.args[1]).toContain("\"path\":\"modeless-smoke-report.md\"")
    expect(plan.args[1]).toContain("::cloud-runtime-artifacts")
    expect(plan.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  test("injects resolved model credential environment after the base environment", () => {
    const plan = CloudWorker.launchPlan(spec, {
      workdir: "/sandbox/work",
      prompt: "Summarize the inputs",
      baseEnv: {
        ANTHROPIC_API_KEY: "platform-key",
      },
      modelCredentialEnv: {
        ANTHROPIC_API_KEY: "customer-key",
      },
    })

    expect(plan.env.ANTHROPIC_API_KEY).toBe("customer-key")
  })
})
