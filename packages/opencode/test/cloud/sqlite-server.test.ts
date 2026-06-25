import { describe, expect, test } from "bun:test"
import { CloudAPIKey } from "../../src/cloud/api-key"
import { CloudLocalWorker } from "../../src/cloud/local-worker"
import { CloudSQLiteServer } from "../../src/cloud/sqlite-server"
import { CloudSQLiteWorkerLoop } from "../../src/cloud/sqlite-worker-loop"

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

async function events(response: Response) {
  return (await response.json()) as { type: string; data: { status?: string } }[]
}

async function artifacts(response: Response) {
  return (await response.json()) as { id: string; jobID: string; name: string; kind: string }[]
}

async function files(response: Response) {
  return (await response.json()) as { id: string; workspaceID: string; sessionID?: string; name: string; size: number; created: number }[]
}

describe("CloudSQLiteServer", () => {
  test("serves Cloud Runtime API routes backed by SQLite state", async () => {
    const server = CloudSQLiteServer.create({ now: () => 100, serviceVersion: "sqlite-local" })

    expect(await json(await server.app.request("/health"))).toEqual({
      healthy: true,
      service: "cloud-opencode-runtime",
      version: "sqlite-local",
      runtimeDefaultVersion: "1.14.28",
      time: 100,
    })

    const workspace = await json(
      await server.app.request("/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme" }),
      }),
    )
    const session = await json(
      await server.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceID: workspace.id, userID: "user_local" }),
      }),
    )
    const file = await json(
      await server.app.request("/v1/files", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceID: workspace.id,
          sessionID: session.id,
          name: "input.csv",
          contentBase64: Buffer.from("a,b\n1,2\n").toString("base64"),
        }),
      }),
    )
    const job = await json(
      await server.app.request("/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionID: session.id,
          prompt: "Analyze from SQLite API",
          inputs: [],
          outputs: ["md"],
          runtime: { profile: "standard" },
          tools: {
            webfetch: { enabled: false, allowDomains: [] },
            websearch: { enabled: false },
            mcp: [],
            skills: [],
          },
        }),
      }),
    )

    expect(job).toMatchObject({ id: "job_1", status: "queued", sessionID: "session_1" })
    expect(await files(await server.app.request(`/v1/files?workspaceID=${workspace.id}&sessionID=${session.id}`))).toEqual([
      {
        id: String(file.id),
        workspaceID: String(workspace.id),
        sessionID: String(session.id),
        name: "input.csv",
        size: 8,
        created: 100,
      },
    ])
    expect(await json(await server.app.request(`/v1/jobs/${job.id}`))).toMatchObject({
      id: "job_1",
      status: "queued",
      sessionID: "session_1",
    })
    expect(
      CloudSQLiteWorkerLoop.tick({
        db: server.db,
        tenantID: "tenant_local",
        workerID: "worker_local",
        leaseTTLMS: 1000,
        now: () => 200,
        sandboxRoot: "/sandbox",
        bucket: "runtime",
        namespace: "cloud-runtime",
      }),
    ).toMatchObject({
      status: "started",
      jobID: "job_1",
      launch: { args: ["run", "Analyze from SQLite API"] },
    })
  })

  test("serves an OpenAPI document for SQLite-backed deployments", async () => {
    const response = await CloudSQLiteServer.create({ serviceVersion: "sqlite-local" }).app.request("/openapi.json")
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body.info).toEqual({ title: "Cloud OpenCode Runtime API", version: "sqlite-local" })
    expect(Object.keys(body.paths as Record<string, unknown>)).toContain("/v1/artifacts/{id}/download")
    expect(Object.keys(body.paths as Record<string, unknown>)).toContain("/v1/tools")
  })

  test("serves CORS preflight for configured SQLite-backed SaaS origins", async () => {
    const server = CloudSQLiteServer.create({ corsOrigins: ["https://saas.example.com"] })
    const response = await server.app.request("/v1/jobs", {
      method: "OPTIONS",
      headers: {
        origin: "https://saas.example.com",
        "access-control-request-method": "POST",
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("https://saas.example.com")
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, PATCH, DELETE, OPTIONS")
  })

  test("returns request IDs on SQLite-backed API responses", async () => {
    const server = CloudSQLiteServer.create({ requestID: () => "req_generated" })
    const generated = await server.app.request("/health")
    const existing = await server.app.request("/health", { headers: { "x-request-id": "req_client" } })

    expect(generated.headers.get("x-request-id")).toBe("req_generated")
    expect(existing.headers.get("x-request-id")).toBe("req_client")
  })

  test("can protect SQLite-backed routes with issued API keys", async () => {
    const key = CloudAPIKey.issue({
      id: "key_local",
      tenantID: "tenant_local",
      prefix: "ocrt",
      secret: "secret",
      now: 100,
    })
    const server = CloudSQLiteServer.create({ now: () => 100, apiKeys: [key.record] })
    const unauthorized = await server.app.request("/v1/tools")

    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Cloud API key is missing or invalid",
      },
    })
    expect(
      (
        await server.app.request("/v1/tools", {
          headers: { authorization: `Bearer ${key.key}` },
        })
      ).status,
    ).toBe(200)
  })

  test("can back file upload and artifact download with S3-compatible storage", async () => {
    const calls: unknown[] = []
    const server = CloudSQLiteServer.create({
      now: () => 100,
      bucket: "runtime-artifacts",
      storageClient: {
        putObject: async (input) => {
          calls.push(input)
          return { etag: "etag_abc" }
        },
        signDownload: async (input) => {
          calls.push(input)
          return `https://storage.example.com/${input.bucket}/${input.objectKey}?expires=${input.expiresAt}`
        },
      },
    })
    const workspace = await json(
      await server.app.request("/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "S3 SaaS" }),
      }),
    )
    const session = await json(
      await server.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceID: workspace.id, userID: "user_local" }),
      }),
    )
    const file = await json(
      await server.app.request("/v1/files", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceID: workspace.id,
          sessionID: session.id,
          name: "input.csv",
          mime: "text/csv",
          contentBase64: Buffer.from("a,b\n1,2\n").toString("base64"),
        }),
      }),
    )
    await server.app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: session.id,
        prompt: "Create report",
        inputs: [file.id],
        outputs: ["md"],
        runtime: { profile: "standard" },
        tools: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false },
          mcp: [],
          skills: [],
        },
      }),
    })

    server.db
      .query(
        `insert into cloud_artifact (
          id, tenant_id, workspace_id, session_id, job_id, name, kind, mime, size, object_key, sha256, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "artifact_1",
        "tenant_local",
        String(workspace.id),
        String(session.id),
        "job_1",
        "report.md",
        "md",
        "text/markdown",
        12,
        "tenant_local/workspace_1/session_1/jobs/job_1/artifacts/artifact_1/report.md",
        null,
        100,
        100,
      )

    expect(file).toMatchObject({
      id: "file_1",
      size: 8,
    })
    expect(calls[0]).toEqual({
      bucket: "runtime-artifacts",
      objectKey: "tenant_local/workspace_1/session_1/files/file_1/input.csv",
      body: new Uint8Array(Buffer.from("a,b\n1,2\n")),
      contentType: "text/csv",
      contentLength: 8,
      metadata: {
        "tenant-id": "tenant_local",
        "workspace-id": "workspace_1",
        "session-id": "session_1",
      },
    })
    expect(await json(await server.app.request("/v1/artifacts/artifact_1/download"))).toEqual({
      artifactID: "artifact_1",
      url: "https://storage.example.com/runtime-artifacts/tenant_local/workspace_1/session_1/jobs/job_1/artifacts/artifact_1/report.md?expires=900100",
      expiresAt: 900100,
    })
    expect(calls[1]).toEqual({
      bucket: "runtime-artifacts",
      objectKey: "tenant_local/workspace_1/session_1/jobs/job_1/artifacts/artifact_1/report.md",
      expiresAt: 900100,
    })
  })

  test("can enqueue created jobs through a queue client", async () => {
    const calls: unknown[] = []
    const server = CloudSQLiteServer.create({
      now: () => 100,
      queueClient: {
        enqueue: async (input) => {
          calls.push(input)
          return { messageID: `${input.queue}:${input.jobID}` }
        },
      },
    })
    const workspace = await json(
      await server.app.request("/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Queue SaaS" }),
      }),
    )
    const session = await json(
      await server.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceID: workspace.id, userID: "user_local" }),
      }),
    )

    expect(
      await json(
        await server.app.request("/v1/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionID: session.id,
            prompt: "Queue me",
            inputs: [],
            outputs: ["md"],
            runtime: { profile: "standard" },
            tools: {
              webfetch: { enabled: false, allowDomains: [] },
              websearch: { enabled: false },
              mcp: [],
              skills: [],
            },
          }),
        }),
      ),
    ).toMatchObject({ id: "job_1", status: "queued" })
    expect(calls).toEqual([
      {
        queue: "cloud-runtime:standard:tenant_local",
        tenantID: "tenant_local",
        jobID: "job_1",
        runAt: 100,
        priority: 0,
      },
    ])
  })

  test("can cancel a queued SQLite-backed job through the API", async () => {
    const server = CloudSQLiteServer.create({ now: () => 100 })
    const workspace = await json(
      await server.app.request("/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Cancel" }),
      }),
    )
    const session = await json(
      await server.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceID: workspace.id, userID: "user_local" }),
      }),
    )
    const job = await json(
      await server.app.request("/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionID: session.id,
          prompt: "Cancel me",
          inputs: [],
          outputs: ["md"],
          runtime: { profile: "standard" },
          tools: {
            webfetch: { enabled: false, allowDomains: [] },
            websearch: { enabled: false },
            mcp: [],
            skills: [],
          },
        }),
      }),
    )
    const jobID = String(job.id)

    expect(await json(await server.app.request(`/v1/jobs/${jobID}/cancel`, { method: "POST" }))).toMatchObject({
      id: jobID,
      status: "canceled",
    })
    expect(server.db.query("select status from cloud_job where id = ?").get(jobID)).toEqual({ status: "canceled" })
    expect(
      (await events(await server.app.request(`/v1/jobs/${jobID}/events`)))
        .filter((event) => event.type === "job.status")
        .map((event) => event.data.status),
    ).toEqual(["queued", "canceled"])
  })

  test("can cancel queued SQLite-backed jobs through a queue client", async () => {
    const calls: unknown[] = []
    const server = CloudSQLiteServer.create({
      now: () => 100,
      queueClient: {
        enqueue: async () => ({ messageID: "message_1" }),
        cancel: async (input) => {
          calls.push(input)
          return { canceled: true }
        },
      },
    })
    const workspace = await json(
      await server.app.request("/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Cancel Queue" }),
      }),
    )
    const session = await json(
      await server.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceID: workspace.id, userID: "user_local" }),
      }),
    )
    const job = await json(
      await server.app.request("/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionID: session.id,
          prompt: "Cancel queue me",
          inputs: [],
          outputs: ["md"],
          runtime: { profile: "standard" },
          tools: {
            webfetch: { enabled: false, allowDomains: [] },
            websearch: { enabled: false },
            mcp: [],
            skills: [],
          },
        }),
      }),
    )

    expect(await json(await server.app.request(`/v1/jobs/${String(job.id)}/cancel`, { method: "POST" }))).toMatchObject({
      id: job.id,
      status: "canceled",
    })
    expect(calls).toEqual([
      {
        tenantID: "tenant_local",
        jobID: job.id,
        requestedBy: "api",
        time: 100,
      },
    ])
  })

  test("supports an API to local worker to artifact loop with SQLite state", async () => {
    const server = CloudSQLiteServer.create({ now: () => 100, serviceVersion: "sqlite-local" })
    const workspace = await json(
      await server.app.request("/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Local SaaS" }),
      }),
    )
    const session = await json(
      await server.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceID: workspace.id, userID: "user_local" }),
      }),
    )
    const job = await json(
      await server.app.request("/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionID: session.id,
          prompt: "Produce a local artifact",
          inputs: [],
          outputs: ["md"],
          runtime: { profile: "standard" },
          tools: {
            webfetch: { enabled: false, allowDomains: [] },
            websearch: { enabled: false },
            mcp: [],
            skills: [],
          },
        }),
      }),
    )

    expect(
      await CloudLocalWorker.runOnce({
        db: server.db,
        tenantID: "tenant_local",
        workerID: "worker_local",
        leaseTTLMS: 1000,
        now: () => 200,
        sandboxRoot: "/sandbox",
        bucket: "runtime-artifacts",
        namespace: "cloud-runtime",
        executionMode: "simulate",
      }),
    ).toMatchObject({ status: "completed", jobID: job.id })

    expect(
      (await events(await server.app.request(`/v1/jobs/${job.id}/events`)))
        .filter((event) => event.type === "job.status")
        .map((event) => event.data.status),
    ).toEqual(["queued", "leasing", "starting", "running", "uploading", "succeeded"])
    const list = await artifacts(await server.app.request(`/v1/artifacts?jobID=${job.id}`))
    expect(list).toMatchObject([{ jobID: job.id, name: "summary.md", kind: "md" }])
    expect(await json(await server.app.request(`/v1/artifacts/${list[0].id}/download`))).toMatchObject({
      artifactID: list[0].id,
      url: `http://localhost:9000/runtime-artifacts/tenant_local/${job.id}/artifacts/summary.md?expires=900100`,
      expiresAt: 900100,
    })
  })
})
