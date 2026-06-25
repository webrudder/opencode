import { describe, expect, test } from "bun:test"
import { CloudRuntime } from "../../src/cloud/runtime"
import { CloudStore } from "../../src/cloud/store"
import { CloudWorkerLoop } from "../../src/cloud/worker-loop"

const cost = {
  estimatedUSD: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
}
const runtime = {
  engine: "opencode" as const,
  version: "1.14.28",
  image: "cloud-runtime-opencode:1.14.28",
  profile: "standard" as const,
}
const spec = CloudRuntime.decodeJobSpec({
  id: "job_abc",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  runtime,
  model: { provider: "anthropic", model: "claude-sonnet-4-5" },
  tools: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false }, mcp: {}, skills: [] },
  permissions: { filesystem: "workspace_only", shell: "restricted", network: ["storage.internal"] },
  inputs: [],
  outputs: ["md"],
})

describe("CloudWorkerLoop", () => {
  test("returns idle when no queued job is available", () => {
    expect(
      CloudWorkerLoop.tick({
        store: CloudStore.create(),
        tenantID: "tenant_abc",
        workerID: "worker_abc",
        leaseTTLMS: 1000,
        now: () => 100,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
      }),
    ).toEqual({ status: "idle" })
  })

  test("leases the next queued job and returns a runner start plan", () => {
    const store = CloudStore.create()
    store.putJob({
      id: "job_abc",
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      status: "queued",
      runtime,
      cost,
      time: { created: 1, updated: 1 },
    })
    store.putJobSpec(spec)
    store.putJobPrompt({ id: "job_abc", tenantID: "tenant_abc", jobID: "job_abc", prompt: "Analyze" })

    const result = CloudWorkerLoop.tick({
      store,
      tenantID: "tenant_abc",
      workerID: "worker_abc",
      leaseTTLMS: 1000,
      now: () => 100,
      sandboxRoot: "/sandbox",
      bucket: "runtime",
      namespace: "cloud-runtime",
    })

    expect(result).toMatchObject({
      status: "started",
      jobID: "job_abc",
      lease: { jobID: "job_abc", workerID: "worker_abc", expiresAt: 1100 },
      runner: {
        queue: { action: "lease", queue: "cloud-runtime:standard:tenant_abc" },
        heartbeat: { action: "heartbeat", time: 100 },
      },
    })
    expect(store.getJob({ tenantID: "tenant_abc", id: "job_abc" })?.status).toBe("leasing")
  })

  test("heartbeats through the worker service", () => {
    const store = CloudStore.create()
    store.putLease({ jobID: "job_abc", workerID: "worker_abc", expiresAt: 200, heartbeatAt: 100 })

    expect(
      CloudWorkerLoop.heartbeat({
        store,
        workerID: "worker_abc",
        leaseTTLMS: 1000,
        now: () => 300,
        jobID: "job_abc",
      }),
    ).toEqual({ jobID: "job_abc", workerID: "worker_abc", expiresAt: 1300, heartbeatAt: 300 })
  })
})
