import { describe, expect, test } from "bun:test"
import { CloudEvent } from "../../src/cloud/event"
import { CloudRepository } from "../../src/cloud/repository"
import { CloudRuntime } from "../../src/cloud/runtime"
import { CloudWorker } from "../../src/cloud/worker"
import { CloudWorkerRunner } from "../../src/cloud/worker-runner"

const job = {
  id: "job_abc",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  status: "leasing" as const,
  runtime: { engine: "opencode" as const, version: "1.14.28", profile: "standard" as const },
  cost: {
    estimatedUSD: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  },
  time: { created: 10, updated: 20 },
}

const launch = CloudWorker.launchPlan(
  CloudRuntime.decodeJobSpec({
    id: "job_abc",
    tenantID: "tenant_abc",
    workspaceID: "workspace_abc",
    sessionID: "session_abc",
    runtime: { engine: "opencode", version: "1.14.28", image: "opencode:1.14.28", profile: "standard" },
    model: { provider: "anthropic", model: "claude-sonnet-4-5" },
    tools: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false }, mcp: {}, skills: [] },
    permissions: { filesystem: "workspace_only", shell: "restricted", network: ["storage.internal"] },
    inputs: ["file_abc"],
    outputs: ["md"],
  }),
  { workdir: "/sandbox/work", prompt: "Analyze" },
)

describe("CloudWorkerRunner", () => {
  test("plans the start side of a worker run", () => {
    const result = CloudWorkerRunner.start({
      tenantID: "tenant_abc",
      jobID: "job_abc",
      workerID: "worker_abc",
      leaseTTLMS: 60_000,
      bucket: "runtime",
      namespace: "cloud-runtime",
      launch,
      stagedInputs: [{ objectKey: "tenant_abc/file.csv", sandboxPath: "/sandbox/work/input/file.csv" }],
      mutations: CloudRepository.createJobTransaction({
        job,
        event: CloudEvent.status({ jobID: "job_abc", sequence: 1, status: "leasing", time: 20 }),
      }),
      now: 20,
    })

    expect(result.queue).toMatchObject({ action: "lease", queue: "cloud-runtime:standard:tenant_abc" })
    expect(result.database.map((item) => item.action)).toEqual(["begin", "write", "write", "commit"])
    expect(result.storage).toEqual([
      { action: "get", bucket: "runtime", objectKey: "tenant_abc/file.csv", destinationPath: "/sandbox/work/input/file.csv" },
    ])
    expect(result.kubernetes.map((item) => [item.action, item.resource])).toEqual([
      ["apply", "network_policy"],
      ["create", "pod"],
      ["watch", "pod"],
    ])
    expect(result.heartbeat).toMatchObject({ action: "heartbeat", time: 20 })
  })

  test("plans finish side effects after a terminal worker run", () => {
    const result = CloudWorkerRunner.finish({
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      jobID: "job_abc",
      workerID: "worker_abc",
      bucket: "runtime",
      namespace: "cloud-runtime",
      status: "succeeded",
      artifactUploads: [{ objectKey: "tenant_abc/report.md", contentType: "text/markdown", contentLength: 100 }],
      mutations: CloudRepository.cancelJobTransaction({
        job: { ...job, status: "canceled" },
        event: CloudEvent.status({ jobID: "job_abc", sequence: 2, status: "canceled", time: 30 }),
      }),
      now: 30,
    })

    expect(result.storage[0]).toMatchObject({ action: "put", objectKey: "tenant_abc/report.md" })
    expect(result.queue).toEqual({
      action: "ack",
      jobID: "job_abc",
      workerID: "worker_abc",
      terminalStatus: "succeeded",
      time: 30,
    })
    expect(result.logs).toMatchObject({ action: "logs", name: "opencode-job-abc" })
    expect(result.cleanup.map((item) => item.action)).toEqual(["delete", "delete"])
  })

  test("plans cleanup, persistence, and retry during recovery", () => {
    expect(
      CloudWorkerRunner.recover({
        tenantID: "tenant_abc",
        jobID: "job_abc",
        workerID: "worker_abc",
        namespace: "cloud-runtime",
        leaseTTLMS: 60_000,
        retryAt: 1000,
        attempt: 2,
        reason: "worker lost",
        mutations: [],
      }),
    ).toMatchObject({
      cleanup: [{ action: "delete", resource: "pod", gracePeriodSeconds: 0 }, { action: "delete", resource: "network_policy" }],
      database: [{ action: "begin", isolation: "immediate" }, { action: "commit" }],
      queue: {
        action: "retry",
        queue: "cloud-runtime:standard:tenant_abc",
        attempt: 2,
        reason: "worker lost",
      },
    })
  })

  test("runs a Kubernetes sandbox through the worker runner boundary", async () => {
    const calls: string[] = []
    const result = await CloudWorkerRunner.runSandbox({
      namespace: "cloud-runtime",
      launch,
      kubernetes: {
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
          return { phase: "Failed", exitCode: 1, reason: "Error" }
        },
        logs: async (input) => {
          calls.push(`logs:${input.name}`)
          return { text: "runtime failed" }
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
    })

    expect(calls).toEqual([
      "apply:opencode-job-abc-egress",
      "create:opencode-job-abc",
      "watch:opencode-job-abc",
      "logs:opencode-job-abc",
      "delete-pod:opencode-job-abc",
      "delete-netpol:opencode-job-abc-egress",
    ])
    expect(result).toEqual({
      jobID: "job_abc",
      podName: "opencode-job-abc",
      status: "failed",
      logs: "runtime failed",
      podStatus: { phase: "Failed", exitCode: 1, reason: "Error" },
    })
  })
})
