import { describe, expect, test } from "bun:test"
import path from "path"
import { CloudPostgresWorkerLoop } from "../../src/cloud/postgres-worker-loop"
import { CloudProductionWorker } from "../../src/cloud/production-worker"
import { CloudRuntime } from "../../src/cloud/runtime"
import { CloudWorker } from "../../src/cloud/worker"

const job = {
  id: "job_abc",
  tenant_id: "tenant_abc",
  workspace_id: "workspace_abc",
  session_id: "session_abc",
  status: "leasing",
  runtime: { engine: "opencode" as const, version: "1.14.28", image: "cloud-runtime-opencode:1.14.28", profile: "standard" as const },
  cost: {
    estimatedUSD: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  },
  error: null,
  time_created: 10,
  time_updated: 100,
}

const launch = CloudWorker.launchPlan(
  CloudRuntime.decodeJobSpec({
    id: job.id,
    tenantID: job.tenant_id,
    workspaceID: job.workspace_id,
    sessionID: job.session_id,
    runtime: job.runtime,
    model: { provider: "anthropic", model: "claude-sonnet-4-5" },
    tools: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false }, mcp: {}, skills: [] },
    permissions: { filesystem: "workspace_only", shell: "restricted", network: ["storage.internal"] },
    inputs: [],
    outputs: ["md"],
  }),
  { workdir: path.join(process.env.TMPDIR ?? "/tmp", "opencode-production-worker", job.id, "work"), prompt: "Analyze" },
)

function setup() {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    client: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        if (sql === "select * from cloud_job where tenant_id = $1 and id = $2") return { rows: [job] }
        if (sql === "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3") {
          return {
            rows: [
              {
                id: "job_abc:000000000001",
                job_id: job.id,
                sequence: 1,
                type: "job.status",
                data: { status: "queued" },
                time_created: 10,
              },
            ],
          }
        }
        if (sql === "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1") {
          return { rows: [{ id: "job_abc:attempt:000000000001" }] }
        }
        if (sql === "select count(*) as count from cloud_job_attempt where job_id = $1") return { rows: [{ count: 1 }] }
        return { rowCount: 1 }
      },
    },
  }
}

