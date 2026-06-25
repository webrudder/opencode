import { describe, expect, test } from "bun:test"
import { CloudRuntime } from "../../src/cloud/runtime"
import { CloudRuntimePool } from "../../src/cloud/runtime-pool"
import { CloudSharedSessionExecutor } from "../../src/cloud/shared-session-executor"
import { CloudStore } from "../../src/cloud/store"

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
  model: { provider: "anthropic", model: "claude-sonnet-4-5", credentialID: "cred_abc" },
  modelConfigSnapshot: {
    jobID: "job_abc",
    credentialID: "cred_abc",
    credentialVersion: 2,
    providerType: "openai-compatible",
    provider: "openai-compatible",
    secretRef: "secret/customer/key",
    model: "claude-sonnet-4-5",
    time: { created: 1, updated: 1 },
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
  inputs: [],
  outputs: ["md"],
})

function metrics(input?: Partial<CloudRuntimePool.RuntimeWorker["metrics"]>) {
  return {
    activeJobs: 0,
    busySessions: 0,
    idleSessions: 0,
    cpuPercent: 1,
    memoryPercent: 1,
    diskPercent: 1,
    recentErrorRate: 0,
    heartbeatDelayMS: 1,
    ...input,
  }
}

function createStore(input?: { jobID?: string; status?: "queued" | "running"; sessionID?: string }) {
  const store = CloudStore.create()
  const jobID = input?.jobID ?? "job_abc"
  const sessionID = input?.sessionID ?? "session_abc"
  store.putJob({
    id: jobID,
    tenantID: "tenant_abc",
    workspaceID: "workspace_abc",
    sessionID,
    status: input?.status ?? "queued",
    executionMode: "shared_session_pool",
    runtime,
    cost,
    time: { created: 1, updated: 1 },
  })
  store.putJobSpec({ ...spec, id: jobID, sessionID })
  store.putJobPrompt({ id: jobID, tenantID: "tenant_abc", jobID, prompt: "Write report" })
  store.putRuntimeWorker({
    id: "runtime_abc",
    tenantID: "tenant_abc",
    executionMode: "shared_session_pool",
    status: "healthy",
    version: "1.14.28",
    profile: "standard",
    maxActiveJobs: 2,
    maxSessions: 10,
    metrics: metrics(),
    time: { created: 1, updated: 1 },
  })
  return store
}

describe("CloudSharedSessionExecutor", () => {
  test("runs a queued job on a shared runtime and records artifacts", async () => {
    const store = createStore()
    const seen: string[] = []
    const result = await CloudSharedSessionExecutor.create({
      store,
      workerID: "shared-worker",
      now: () => 100,
      leaseTTLMS: 1000,
      runtimeRoot: "/runtime",
      runtime: async (input) => {
        seen.push(input.runtimeID)
        expect(input.launch.cwd).toBe("/runtime/sessions/session_abc/jobs/job_abc")
        expect(input.launch.artifactManifest).toBe("/runtime/sessions/session_abc/jobs/job_abc/.opencode-cloud/artifacts.json")
        expect(input.launch.env.OPENCODE_RUNTIME_WORKSPACE_DIR).toBe("/runtime/sessions/session_abc/workspace")
        expect(input.launch.env.OPENCODE_RUNTIME_INPUT_DIR).toBe("/runtime/sessions/session_abc/jobs/job_abc/input")
        expect(input.launch.env.OPENCODE_RUNTIME_OUTPUT_DIR).toBe("/runtime/sessions/session_abc/jobs/job_abc/output")
        expect(input.launch.env.OPENCODE_RUNTIME_ARTIFACT_MANIFEST).toBe(
          "/runtime/sessions/session_abc/jobs/job_abc/.opencode-cloud/artifacts.json",
        )
        expect(input.launch.env.OPENCODE_RUNTIME_SESSION_ID).toBe("session_abc")
        expect(input.spec.modelConfigSnapshot).toMatchObject({ credentialID: "cred_abc", credentialVersion: 2 })
        return {
          status: "succeeded",
          manifest: {
            version: 1,
            jobID: "job_abc",
            artifacts: [{ name: "report.md", path: "output/report.md", kind: "md", mime: "text/markdown" }],
          },
          sizeByPath: { "output/report.md": 42 },
        }
      },
    }).runJob({ tenantID: "tenant_abc", jobID: "job_abc" })

    expect(result).toEqual({ jobID: "job_abc", runtimeID: "runtime_abc", status: "succeeded" })
    expect(seen).toEqual(["runtime_abc"])
    expect(store.getSessionRuntimeBinding({ tenantID: "tenant_abc", sessionID: "session_abc" })?.runtimeID).toBe(
      "runtime_abc",
    )
    expect(store.getJob({ tenantID: "tenant_abc", id: "job_abc" })?.status).toBe("succeeded")
    expect(store.listArtifacts({ tenantID: "tenant_abc", jobID: "job_abc" })).toMatchObject([
      {
        name: "report.md",
        size: 42,
        objectKey: "tenant_abc/job_abc/artifacts/output/report.md",
      },
    ])
    expect(store.listEvents({ jobID: "job_abc" }).map((event) => event.data)).toEqual([
      { status: "leasing" },
      { status: "starting" },
      { status: "running" },
      { status: "uploading" },
      { artifactID: "job_abc:artifact:000000000001", name: "report.md", kind: "md" },
      { status: "succeeded" },
    ])
  })

  test("fails the job when the shared runtime adapter fails", async () => {
    const store = createStore()
    const result = await CloudSharedSessionExecutor.create({
      store,
      workerID: "shared-worker",
      now: () => 100,
      leaseTTLMS: 1000,
      runtimeRoot: "/runtime",
      runtime: async () => ({ status: "failed", message: "runtime failed" }),
    }).runJob({ tenantID: "tenant_abc", jobID: "job_abc" })

    expect(result).toEqual({ jobID: "job_abc", runtimeID: "runtime_abc", status: "failed", error: "runtime failed" })
    expect(store.getJob({ tenantID: "tenant_abc", id: "job_abc" })?.error).toBe("runtime failed")
    expect(store.listEvents({ jobID: "job_abc" }).map((event) => event.type)).toContain("job.error")
  })

  test("rejects a second active job for the same session", async () => {
    const store = createStore({ jobID: "job_running", status: "running" })
    store.putJob({
      id: "job_queued",
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      status: "queued",
      executionMode: "shared_session_pool",
      runtime,
      cost,
      time: { created: 2, updated: 2 },
    })
    store.putJobSpec({ ...spec, id: "job_queued" })
    store.putJobPrompt({ id: "job_queued", tenantID: "tenant_abc", jobID: "job_queued", prompt: "Next" })

    await expect(
      CloudSharedSessionExecutor.create({
        store,
        workerID: "shared-worker",
        now: () => 100,
        leaseTTLMS: 1000,
        runtimeRoot: "/runtime",
        runtime: async () => ({ status: "failed", message: "unused" }),
      }).runJob({ tenantID: "tenant_abc", jobID: "job_queued" }),
    ).rejects.toThrow("Cloud session already has an active job")
  })
})
