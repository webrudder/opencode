import { describe, expect, test } from "bun:test"
import { CloudAttempt } from "../../src/cloud/attempt"
import { CloudEvent } from "../../src/cloud/event"
import { CloudRepository } from "../../src/cloud/repository"

const time = { created: 10, updated: 20 }
const cost = {
  estimatedUSD: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
}
const runtime = { engine: "opencode" as const, version: "1.14.28", profile: "standard" as const }
const job = {
  id: "job_abc",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  status: "queued" as const,
  runtime,
  cost,
  time,
}

describe("CloudRepository", () => {
  test("maps domain records to durable snake_case rows", () => {
    expect(
      CloudRepository.jobRow({
        job,
        spec: {
          id: "job_abc",
          tenantID: "tenant_abc",
          workspaceID: "workspace_abc",
          sessionID: "session_abc",
          runtime: { engine: "opencode", version: "1.14.28", image: "opencode:1.14.28", profile: "standard" },
          model: { provider: "anthropic", model: "claude-sonnet-4-5" },
          tools: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false }, mcp: {}, skills: [] },
          permissions: { filesystem: "workspace_only", shell: "restricted", network: [] },
          inputs: [],
          outputs: ["md"],
        },
      }),
    ).toMatchObject({
      id: "job_abc",
      tenant_id: "tenant_abc",
      workspace_id: "workspace_abc",
      session_id: "session_abc",
      status: "queued",
      time_created: 10,
      time_updated: 20,
    })

    expect(
      CloudRepository.artifactRow({
        id: "artifact_abc",
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        name: "report.md",
        kind: "md",
        size: 100,
        objectKey: "tenant_abc/job_abc/report.md",
        time,
      }),
    ).toMatchObject({
      tenant_id: "tenant_abc",
      job_id: "job_abc",
      object_key: "tenant_abc/job_abc/report.md",
    })
  })

  test("plans a job creation transaction with the initial event", () => {
    expect(
      CloudRepository.createJobTransaction({
        job,
        event: CloudEvent.status({ jobID: "job_abc", sequence: 1, status: "queued", time: 10 }),
      }).map((item) => [item.action, item.table, item.key]),
    ).toEqual([
      ["insert", "cloud_job", { id: "job_abc" }],
      ["insert", "cloud_job_event", { id: "job_abc:000000000001" }],
    ])
  })

  test("plans lease and cancellation transactions with attempt lifecycle updates", () => {
    const attempt = CloudAttempt.start({ job, workerID: "worker_abc", attempt: 1, reason: "initial", now: 30 })
    expect(
      CloudRepository.recordLeaseTransaction({
        job: { ...job, status: "leasing", time: { created: 10, updated: 30 } },
        lease: { jobID: "job_abc", workerID: "worker_abc", expiresAt: 1030, heartbeatAt: 30 },
        attempt,
        event: CloudEvent.status({ jobID: "job_abc", sequence: 2, status: "leasing", time: 30 }),
      }).map((item) => item.table),
    ).toEqual(["cloud_job", "cloud_job_lease", "cloud_job_attempt", "cloud_job_event"])

    expect(
      CloudRepository.cancelJobTransaction({
        job: { ...job, status: "canceled", time: { created: 10, updated: 40 } },
        attempt: CloudAttempt.cancel({ attempt, now: 40 }),
        event: CloudEvent.status({ jobID: "job_abc", sequence: 3, status: "canceled", time: 40 }),
      }).map((item) => [item.action, item.table]),
    ).toEqual([
      ["update", "cloud_job"],
      ["update", "cloud_job_attempt"],
      ["insert", "cloud_job_event"],
      ["delete", "cloud_job_lease"],
    ])
  })
})
