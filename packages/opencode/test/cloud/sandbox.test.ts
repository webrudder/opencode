import { describe, expect, test } from "bun:test"
import { CloudRuntime } from "../../src/cloud/runtime"
import { CloudSandbox } from "../../src/cloud/sandbox"

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
    network: ["storage.internal", "mcp.internal"],
  },
  inputs: ["file_1"],
  outputs: ["md"],
})

describe("CloudSandbox", () => {
  test("plans sandbox resources from a runtime profile", () => {
    expect(CloudSandbox.plan(spec)).toEqual({
      jobID: "job_123",
      tenantID: "tenant_abc",
      image: "registry.example.com/cloud-runtime-opencode:1.14.28",
      imageDigest: "sha256:abc",
      isolation: "container",
      resources: {
        cpu: 2,
        memoryMB: 4096,
        diskMB: 10240,
        timeoutMS: 30 * 60 * 1000,
      },
      security: {
        runAsNonRoot: true,
        readOnlyRootFilesystem: true,
        allowPrivilegeEscalation: false,
      },
      network: {
        allowHosts: ["docs.example.com", "mcp.internal", "storage.internal"],
      },
    })
  })

  test("allows tenant overrides within platform maximums", () => {
    expect(
      CloudSandbox.plan(spec, {
        overrides: {
          resources: {
            cpu: 3,
            memoryMB: 6144,
            diskMB: 20480,
            timeoutMS: 45 * 60 * 1000,
          },
        },
        maximum: {
          cpu: 4,
          memoryMB: 8192,
          diskMB: 30720,
          timeoutMS: 60 * 60 * 1000,
        },
      }).resources,
    ).toEqual({
      cpu: 3,
      memoryMB: 6144,
      diskMB: 20480,
      timeoutMS: 45 * 60 * 1000,
    })
  })

  test("rejects resource overrides above platform maximums", () => {
    expect(() =>
      CloudSandbox.plan(spec, {
        overrides: { resources: { memoryMB: 16384 } },
        maximum: {
          cpu: 4,
          memoryMB: 8192,
          diskMB: 30720,
          timeoutMS: 60 * 60 * 1000,
        },
      }),
    ).toThrow("Cloud sandbox memory limit exceeded")
  })

  test("uses stronger isolation profiles when requested", () => {
    expect(CloudSandbox.plan(spec, { isolation: "gvisor" }).isolation).toBe("gvisor")
    expect(
      CloudSandbox.plan(CloudRuntime.decodeJobSpec({ ...spec, runtime: { ...spec.runtime, profile: "gpu" } })).resources,
    ).toMatchObject({
      cpu: 8,
      memoryMB: 32768,
    })
  })
})
