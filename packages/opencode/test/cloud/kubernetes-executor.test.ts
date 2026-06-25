import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { mkdtemp } from "fs/promises"
import { CloudKubernetesExecutor } from "../../src/cloud/kubernetes-executor"
import { CloudRuntime } from "../../src/cloud/runtime"
import { CloudWorker } from "../../src/cloud/worker"

const launch = CloudWorker.launchPlan(
  CloudRuntime.decodeJobSpec({
    id: "job_123",
    tenantID: "tenant_abc",
    sessionID: "session_123",
    workspaceID: "workspace_123",
    runtime: {
      engine: "opencode",
      version: "1.14.28",
      image: "registry.example.com/cloud-runtime-opencode:1.14.28",
      profile: "standard",
    },
    model: { provider: "anthropic", model: "claude-sonnet-4-5" },
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
    inputs: [],
    outputs: ["md"],
  }),
  { workdir: "/workspace", prompt: "Analyze" },
)

describe("CloudKubernetesExecutor", () => {
  test("plans network policy, pod creation, and watch operations", () => {
    expect(
      CloudKubernetesExecutor.start({
        namespace: "cloud-runtime",
        launch,
        serviceAccountName: "runtime-worker",
      }).map((item) => [item.action, item.resource]),
    ).toEqual([
      ["apply", "network_policy"],
      ["create", "pod"],
      ["watch", "pod"],
    ])

    expect(
      CloudKubernetesExecutor.start({
        namespace: "cloud-runtime",
        launch,
      })[2],
    ).toEqual({
      action: "watch",
      resource: "pod",
      namespace: "cloud-runtime",
      name: "opencode-job-123",
      until: ["Succeeded", "Failed"],
    })
  })

  test("plans logs and cleanup operations using deterministic names", () => {
    expect(
      CloudKubernetesExecutor.logs({
        namespace: "cloud-runtime",
        jobID: "JOB_with_UNSAFE_chars",
        sinceTime: 1000,
      }),
    ).toEqual({
      action: "logs",
      resource: "pod",
      namespace: "cloud-runtime",
      name: "opencode-job-with-unsafe-chars",
      container: "opencode",
      sinceTime: 1000,
    })

    expect(CloudKubernetesExecutor.stop({ namespace: "cloud-runtime", jobID: "job_123" })).toEqual([
      {
        action: "delete",
        resource: "pod",
        namespace: "cloud-runtime",
        name: "opencode-job-123",
        propagationPolicy: "Background",
        gracePeriodSeconds: 5,
      },
      {
        action: "delete",
        resource: "network_policy",
        namespace: "cloud-runtime",
        name: "opencode-job-123-egress",
        propagationPolicy: "Background",
      },
    ])
  })

  test("maps pod terminal state to cloud job status", () => {
    expect(CloudKubernetesExecutor.status({ phase: "Succeeded", exitCode: 0 })).toBe("succeeded")
    expect(CloudKubernetesExecutor.status({ phase: "Failed", exitCode: 1 })).toBe("failed")
    expect(CloudKubernetesExecutor.status({ reason: "DeadlineExceeded" })).toBe("expired")
    expect(CloudKubernetesExecutor.status({ phase: "Running" })).toBe("running")
  })

  test("executes Kubernetes operations through an injected client", async () => {
    const calls: string[] = []
    const result = await CloudKubernetesExecutor.run({
      operations: [
        ...CloudKubernetesExecutor.start({
          namespace: "cloud-runtime",
          launch,
        }),
        CloudKubernetesExecutor.logs({ namespace: "cloud-runtime", jobID: "job_123" }),
        ...CloudKubernetesExecutor.stop({ namespace: "cloud-runtime", jobID: "job_123" }),
      ],
      client: {
        applyNetworkPolicy: async (input) => {
          calls.push(`apply:${input.manifest.metadata.name}`)
          return { name: input.manifest.metadata.name }
        },
        createPod: async (input) => {
          calls.push(`create:${input.manifest.metadata.name}`)
          return { name: input.manifest.metadata.name }
        },
        watchPod: async (input) => {
          calls.push(`watch:${input.name}`)
          return { phase: "Succeeded", exitCode: 0 }
        },
        logs: async (input) => {
          calls.push(`logs:${input.name}:${input.container}`)
          return { text: "done" }
        },
        deletePod: async (input) => {
          calls.push(`delete-pod:${input.name}:${input.gracePeriodSeconds}`)
          return { name: input.name }
        },
        deleteNetworkPolicy: async (input) => {
          calls.push(`delete-netpol:${input.name}`)
          return { name: input.name }
        },
        patchDeploymentScale: async (input) => {
          calls.push(`scale:${input.name}:${input.replicas}`)
          return { name: input.name, replicas: input.replicas }
        },
      },
    })

    expect(calls).toEqual([
      "apply:opencode-job-123-egress",
      "create:opencode-job-123",
      "watch:opencode-job-123",
      "logs:opencode-job-123:opencode",
      "delete-pod:opencode-job-123:5",
      "delete-netpol:opencode-job-123-egress",
    ])
    expect(result[2]).toMatchObject({
      action: "watch",
      resource: "pod",
      jobStatus: "succeeded",
    })
    expect(result[3]).toMatchObject({
      action: "logs",
      text: "done",
    })
  })

  test("runs a sandbox lifecycle and returns terminal status with logs", async () => {
    const calls: string[] = []
    const result = await CloudKubernetesExecutor.runSandbox({
      namespace: "cloud-runtime",
      launch,
      client: {
        applyNetworkPolicy: async (input) => {
          calls.push(`apply:${input.name}`)
          return { name: input.name }
        },
        createPod: async (input) => {
          calls.push(`create:${input.name}`)
          return { name: input.name }
        },
        watchPod: async (input) => {
          calls.push(`watch:${input.name}`)
          return { phase: "Succeeded", exitCode: 0 }
        },
        logs: async (input) => {
          calls.push(`logs:${input.name}`)
          return { text: "runtime complete" }
        },
        deletePod: async (input) => {
          calls.push(`delete-pod:${input.name}:${input.gracePeriodSeconds}`)
          return { name: input.name }
        },
        deleteNetworkPolicy: async (input) => {
          calls.push(`delete-netpol:${input.name}`)
          return { name: input.name }
        },
        patchDeploymentScale: async (input) => {
          calls.push(`scale:${input.name}:${input.replicas}`)
          return { name: input.name, replicas: input.replicas }
        },
      },
    })

    expect(calls).toEqual([
      "apply:opencode-job-123-egress",
      "create:opencode-job-123",
      "watch:opencode-job-123",
      "logs:opencode-job-123",
      "delete-pod:opencode-job-123:5",
      "delete-netpol:opencode-job-123-egress",
    ])
    expect(result).toEqual({
      jobID: "job_123",
      podName: "opencode-job-123",
      status: "succeeded",
      logs: "runtime complete",
      podStatus: { phase: "Succeeded", exitCode: 0 },
    })
  })

  test("materializes modeless smoke artifacts encoded in Kubernetes logs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-k8s-log-artifacts-"))
    const smokeLaunch = { ...launch, cwd: directory, artifactManifest: path.join(directory, ".opencode-cloud", "artifacts.json") }
    const result = await CloudKubernetesExecutor.runSandbox({
      namespace: "cloud-runtime",
      launch: smokeLaunch,
      client: {
        applyNetworkPolicy: async (input) => ({ name: input.name }),
        createPod: async (input) => ({ name: input.name }),
        watchPod: async () => ({ phase: "Succeeded", exitCode: 0 }),
        logs: async () => ({
          text: [
            "runtime complete",
            `::cloud-runtime-artifacts${JSON.stringify({
              manifest: {
                version: 1,
                jobID: "job_123",
                artifacts: [{ name: "report.md", path: "report.md", kind: "md", mime: "text/markdown" }],
              },
              files: [{ path: "report.md", contentBase64: Buffer.from("# Report\n").toString("base64") }],
            })}`,
          ].join("\n"),
        }),
        deletePod: async (input) => ({ name: input.name }),
        deleteNetworkPolicy: async (input) => ({ name: input.name }),
        patchDeploymentScale: async (input) => ({ name: input.name, replicas: input.replicas }),
      },
    })

    expect(result).toMatchObject({
      status: "succeeded",
      manifest: {
        version: 1,
        jobID: "job_123",
        artifacts: [{ name: "report.md", path: "report.md", kind: "md", mime: "text/markdown" }],
      },
      sizeByPath: { "report.md": 9 },
    })
    expect(await Bun.file(path.join(directory, "report.md")).text()).toBe("# Report\n")
    expect(await Bun.file(smokeLaunch.artifactManifest).json()).toMatchObject({ jobID: "job_123" })
  })

  test("cleans up a sandbox when watch fails", async () => {
    const calls: string[] = []

    await expect(
      CloudKubernetesExecutor.runSandbox({
        namespace: "cloud-runtime",
        launch,
        client: {
          applyNetworkPolicy: async (input) => {
            calls.push(`apply:${input.name}`)
            return { name: input.name }
          },
          createPod: async (input) => {
            calls.push(`create:${input.name}`)
            return { name: input.name }
          },
          watchPod: async (input) => {
            calls.push(`watch:${input.name}`)
            throw new Error("watch failed")
          },
          logs: async (input) => {
            calls.push(`logs:${input.name}`)
            return { text: "" }
          },
          deletePod: async (input) => {
            calls.push(`delete-pod:${input.name}`)
            return { name: input.name }
          },
          deleteNetworkPolicy: async (input) => {
            calls.push(`delete-netpol:${input.name}`)
            return { name: input.name }
          },
          patchDeploymentScale: async (input) => {
            calls.push(`scale:${input.name}:${input.replicas}`)
            return { name: input.name, replicas: input.replicas }
          },
        },
      }),
    ).rejects.toThrow("watch failed")

    expect(calls).toEqual([
      "apply:opencode-job-123-egress",
      "create:opencode-job-123",
      "watch:opencode-job-123",
      "delete-pod:opencode-job-123",
      "delete-netpol:opencode-job-123-egress",
    ])
  })

  test("does not mask sandbox start failures with cleanup failures", async () => {
    const result = await CloudKubernetesExecutor.runSandbox({
      namespace: "cloud-runtime",
      launch,
      client: {
        applyNetworkPolicy: async () => {
          throw new Error("network policy rejected")
        },
        createPod: async (input) => ({ name: input.name }),
        watchPod: async () => ({ phase: "Succeeded", exitCode: 0 }),
        logs: async () => ({ text: "" }),
        deletePod: async () => {
          throw new Error("pod missing")
        },
        deleteNetworkPolicy: async () => {
          throw new Error("policy missing")
        },
        patchDeploymentScale: async (input) => ({ name: input.name, replicas: input.replicas }),
      },
    }).then(
      () => "unexpected",
      (error) => error,
    )

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe("network policy rejected")
  })

  test("patches deployment scale operations through an injected client", async () => {
    const calls: string[] = []
    const result = await CloudKubernetesExecutor.run({
      operations: [
        CloudKubernetesExecutor.scaleDeployment({
          namespace: "cloud-runtime",
          name: "cloud-runtime-worker",
          replicas: 3,
        }),
      ],
      client: {
        applyNetworkPolicy: async (input) => ({ name: input.name }),
        createPod: async (input) => ({ name: input.name }),
        watchPod: async () => ({}),
        logs: async () => ({ text: "" }),
        deletePod: async (input) => ({ name: input.name }),
        deleteNetworkPolicy: async (input) => ({ name: input.name }),
        patchDeploymentScale: async (input) => {
          calls.push(`${input.namespace}:${input.name}:${input.replicas}`)
          return { name: input.name, replicas: input.replicas }
        },
      },
    })

    expect(calls).toEqual(["cloud-runtime:cloud-runtime-worker:3"])
    expect(result).toEqual([
      {
        action: "patch",
        resource: "deployment_scale",
        name: "cloud-runtime-worker",
        replicas: 3,
      },
    ])
  })

  test("builds a fetch-based Kubernetes REST client", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null; contentType: string | null }> = []
    const client = CloudKubernetesExecutor.fetchClient({
      serverURL: "https://kubernetes.example",
      token: "token_123",
      pollIntervalMS: 0,
      maxPolls: 2,
      fetch: async (request, init) => {
        requests.push({
          url: String(request),
          method: init?.method ?? "GET",
          authorization: new Headers(init?.headers).get("authorization"),
          contentType: new Headers(init?.headers).get("content-type"),
        })
        if (String(request).includes("/log")) return new Response("runtime complete")
        if ((init?.method ?? "GET") === "GET") {
          return new Response(
            JSON.stringify({
              status: {
                phase: requests.filter((item) => item.method === "GET" && item.url.includes("/pods/opencode-job-123")).length > 1
                  ? "Succeeded"
                  : "Running",
                containerStatuses: [
                  {
                    name: "opencode",
                    state: {
                      terminated: {
                        exitCode: 0,
                        reason: "Completed",
                      },
                    },
                  },
                ],
              },
            }),
          )
        }
        return new Response(JSON.stringify({ metadata: { name: "ok" } }))
      },
    })
    const result = await CloudKubernetesExecutor.run({
      client,
      operations: [
        ...CloudKubernetesExecutor.start({ namespace: "cloud-runtime", launch }),
        CloudKubernetesExecutor.logs({ namespace: "cloud-runtime", jobID: "job_123" }),
        ...CloudKubernetesExecutor.stop({ namespace: "cloud-runtime", jobID: "job_123" }),
        CloudKubernetesExecutor.scaleDeployment({
          namespace: "cloud-runtime",
          name: "cloud-runtime-worker",
          replicas: 4,
        }),
      ],
    })

    expect(requests.map((item) => [item.method, new URL(item.url).pathname])).toEqual([
      ["PATCH", "/apis/networking.k8s.io/v1/namespaces/cloud-runtime/networkpolicies/opencode-job-123-egress"],
      ["POST", "/api/v1/namespaces/cloud-runtime/pods"],
      ["GET", "/api/v1/namespaces/cloud-runtime/pods/opencode-job-123"],
      ["GET", "/api/v1/namespaces/cloud-runtime/pods/opencode-job-123"],
      ["GET", "/api/v1/namespaces/cloud-runtime/pods/opencode-job-123/log"],
      ["DELETE", "/api/v1/namespaces/cloud-runtime/pods/opencode-job-123"],
      ["DELETE", "/apis/networking.k8s.io/v1/namespaces/cloud-runtime/networkpolicies/opencode-job-123-egress"],
      ["PATCH", "/apis/apps/v1/namespaces/cloud-runtime/deployments/cloud-runtime-worker/scale"],
    ])
    expect(requests.every((item) => item.authorization === "Bearer token_123")).toBe(true)
    expect(requests[0].contentType).toBe("application/apply-patch+yaml")
    expect(requests.at(-1)?.contentType).toBe("application/merge-patch+json")
    expect(result[2]).toMatchObject({ jobStatus: "succeeded" })
    expect(result[3]).toMatchObject({ text: "runtime complete" })
  })
})
