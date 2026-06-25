import { describe, expect, test } from "bun:test"
import { CloudAttempt } from "../../src/cloud/attempt"
import { CloudEvent } from "../../src/cloud/event"
import { CloudRuntime } from "../../src/cloud/runtime"
import { CloudStore } from "../../src/cloud/store"
import { CloudWorkerService } from "../../src/cloud/worker-service"

const cost = {
  estimatedUSD: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
}
const runtime = {
  engine: "opencode" as const,
  version: "1.14.28",
  image: "registry.example.com/cloud-runtime-opencode:1.14.28",
  profile: "standard" as const,
}
const spec = CloudRuntime.decodeJobSpec({
  id: "job_abc",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  runtime,
  model: { provider: "anthropic", model: "claude-sonnet-4-5" },
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
  inputs: ["file_abc"],
  outputs: ["md"],
})

function createStore(status: "queued" | "leasing" | "running" = "queued") {
  const store = CloudStore.create()
  store.putJob({
    id: "job_abc",
    tenantID: "tenant_abc",
    workspaceID: "workspace_abc",
    sessionID: "session_abc",
    status,
    runtime,
    cost,
    time: { created: 1, updated: 1 },
  })
  return store
}

describe("CloudWorkerService", () => {
  test("leases a queued job and returns an opencode launch plan", () => {
    const store = createStore()
    const service = CloudWorkerService.create({
      store,
      workerID: "worker_abc",
      now: () => 100,
      leaseTTLMS: 1000,
    })
    const result = service.startJob({
      tenantID: "tenant_abc",
      spec,
      prompt: "Write a report",
      workdir: "/sandbox/work/job_abc",
    })

    expect(result.lease).toMatchObject({ jobID: "job_abc", workerID: "worker_abc", expiresAt: 1100 })
    expect(result.attempt).toMatchObject({
      id: "job_abc:attempt:000001",
      jobID: "job_abc",
      workerID: "worker_abc",
      attempt: 1,
      reason: "initial",
      status: "running",
    })
    expect(result.plan).toMatchObject({
      command: "opencode",
      args: ["run", "Write a report"],
      cwd: "/sandbox/work/job_abc",
      network: { allowHosts: ["docs.example.com", "storage.internal"] },
    })
    expect(store.getJob({ tenantID: "tenant_abc", id: "job_abc" })?.status).toBe("leasing")
    expect(store.listAttempts({ tenantID: "tenant_abc", jobID: "job_abc" }).map((attempt) => attempt.id)).toEqual([
      "job_abc:attempt:000001",
    ])
    expect(store.listEvents({ jobID: "job_abc" }).map((event) => event.data)).toEqual([{ status: "leasing" }])
  })

  test("rejects another worker while the lease is active", () => {
    const store = createStore()
    const first = CloudWorkerService.create({
      store,
      workerID: "worker_1",
      now: () => 100,
      leaseTTLMS: 1000,
    })
    first.startJob({ tenantID: "tenant_abc", spec, prompt: "Start", workdir: "/sandbox/work/job_abc" })

    expect(() =>
      CloudWorkerService.create({
        store,
        workerID: "worker_2",
        now: () => 500,
        leaseTTLMS: 1000,
      }).startJob({ tenantID: "tenant_abc", spec, prompt: "Start", workdir: "/sandbox/work/job_abc" }),
    ).toThrow("Cloud job lease is still active")
  })

  test("appends the next status event after an existing queued event", () => {
    const store = createStore()
    store.appendEvent(CloudEvent.status({ jobID: "job_abc", sequence: 1, status: "queued", time: 1 }))

    CloudWorkerService.create({
      store,
      workerID: "worker_abc",
      now: () => 100,
      leaseTTLMS: 1000,
    }).startJob({ tenantID: "tenant_abc", spec, prompt: "Start", workdir: "/sandbox/work/job_abc" })

    expect(store.listEvents({ jobID: "job_abc" }).map((event) => event.id)).toEqual([
      "job_abc:000000000001",
      "job_abc:000000000002",
    ])
  })

  test("completes a running job by collecting artifacts from a manifest", () => {
    const store = createStore("running")
    store.putAttempt(
      CloudAttempt.start({
        job: store.getJob({ tenantID: "tenant_abc", id: "job_abc" })!,
        workerID: "worker_abc",
        attempt: 1,
        reason: "initial",
        now: 100,
      }),
    )
    const result = CloudWorkerService.create({
      store,
      workerID: "worker_abc",
      now: () => 200,
      leaseTTLMS: 1000,
    }).completeJob({
      tenantID: "tenant_abc",
      jobID: "job_abc",
      manifest: {
        version: 1,
        jobID: "job_abc",
        artifacts: [
          {
            name: "report.md",
            path: "report.md",
            kind: "md",
            mime: "text/markdown",
            sha256: "abc",
          },
        ],
      },
      objectKeyPrefix: "tenant_abc/job_abc",
      sizeByPath: { "report.md": 100 },
    })

    expect(result.job.status).toBe("succeeded")
    expect(store.listAttempts({ tenantID: "tenant_abc", jobID: "job_abc" })[0].status).toBe("succeeded")
    expect(result.artifacts).toEqual([
      {
        id: "job_abc:artifact:000000000001",
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        name: "report.md",
        kind: "md",
        mime: "text/markdown",
        size: 100,
        objectKey: "tenant_abc/job_abc/report.md",
        sha256: "abc",
        time: { created: 200, updated: 200 },
      },
    ])
    expect(store.listEvents({ jobID: "job_abc" }).map((event) => event.type)).toEqual([
      "job.status",
      "job.artifact",
      "job.status",
    ])
  })

  test("fails an active job with a status and error event", () => {
    const store = createStore("running")
    store.putAttempt(
      CloudAttempt.start({
        job: store.getJob({ tenantID: "tenant_abc", id: "job_abc" })!,
        workerID: "worker_abc",
        attempt: 1,
        reason: "initial",
        now: 100,
      }),
    )
    const result = CloudWorkerService.create({
      store,
      workerID: "worker_abc",
      now: () => 300,
      leaseTTLMS: 1000,
    }).failJob({
      tenantID: "tenant_abc",
      jobID: "job_abc",
      message: "provider timeout",
    })

    expect(result.status).toBe("failed")
    expect(result.error).toBe("provider timeout")
    expect(store.listAttempts({ tenantID: "tenant_abc", jobID: "job_abc" })[0]).toMatchObject({
      status: "failed",
      error: "provider timeout",
    })
    expect(store.listEvents({ jobID: "job_abc" }).map((event) => event.type)).toEqual(["job.error", "job.status"])
  })

  test("heartbeats an active lease and records a heartbeat event", () => {
    const store = createStore("running")
    store.putLease({ jobID: "job_abc", workerID: "worker_abc", expiresAt: 500, heartbeatAt: 100 })

    const lease = CloudWorkerService.create({
      store,
      workerID: "worker_abc",
      now: () => 250,
      leaseTTLMS: 1000,
    }).heartbeat({ jobID: "job_abc" })

    expect(lease).toEqual({ jobID: "job_abc", workerID: "worker_abc", expiresAt: 1250, heartbeatAt: 250 })
    expect(store.listEvents({ jobID: "job_abc" }).map((event) => event.type)).toEqual(["job.heartbeat"])
  })

  test("cancels an active job and records a status event", () => {
    const store = createStore("running")
    store.putAttempt(
      CloudAttempt.start({
        job: store.getJob({ tenantID: "tenant_abc", id: "job_abc" })!,
        workerID: "worker_abc",
        attempt: 1,
        reason: "initial",
        now: 100,
      }),
    )
    const job = CloudWorkerService.create({
      store,
      workerID: "worker_abc",
      now: () => 400,
      leaseTTLMS: 1000,
    }).cancelJob({ tenantID: "tenant_abc", jobID: "job_abc" })

    expect(job.status).toBe("canceled")
    expect(store.listAttempts({ tenantID: "tenant_abc", jobID: "job_abc" })[0]).toMatchObject({
      status: "canceled",
      error: "canceled",
    })
    expect(store.listEvents({ jobID: "job_abc" }).map((event) => event.data)).toEqual([{ status: "canceled" }])
  })

  test("expires a stale leased job and records a status event", () => {
    const store = createStore("leasing")
    store.putLease({ jobID: "job_abc", workerID: "worker_1", expiresAt: 200, heartbeatAt: 100 })
    const job = CloudWorkerService.create({
      store,
      workerID: "worker_2",
      now: () => 300,
      leaseTTLMS: 1000,
    }).expireJob({ tenantID: "tenant_abc", jobID: "job_abc" })

    expect(job.status).toBe("expired")
    expect(store.listEvents({ jobID: "job_abc" }).map((event) => event.data)).toEqual([{ status: "expired" }])
  })
})
