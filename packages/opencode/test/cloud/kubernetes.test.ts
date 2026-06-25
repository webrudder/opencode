import { describe, expect, test } from "bun:test"
import { CloudKubernetes } from "../../src/cloud/kubernetes"
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
  },
  tools: {
    webfetch: { enabled: false, allowDomains: [] },
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
  outputs: ["md"],
})

const launch = CloudWorker.launchPlan(spec, {
  workdir: "/workspace",
  prompt: "Analyze the inputs",
  baseEnv: {
    PATH: "/usr/bin",
  },
})

describe("CloudKubernetes", () => {
  test("builds a locked-down pod manifest from a worker launch plan", () => {
    const pod = CloudKubernetes.pod({
      namespace: "cloud-runtime",
      launch,
      serviceAccountName: "runtime-worker",
      labels: {
        "app.kubernetes.io/name": "cloud-opencode-runtime",
      },
    })

    expect(pod).toMatchObject({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "opencode-job-123",
        namespace: "cloud-runtime",
        labels: {
          "app.kubernetes.io/name": "cloud-opencode-runtime",
          "cloud.opencode.ai/job-id": "job_123",
          "cloud.opencode.ai/tenant-id": "tenant_abc",
        },
      },
      spec: {
        restartPolicy: "Never",
        serviceAccountName: "runtime-worker",
        activeDeadlineSeconds: 1800,
        securityContext: {
          runAsNonRoot: true,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "opencode",
            image: "registry.example.com/cloud-runtime-opencode:1.14.28@sha256:abc",
            command: ["opencode"],
            args: ["run", "Analyze the inputs"],
            workingDir: "/workspace",
            volumeMounts: [
              {
                name: "workspace",
                mountPath: "/workspace",
              },
            ],
            resources: {
              requests: {
                cpu: "2",
                memory: "4096Mi",
                "ephemeral-storage": "10240Mi",
              },
              limits: {
                cpu: "2",
                memory: "4096Mi",
                "ephemeral-storage": "10240Mi",
              },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              runAsNonRoot: true,
              capabilities: { drop: ["ALL"] },
            },
          },
        ],
        volumes: [
          {
            name: "workspace",
            emptyDir: {},
          },
        ],
      },
    })
    expect(pod.spec.containers[0].env).toContainEqual({ name: "OPENCODE_DISABLE_AUTOUPDATE", value: "true" })
    expect(pod.spec.containers[0].env).toContainEqual({ name: "PATH", value: "/usr/bin" })
  })

  test("adds runtime class for stronger isolation", () => {
    expect(
      CloudKubernetes.pod({
        namespace: "cloud-runtime",
        launch: {
          ...launch,
          sandbox: {
            ...launch.sandbox,
            isolation: "gvisor",
          },
        },
      }).spec.runtimeClassName,
    ).toBe("gvisor")
  })

  test("sanitizes Kubernetes object names", () => {
    expect(
      CloudKubernetes.pod({
        namespace: "cloud-runtime",
        launch: {
          ...launch,
          sandbox: {
            ...launch.sandbox,
            jobID: "JOB_with_UNSAFE_chars",
          },
        },
      }).metadata.name,
    ).toBe("opencode-job-with-unsafe-chars")
  })

  test("builds a network policy manifest from sandbox allow hosts", () => {
    expect(
      CloudKubernetes.networkPolicy({
        namespace: "cloud-runtime",
        launch,
      }),
    ).toEqual({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: "opencode-job-123-egress",
        namespace: "cloud-runtime",
        labels: {
          "cloud.opencode.ai/job-id": "job_123",
          "cloud.opencode.ai/tenant-id": "tenant_abc",
        },
        annotations: {
          "cloud.opencode.ai/allow-hosts": "storage.internal",
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            "cloud.opencode.ai/job-id": "job_123",
          },
        },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              {
                ipBlock: {
                  cidr: "0.0.0.0/0",
                },
              },
            ],
            ports: [
              { protocol: "TCP", port: 443 },
            ],
          },
        ],
      },
    })
  })
})
