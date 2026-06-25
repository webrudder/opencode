import { describe, expect, test } from "bun:test"
import { CloudAttempt } from "../../src/cloud/attempt"
import { CloudEvent } from "../../src/cloud/event"
import { CloudRuntimePool } from "../../src/cloud/runtime-pool"
import { CloudStore } from "../../src/cloud/store"

const time = { created: 1, updated: 1 }
const cost = {
  estimatedUSD: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
}
const runtime = { engine: "opencode" as const, version: "1.14.28", profile: "standard" as const }
const runtimeWorkerMetrics = {
  activeJobs: 0,
  busySessions: 0,
  idleSessions: 0,
  cpuPercent: 1,
  memoryPercent: 1,
  diskPercent: 1,
  recentErrorRate: 0,
  heartbeatDelayMS: 1,
}

describe("CloudStore", () => {
  test("stores and reads resources inside the current tenant boundary", () => {
    const store = CloudStore.create()

    store.putWorkspace({ id: "workspace_a", tenantID: "tenant_a", name: "A", time })
    store.putWorkspace({ id: "workspace_b", tenantID: "tenant_b", name: "B", time })
    store.putSession({
      id: "session_a",
      tenantID: "tenant_a",
      workspaceID: "workspace_a",
      userID: "user_a",
      title: "Analysis",
      time,
    })

    expect(store.getWorkspace({ tenantID: "tenant_a", id: "workspace_a" })?.name).toBe("A")
    expect(store.getWorkspace({ tenantID: "tenant_a", id: "workspace_b" })).toBeUndefined()
    expect(store.listWorkspaces({ tenantID: "tenant_a" }).map((workspace) => workspace.id)).toEqual(["workspace_a"])
    expect(store.getSession({ tenantID: "tenant_b", id: "session_a" })).toBeUndefined()
  })

  test("updates jobs only through valid status transitions", () => {
    const store = CloudStore.create()
    store.putJob({
      id: "job_a",
      tenantID: "tenant_a",
      workspaceID: "workspace_a",
      sessionID: "session_a",
      status: "queued",
      runtime,
      cost,
      time,
    })

    expect(store.updateJobStatus({ tenantID: "tenant_a", id: "job_a", status: "leasing", now: 2 }).status).toBe(
      "leasing",
    )
    expect(store.getJob({ tenantID: "tenant_a", id: "job_a" })?.time.updated).toBe(2)
    expect(() => store.updateJobStatus({ tenantID: "tenant_a", id: "job_a", status: "succeeded", now: 3 })).toThrow(
      "Invalid cloud job transition",
    )
    expect(() => store.updateJobStatus({ tenantID: "tenant_b", id: "job_a", status: "running", now: 3 })).toThrow(
      "Cloud job not found",
    )
  })

  test("lists jobs inside the current tenant boundary", () => {
    const store = CloudStore.create()
    store.putJob({
      id: "job_a",
      tenantID: "tenant_a",
      workspaceID: "workspace_a",
      sessionID: "session_a",
      status: "queued",
      runtime,
      cost,
      time,
    })
    store.putJob({
      id: "job_b",
      tenantID: "tenant_b",
      workspaceID: "workspace_b",
      sessionID: "session_b",
      status: "queued",
      runtime,
      cost,
      time,
    })

    expect(store.listJobs({ tenantID: "tenant_a" }).map((job) => job.id)).toEqual(["job_a"])
  })

  test("stores job runtime spec and prompt inside the current tenant boundary", () => {
    const store = CloudStore.create()
    store.putJobSpec({
      id: "job_a",
      tenantID: "tenant_a",
      workspaceID: "workspace_a",
      sessionID: "session_a",
      runtime: { ...runtime, image: "cloud-runtime-opencode:1.14.28" },
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: {},
        skills: [],
      },
      permissions: { filesystem: "workspace_only", shell: "restricted", network: ["storage.internal"] },
      inputs: [],
      outputs: ["md"],
    })
    store.putJobPrompt({ id: "job_a", tenantID: "tenant_a", jobID: "job_a", prompt: "Analyze this" })

    expect(store.getJobSpec({ tenantID: "tenant_a", id: "job_a" })?.runtime.version).toBe("1.14.28")
    expect(store.getJobSpec({ tenantID: "tenant_b", id: "job_a" })).toBeUndefined()
    expect(store.getJobPrompt({ tenantID: "tenant_a", jobID: "job_a" })?.prompt).toBe("Analyze this")
    expect(store.getJobPrompt({ tenantID: "tenant_b", jobID: "job_a" })).toBeUndefined()
  })

  test("appends and streams events for a single job", () => {
    const store = CloudStore.create()
    store.appendEvent(CloudEvent.status({ jobID: "job_a", sequence: 2, status: "running", time: 20 }))
    store.appendEvent(CloudEvent.status({ jobID: "job_a", sequence: 1, status: "starting", time: 10 }))
    store.appendEvent(CloudEvent.status({ jobID: "job_b", sequence: 1, status: "running", time: 10 }))

    expect(
      store
        .listEvents({
          jobID: "job_a",
          cursor: "job_a:000000000001",
        })
        .map((event) => event.id),
    ).toEqual(["job_a:000000000002"])
  })

  test("stores event checkpoints by tenant, consumer, and job", () => {
    const store = CloudStore.create()
    store.putEventCheckpoint(
      CloudEvent.checkpoint({
        tenantID: "tenant_a",
        consumer: "webhook:webhook_a",
        jobID: "job_a",
        cursor: "job_a:000000000001",
        time: 1,
      }),
    )
    store.putEventCheckpoint(
      CloudEvent.checkpoint({
        tenantID: "tenant_b",
        consumer: "webhook:webhook_a",
        jobID: "job_a",
        cursor: "job_a:000000000002",
        time: 1,
      }),
    )

    expect(
      store.getEventCheckpoint({
        tenantID: "tenant_a",
        consumer: "webhook:webhook_a",
        jobID: "job_a",
      })?.cursor,
    ).toBe("job_a:000000000001")
    expect(
      store.getEventCheckpoint({
        tenantID: "tenant_b",
        consumer: "webhook:webhook_a",
        jobID: "job_a",
      })?.cursor,
    ).toBe("job_a:000000000002")
  })

  test("stores artifacts by tenant and job", () => {
    const store = CloudStore.create()
    store.putArtifact({
      id: "artifact_a",
      tenantID: "tenant_a",
      workspaceID: "workspace_a",
      sessionID: "session_a",
      jobID: "job_a",
      name: "report.md",
      kind: "md",
      size: 100,
      objectKey: "tenant_a/job_a/report.md",
      time,
    })
    store.putArtifact({
      id: "artifact_b",
      tenantID: "tenant_b",
      workspaceID: "workspace_b",
      sessionID: "session_b",
      jobID: "job_b",
      name: "report.md",
      kind: "md",
      size: 100,
      objectKey: "tenant_b/job_b/report.md",
      time,
    })

    expect(store.listArtifacts({ tenantID: "tenant_a", jobID: "job_a" }).map((artifact) => artifact.id)).toEqual([
      "artifact_a",
    ])
  })

  test("stores messages by tenant and session", () => {
    const store = CloudStore.create()
    store.putMessage({
      id: "message_a",
      tenantID: "tenant_a",
      workspaceID: "workspace_a",
      sessionID: "session_a",
      role: "user",
      content: "Analyze this",
      time,
    })
    store.putMessage({
      id: "message_b",
      tenantID: "tenant_b",
      workspaceID: "workspace_b",
      sessionID: "session_b",
      role: "user",
      content: "Other",
      time,
    })

    expect(store.listMessages({ tenantID: "tenant_a", sessionID: "session_a" }).map((message) => message.id)).toEqual([
      "message_a",
    ])
  })

  test("stores files by tenant, workspace, and optional session", () => {
    const store = CloudStore.create()
    store.putFile({
      id: "file_a",
      tenantID: "tenant_a",
      workspaceID: "workspace_a",
      sessionID: "session_a",
      name: "input.csv",
      mime: "text/csv",
      size: 10,
      objectKey: "tenant_a/workspace_a/input.csv",
      time,
    })
    store.putFile({
      id: "file_b",
      tenantID: "tenant_b",
      workspaceID: "workspace_b",
      name: "other.csv",
      size: 10,
      objectKey: "tenant_b/workspace_b/other.csv",
      time,
    })

    expect(store.getFile({ tenantID: "tenant_a", id: "file_a" })?.name).toBe("input.csv")
    expect(store.getFile({ tenantID: "tenant_a", id: "file_b" })).toBeUndefined()
    expect(store.listFiles({ tenantID: "tenant_a", workspaceID: "workspace_a" }).map((file) => file.id)).toEqual([
      "file_a",
    ])
    expect(store.listFiles({ tenantID: "tenant_a", sessionID: "session_a" }).map((file) => file.id)).toEqual([
      "file_a",
    ])
  })

  test("stores attempts by tenant and job", () => {
    const store = CloudStore.create()
    const attempt = CloudAttempt.start({
      job: {
        id: "job_a",
        tenantID: "tenant_a",
        workspaceID: "workspace_a",
        sessionID: "session_a",
        status: "queued",
        runtime,
        cost,
        time,
      },
      workerID: "worker_a",
      attempt: 1,
      reason: "initial",
      now: 2,
    })
    store.putAttempt(attempt)

    expect(store.listAttempts({ tenantID: "tenant_a", jobID: "job_a" }).map((item) => item.id)).toEqual([
      "job_a:attempt:000001",
    ])
    expect(store.listAttempts({ tenantID: "tenant_b", jobID: "job_a" })).toEqual([])
  })

  test("stores runtime workers and session bindings inside the current tenant boundary", () => {
    const store = CloudStore.create()

    store.putRuntimeWorker({
      id: "runtime_a",
      tenantID: "tenant_a",
      executionMode: "shared_session_pool",
      status: "healthy",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 4,
      maxSessions: 20,
      metrics: runtimeWorkerMetrics,
      time,
    })
    store.putRuntimeWorker({
      id: "runtime_b",
      tenantID: "tenant_b",
      executionMode: "shared_session_pool",
      status: "healthy",
      version: "1.14.28",
      profile: "standard",
      maxActiveJobs: 4,
      maxSessions: 20,
      metrics: runtimeWorkerMetrics,
      time,
    })
    store.putSessionRuntimeBinding(
      CloudRuntimePool.bindSession({
        tenantID: "tenant_a",
        sessionID: "session_a",
        runtimeID: "runtime_a",
        now: 1,
      }),
    )

    expect(store.getRuntimeWorker({ tenantID: "tenant_a", id: "runtime_a" })?.id).toBe("runtime_a")
    expect(store.getRuntimeWorker({ tenantID: "tenant_a", id: "runtime_b" })).toBeUndefined()
    expect(store.listRuntimeWorkers({ tenantID: "tenant_a" }).map((item) => item.id)).toEqual(["runtime_a"])
    expect(store.getSessionRuntimeBinding({ tenantID: "tenant_a", sessionID: "session_a" })?.runtimeID).toBe(
      "runtime_a",
    )
    expect(store.listSessionRuntimeBindings({ tenantID: "tenant_a" }).map((binding) => binding.runtimeID)).toEqual([
      "runtime_a",
    ])
  })

  test("overwrites and releases session runtime bindings by tenant and session", () => {
    const store = CloudStore.create()

    store.putSessionRuntimeBinding(
      CloudRuntimePool.bindSession({
        tenantID: "tenant_a",
        sessionID: "session_a",
        runtimeID: "runtime_a",
        now: 1,
      }),
    )
    store.putSessionRuntimeBinding(
      CloudRuntimePool.bindSession({
        tenantID: "tenant_a",
        sessionID: "session_a",
        runtimeID: "runtime_b",
        now: 2,
      }),
    )

    expect(store.getSessionRuntimeBinding({ tenantID: "tenant_a", sessionID: "session_a" })?.runtimeID).toBe(
      "runtime_b",
    )
    expect(store.deleteSessionRuntimeBinding({ tenantID: "tenant_a", sessionID: "session_a" }).runtimeID).toBe(
      "runtime_b",
    )
    expect(store.getSessionRuntimeBinding({ tenantID: "tenant_a", sessionID: "session_a" })).toBeUndefined()
  })
})
