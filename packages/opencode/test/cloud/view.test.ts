import { describe, expect, test } from "bun:test"
import { CloudEvent } from "../../src/cloud/event"
import { CloudView } from "../../src/cloud/view"

const time = { created: 1, updated: 2 }

describe("CloudView", () => {
  test("maps workspaces and files without leaking tenant or storage keys", () => {
    expect(
      CloudView.workspace({
        id: "workspace_abc",
        tenantID: "tenant_abc",
        externalID: "external_abc",
        name: "Acme",
        time,
      }),
    ).toEqual({
      id: "workspace_abc",
      externalID: "external_abc",
      name: "Acme",
      created: 1,
      updated: 2,
    })

    expect(
      CloudView.file({
        id: "file_abc",
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        name: "input.csv",
        mime: "text/csv",
        size: 100,
        objectKey: "tenant_abc/workspace_abc/input.csv",
        sha256: "abc",
        time,
      }),
    ).toEqual({
      id: "file_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      name: "input.csv",
      mime: "text/csv",
      size: 100,
      sha256: "abc",
      created: 1,
    })
  })

  test("maps internal job records to public job responses", () => {
    expect(
      CloudView.job({
        id: "job_abc",
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        status: "running",
        runtime: { engine: "opencode", version: "1.14.28", profile: "standard" },
        cost: {
          estimatedUSD: 0.5,
          tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 2, cacheWrite: 0 },
        },
        time,
      }),
    ).toEqual({
      id: "job_abc",
      status: "running",
      sessionID: "session_abc",
      runtimeVersion: "1.14.28",
    })
  })

  test("maps artifacts without leaking object keys", () => {
    expect(
      CloudView.artifact({
        id: "artifact_abc",
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
        time,
      }),
    ).toEqual({
      id: "artifact_abc",
      jobID: "job_abc",
      name: "report.md",
      kind: "md",
      mime: "text/markdown",
      size: 100,
      sha256: "abc",
      created: 1,
    })
  })

  test("maps sessions, messages, and events for SDK responses", () => {
    expect(
      CloudView.session({
        id: "session_abc",
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        userID: "user_abc",
        title: "Analysis",
        summary: "Short summary",
        time,
      }),
    ).toEqual({
      id: "session_abc",
      workspaceID: "workspace_abc",
      userID: "user_abc",
      title: "Analysis",
      summary: "Short summary",
      created: 1,
      updated: 2,
    })

    expect(
      CloudView.message({
        id: "message_abc",
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        role: "assistant",
        content: "Done",
        time,
      }),
    ).toEqual({
      id: "message_abc",
      sessionID: "session_abc",
      jobID: "job_abc",
      role: "assistant",
      content: "Done",
      created: 1,
    })

    expect(CloudView.event(CloudEvent.status({ jobID: "job_abc", sequence: 1, status: "running", time: 1 }))).toEqual({
      id: "job_abc:000000000001",
      jobID: "job_abc",
      type: "job.status",
      data: { status: "running" },
      time: 1,
    })
  })
})
