import { describe, expect, test } from "bun:test"
import { CloudAPI } from "../../src/cloud/api"

describe("CloudAPI", () => {
  test("decodes workspace and session creation requests", () => {
    expect(
      CloudAPI.decodeCreateWorkspaceRequest({
        externalID: "saas-workspace-1",
        name: "Acme Workspace",
      }),
    ).toEqual({
      externalID: "saas-workspace-1",
      name: "Acme Workspace",
    })

    expect(
      CloudAPI.decodeCreateSessionRequest({
        workspaceID: "workspace_abc",
        userID: "user_abc",
        title: "Analysis",
        model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      }).model,
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" })
  })

  test("decodes file upload requests with either inline content or source url", () => {
    expect(
      CloudAPI.decodeCreateFileRequest({
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        name: "input.json",
        mime: "application/json",
        contentBase64: Buffer.from("{}").toString("base64"),
      }).contentBase64,
    ).toBe("e30=")

    expect(
      CloudAPI.decodeCreateFileRequest({
        workspaceID: "workspace_abc",
        name: "remote.csv",
        sourceURL: "https://storage.example.com/input.csv",
      }).sourceURL,
    ).toBe("https://storage.example.com/input.csv")
  })

  test("requires file upload requests to include exactly one content source", () => {
    expect(() =>
      CloudAPI.decodeCreateFileRequest({
        workspaceID: "workspace_abc",
        name: "empty.txt",
      }),
    ).toThrow("expected exactly one")

    expect(() =>
      CloudAPI.decodeCreateFileRequest({
        workspaceID: "workspace_abc",
        name: "ambiguous.txt",
        contentBase64: "aGVsbG8=",
        sourceURL: "https://storage.example.com/ambiguous.txt",
      }),
    ).toThrow("expected exactly one")
  })

  test("decodes job creation requests and defaults async execution", () => {
    const request = CloudAPI.decodeCreateJobRequest({
      sessionID: "session_abc",
      prompt: "Summarize the uploaded files",
      inputs: ["file_abc"],
      outputs: ["md", "pdf"],
      runtime: { profile: "standard" },
      tools: {
        webfetch: { enabled: true, allowDomains: ["docs.example.com"] },
        websearch: { enabled: false },
        mcp: ["browser"],
        skills: ["report-writer@1.0.0"],
      },
      integratorID: "integrator_abc",
    })

    expect(request.async).toBe(true)
    expect(request.outputs).toEqual(["md", "pdf"])
    expect(request.integratorID).toBe("integrator_abc")
  })

  test("decodes optional job permissions for non-interactive runtime execution", () => {
    expect(
      CloudAPI.decodeCreateJobRequest({
        sessionID: "session_abc",
        prompt: "Write files",
        inputs: [],
        outputs: ["md"],
        runtime: { profile: "standard" },
        tools: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false },
          mcp: [],
          skills: [],
        },
        permissions: {
          filesystem: "workspace_only",
          shell: "allow",
          network: ["storage.internal"],
        },
      }).permissions,
    ).toEqual({
      filesystem: "workspace_only",
      shell: "allow",
      network: ["storage.internal"],
    })
  })

  test("decodes job events and artifact download responses", () => {
    expect(
      CloudAPI.decodeJobEvent({
        id: "event_abc",
        jobID: "job_abc",
        type: "job.status",
        data: { status: "running" },
        time: 1,
      }).type,
    ).toBe("job.status")

    expect(
      CloudAPI.decodeJobEventPageResponse({
        items: [
          {
            id: "job_abc:000000000001",
            jobID: "job_abc",
            type: "job.status",
            data: { status: "running" },
            time: 1,
          },
        ],
        nextCursor: "job_abc:000000000001",
        hasMore: true,
      }).hasMore,
    ).toBe(true)

    expect(
      CloudAPI.decodeArtifactDownloadResponse({
        artifactID: "artifact_abc",
        url: "https://storage.example.com/download",
        expiresAt: 10,
      }).expiresAt,
    ).toBe(10)
  })

  test("decodes paginated file and artifact responses", () => {
    expect(
      CloudAPI.decodeFilePageResponse({
        items: [{ id: "file_abc", workspaceID: "workspace_abc", name: "input.csv", size: 1, created: 1 }],
        nextCursor: "file_abc",
        hasMore: false,
      }).items[0].id,
    ).toBe("file_abc")

    expect(
      CloudAPI.decodeArtifactPageResponse({
        items: [{ id: "artifact_abc", jobID: "job_abc", name: "summary.md", kind: "md", size: 1, created: 1 }],
        nextCursor: "artifact_abc",
        hasMore: false,
      }).items[0].id,
    ).toBe("artifact_abc")
  })

  test("decodes stable error responses", () => {
    expect(
      CloudAPI.decodeErrorResponse({
        error: {
          code: "not_found",
          message: "Cloud job not found",
        },
      }),
    ).toEqual({
      error: {
        code: "not_found",
        message: "Cloud job not found",
      },
    })
  })

  test("decodes webhook subscription requests and responses", () => {
    expect(
      CloudAPI.decodeCreateWebhookRequest({
        url: "https://saas.example.com/hooks/runtime",
        events: ["job.status", "job.artifact"],
        secret: "secret_abc",
      }),
    ).toEqual({
      url: "https://saas.example.com/hooks/runtime",
      events: ["job.status", "job.artifact"],
      secret: "secret_abc",
      enabled: true,
    })
    expect(
      CloudAPI.decodeWebhookResponse({
        id: "webhook_abc",
        url: "https://saas.example.com/hooks/runtime",
        events: ["job.status"],
        enabled: true,
        created: 10,
      }),
    ).toEqual({
      id: "webhook_abc",
      url: "https://saas.example.com/hooks/runtime",
      events: ["job.status"],
      enabled: true,
      created: 10,
    })
    expect(CloudAPI.decodeUpdateWebhookRequest({ enabled: false })).toEqual({ enabled: false })
  })

  test("decodes session message requests with a user role default", () => {
    expect(
      CloudAPI.decodeCreateSessionMessageRequest({
        content: "Continue the analysis",
      }),
    ).toEqual({
      role: "user",
      content: "Continue the analysis",
    })

    expect(
      CloudAPI.decodeCreateSessionMessageRequest({
        role: "system",
        content: "Use concise answers",
      }).role,
    ).toBe("system")
  })

  test("decodes runtime worker capacity responses", () => {
    expect(
      CloudAPI.decodeRuntimeWorkerResponse({
        id: "runtime_abc",
        executionMode: "shared_session_pool",
        status: "healthy",
        version: "1.14.28",
        profile: "standard",
        maxActiveJobs: 4,
        maxSessions: 20,
        metrics: {
          activeJobs: 0,
          busySessions: 0,
          idleSessions: 1,
          cpuPercent: 10,
          memoryPercent: 20,
          diskPercent: 30,
          recentErrorRate: 0,
          heartbeatDelayMS: 100,
        },
        capacity: {
          healthy: true,
          reasons: [],
          boundSessions: 1,
          remainingJobs: 4,
          remainingSessions: 19,
          loadScore: 61.1,
        },
        updated: 10,
      }).capacity.remainingSessions,
    ).toBe(19)
  })

  test("decodes runtime pool planning responses", () => {
    expect(
      CloudAPI.decodeRuntimePoolResponse({
        runtimes: 2,
        healthy: 1,
        draining: 0,
        overloaded: 0,
        offline: 1,
        activeJobs: 4,
        busySessions: 3,
        idleSessions: 8,
        plan: {
          desiredRuntimes: 3,
          action: "scale_up",
          reason: "capacity_exhausted",
          availableJobSlots: 0,
          availableSessionSlots: 0,
          boundSessions: 20,
          saturatedRuntimes: 1,
          unavailableRuntimes: 1,
          drainRuntimeIDs: [],
          releaseSessionIDs: ["session_stale"],
        },
      }).plan.action,
    ).toBe("scale_up")
  })

  test("decodes runtime pool apply plan responses", () => {
    expect(
      CloudAPI.decodeRuntimePoolApplyPlanResponse({
        desiredRuntimes: 1,
        action: "scale_down",
        reason: "idle_capacity",
        drainedRuntimeIDs: ["runtime_idle"],
        releasedSessionIDs: ["session_stale"],
        scaleOperations: [
          {
            action: "scale",
            target: "local",
            desiredRuntimes: 1,
            currentRuntimes: 2,
          },
        ],
      }).drainedRuntimeIDs,
    ).toEqual(["runtime_idle"])
  })
})