describe("CloudProductionWorker", () => {
  test("runs Kubernetes, uploads artifacts, completes PostgreSQL state, and acknowledges the queue", async () => {
    const subject = setup()
    const storageCalls: unknown[] = []
    const queueCalls: unknown[] = []

    const result = await CloudProductionWorker.completeKubernetesJob({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      workerID: "worker_abc",
      now: () => 200,
      bucket: "runtime",
      launch,
      objectKeyPrefix: "tenant_abc/job_abc/artifacts",
      kubernetes: async (input) => {
        await Bun.write(path.join(input.launch.cwd, "report.md"), "# Report\n")
        return {
          jobID: job.id,
          podName: "opencode-job-abc",
          status: "succeeded",
          logs: "done",
          podStatus: { phase: "Succeeded", exitCode: 0 },
          manifest: {
            version: 1,
            jobID: job.id,
            artifacts: [{ name: "report.md", path: "report.md", kind: "md", mime: "text/markdown", sha256: "sha_abc" }],
          },
          sizeByPath: { "report.md": 9 },
        }
      },
      storageClient: {
        putObject: async (input) => {
          storageCalls.push(input)
          return { etag: "etag_abc" }
        },
      },
      queueClient: {
        ack: async (input) => {
          queueCalls.push(input)
          return { acknowledged: true }
        },
      },
    })

    expect(result).toMatchObject({ status: "completed", jobID: job.id })
    expect(storageCalls).toEqual([
      {
        bucket: "runtime",
        objectKey: "tenant_abc/job_abc/artifacts/report.md",
        body: new Uint8Array(Buffer.from("# Report\n")),
        contentType: "text/markdown",
        contentLength: 9,
        metadata: {
          "tenant-id": job.tenant_id,
          "workspace-id": job.workspace_id,
          "session-id": job.session_id,
          "job-id": job.id,
          sha256: "sha_abc",
        },
      },
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_artifact"))?.params).toEqual([
      "job_abc:artifact:000000000001",
      job.tenant_id,
      job.workspace_id,
      job.session_id,
      job.id,
      "report.md",
      "md",
      "text/markdown",
      9,
      "tenant_abc/job_abc/artifacts/report.md",
      "sha_abc",
      200,
      200,
    ])
    expect(queueCalls).toEqual([
      {
        jobID: job.id,
        workerID: "worker_abc",
        terminalStatus: "succeeded",
        time: 200,
      },
    ])
  })

  test("fails PostgreSQL state without uploading artifacts when Kubernetes fails", async () => {
    const subject = setup()
    const storageCalls: unknown[] = []
    const queueCalls: unknown[] = []

    const result = await CloudProductionWorker.completeKubernetesJob({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      workerID: "worker_abc",
      now: () => 200,
      bucket: "runtime",
      launch,
      objectKeyPrefix: "tenant_abc/job_abc/artifacts",
      kubernetes: async () => ({
        jobID: job.id,
        podName: "opencode-job-abc",
        status: "failed",
        logs: "runtime failed",
        podStatus: { phase: "Failed", exitCode: 1 },
      }),
      storageClient: {
        putObject: async (input) => {
          storageCalls.push(input)
          return { etag: "etag_abc" }
        },
      },
      queueClient: {
        ack: async (input) => {
          queueCalls.push(input)
          return { acknowledged: true }
        },
      },
    })

    expect(result).toMatchObject({ status: "failed", jobID: job.id })
    expect(storageCalls).toEqual([])
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job set status"))?.params).toEqual([
      "failed",
      "Kubernetes sandbox opencode-job-abc failed: runtime failed",
      200,
      job.id,
      job.tenant_id,
    ])
    expect(queueCalls).toEqual([
      {
        jobID: job.id,
        workerID: "worker_abc",
        terminalStatus: "failed",
        time: 200,
      },
    ])
  })

  test("fails PostgreSQL state when artifact upload fails after Kubernetes succeeds", async () => {
    const subject = setup()
    const queueCalls: unknown[] = []

    const result = await CloudProductionWorker.completeKubernetesJob({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      workerID: "worker_abc",
      now: () => 200,
      bucket: "runtime",
      launch,
      objectKeyPrefix: "tenant_abc/job_abc/artifacts",
      kubernetes: async (input) => {
        await Bun.write(path.join(input.launch.cwd, "report.md"), "# Report\n")
        return {
          jobID: job.id,
          podName: "opencode-job-abc",
          status: "succeeded",
          logs: "done",
          podStatus: { phase: "Succeeded", exitCode: 0 },
          manifest: {
            version: 1,
            jobID: job.id,
            artifacts: [{ name: "report.md", path: "report.md", kind: "md", mime: "text/markdown" }],
          },
          sizeByPath: { "report.md": 9 },
        }
      },
      storageClient: {
        putObject: async () => {
          throw new Error("object storage unavailable")
        },
      },
      queueClient: {
        ack: async (input) => {
          queueCalls.push(input)
          return { acknowledged: true }
        },
      },
    })

    expect(result).toMatchObject({ status: "failed", jobID: job.id })
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job set status"))?.params).toEqual([
      "failed",
      "Artifact upload failed for Kubernetes sandbox opencode-job-abc: object storage unavailable",
      200,
      job.id,
      job.tenant_id,
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_artifact"))).toBeUndefined()
    expect(queueCalls).toEqual([
      {
        jobID: job.id,
        workerID: "worker_abc",
        terminalStatus: "failed",
        time: 200,
      },
    ])
  })

  test("runs shared session runtime, uploads artifacts, completes PostgreSQL state, and acknowledges the queue", async () => {
    const subject = setup()
    const storageCalls: unknown[] = []
    const queueCalls: unknown[] = []

    const result = await CloudProductionWorker.completeSharedSessionJob({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      workerID: "worker_abc",
      now: () => 200,
      bucket: "runtime",
      launch,
      objectKeyPrefix: "tenant_abc/job_abc/artifacts",
      sharedRuntime: async (input) => {
        await Bun.write(path.join(input.launch.cwd, "shared-report.md"), "# Shared Report\n")
        return {
          status: "succeeded",
          runtimeID: "runtime_shared",
          manifest: {
            version: 1,
            jobID: job.id,
            artifacts: [{ name: "shared-report.md", path: "shared-report.md", kind: "md", mime: "text/markdown" }],
          },
          sizeByPath: { "shared-report.md": 16 },
        }
      },
      storageClient: {
        putObject: async (input) => {
          storageCalls.push(input)
          return { etag: "etag_abc" }
        },
      },
      queueClient: {
        ack: async (input) => {
          queueCalls.push(input)
          return { acknowledged: true }
        },
      },
    })

    expect(result).toMatchObject({ status: "completed", jobID: job.id, runtimeID: "runtime_shared" })
    expect(storageCalls).toEqual([
      {
        bucket: "runtime",
        objectKey: "tenant_abc/job_abc/artifacts/shared-report.md",
        body: new Uint8Array(Buffer.from("# Shared Report\n")),
        contentType: "text/markdown",
        contentLength: 16,
        metadata: {
          "tenant-id": job.tenant_id,
          "workspace-id": job.workspace_id,
          "session-id": job.session_id,
          "job-id": job.id,
        },
      },
    ])
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_artifact"))?.params).toEqual([
      "job_abc:artifact:000000000001",
      job.tenant_id,
      job.workspace_id,
      job.session_id,
      job.id,
      "shared-report.md",
      "md",
      "text/markdown",
      16,
      "tenant_abc/job_abc/artifacts/shared-report.md",
      null,
      200,
      200,
    ])
    expect(queueCalls).toEqual([
      {
        jobID: job.id,
        workerID: "worker_abc",
        terminalStatus: "succeeded",
        time: 200,
      },
    ])
  })

  test("fails PostgreSQL state when shared session runtime fails", async () => {
    const subject = setup()
    const storageCalls: unknown[] = []
    const queueCalls: unknown[] = []

    const result = await CloudProductionWorker.completeSharedSessionJob({
      client: subject.client,
      tenantID: job.tenant_id,
      jobID: job.id,
      workerID: "worker_abc",
      now: () => 200,
      bucket: "runtime",
      launch,
      objectKeyPrefix: "tenant_abc/job_abc/artifacts",
      sharedRuntime: async () => ({
        status: "failed",
        runtimeID: "runtime_shared",
        message: "shared runtime failed",
      }),
      storageClient: {
        putObject: async (input) => {
          storageCalls.push(input)
          return { etag: "etag_abc" }
        },
      },
      queueClient: {
        ack: async (input) => {
          queueCalls.push(input)
          return { acknowledged: true }
        },
      },
    })

    expect(result).toMatchObject({ status: "failed", jobID: job.id, runtimeID: "runtime_shared" })
    expect(storageCalls).toEqual([])
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_job set status"))?.params).toEqual([
      "failed",
      "Shared session runtime runtime_shared failed: shared runtime failed",
      200,
      job.id,
      job.tenant_id,
    ])
    expect(queueCalls).toEqual([
      {
        jobID: job.id,
        workerID: "worker_abc",
        terminalStatus: "failed",
        time: 200,
      },
    ])
  })
})
