import { describe, expect, test } from "bun:test"
import { CloudEvent } from "../../src/cloud/event"

describe("CloudEvent", () => {
  test("builds deterministic job events", () => {
    expect(CloudEvent.status({ jobID: "job_abc", sequence: 2, status: "running", time: 20 })).toEqual({
      id: "job_abc:000000000002",
      jobID: "job_abc",
      type: "job.status",
      data: { status: "running" },
      time: 20,
    })

    expect(
      CloudEvent.message({
        jobID: "job_abc",
        sequence: 3,
        role: "assistant",
        content: "Done",
        time: 30,
      }).data,
    ).toEqual({ role: "assistant", content: "Done" })

    expect(
      CloudEvent.artifact({
        jobID: "job_abc",
        sequence: 4,
        artifactID: "artifact_abc",
        name: "report.md",
        kind: "md",
        time: 40,
      }).data,
    ).toEqual({ artifactID: "artifact_abc", name: "report.md", kind: "md" })
  })

  test("streams events after a cursor in deterministic order", () => {
    const events = [
      CloudEvent.heartbeat({ jobID: "job_abc", sequence: 4, time: 40 }),
      CloudEvent.status({ jobID: "job_abc", sequence: 1, status: "starting", time: 10 }),
      CloudEvent.error({ jobID: "job_abc", sequence: 3, message: "provider timeout", time: 30 }),
      CloudEvent.status({ jobID: "job_abc", sequence: 2, status: "running", time: 20 }),
    ]

    expect(
      CloudEvent.stream({
        events,
        cursor: "job_abc:000000000001",
        limit: 2,
      }).map((event) => event.id),
    ).toEqual(["job_abc:000000000002", "job_abc:000000000003"])
  })

  test("rejects events from another job when streaming", () => {
    expect(() =>
      CloudEvent.stream({
        jobID: "job_abc",
        events: [CloudEvent.status({ jobID: "job_other", sequence: 1, status: "running", time: 10 })],
      }),
    ).toThrow("Cloud event job mismatch")
  })

  test("advances event checkpoints monotonically", () => {
    const checkpoint = CloudEvent.checkpoint({
      tenantID: "tenant_abc",
      consumer: "webhook:webhook_abc",
      jobID: "job_abc",
      cursor: "job_abc:000000000001",
      time: 10,
    })

    expect(
      CloudEvent.advanceCheckpoint({
        checkpoint,
        cursor: "job_abc:000000000003",
        time: 30,
      }),
    ).toEqual({
      tenantID: "tenant_abc",
      consumer: "webhook:webhook_abc",
      jobID: "job_abc",
      cursor: "job_abc:000000000003",
      time: { created: 10, updated: 30 },
    })

    expect(() =>
      CloudEvent.advanceCheckpoint({
        checkpoint,
        cursor: "job_abc:000000000000",
        time: 30,
      }),
    ).toThrow("Cloud event checkpoint cannot move backwards")
  })
})
