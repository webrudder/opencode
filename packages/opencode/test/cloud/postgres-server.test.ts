import { describe, expect, test } from "bun:test"
import { CloudPostgresServer } from "../../src/cloud/postgres-server"

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

function setup(responses: Record<string, Record<string, unknown>[]>, extra?: Partial<Parameters<typeof CloudPostgresServer.create>[0]>) {
  const calls: { sql: string; params: unknown[] }[] = []
  const server = CloudPostgresServer.create({
    now: () => 100,
    serviceVersion: "postgres-local",
    client: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        return sql.startsWith("select") ? { rows: responses[sql] ?? [] } : { rowCount: 1 }
      },
    },
    ...extra,
  })
  return { calls, server }
}

describe("CloudPostgresServer", () => {
  test("serves health and OpenAPI for PostgreSQL-backed deployments", async () => {
    const subject = setup({})

    expect(await json(await subject.server.app.request("/health"))).toEqual({
      healthy: true,
      service: "cloud-opencode-runtime",
      version: "postgres-local",
      runtimeDefaultVersion: "1.14.28",
      time: 100,
    })
    expect(((await json(await subject.server.app.request("/openapi.json"))).info as Record<string, unknown>).version).toBe(
      "postgres-local",
    )
  })

  test("serves core Cloud Runtime routes backed by PostgreSQL service state", async () => {
    const subject = setup({
      "select * from cloud_workspace where tenant_id = $1 and id = $2": [
        {
          id: "workspace_1",
          tenant_id: "tenant_local",
          external_id: null,
          name: "Acme",
          time_created: 100,
          time_updated: 100,
        },
      ],
      "select * from cloud_session where tenant_id = $1 and id = $2": [
        {
          id: "session_1",
          tenant_id: "tenant_local",
          workspace_id: "workspace_1",
          user_id: "user_local",
          title: "Untitled",
          model: null,
          summary: null,
          time_created: 100,
          time_updated: 100,
        },
      ],
      "select * from cloud_file where tenant_id = $1 and ($2::text is null or workspace_id = $3) and ($4::text is null or session_id = $5) and ($6::text is null or id > $7) order by time_created, id limit $8":
        [
          {
            id: "file_1",
            tenant_id: "tenant_local",
            workspace_id: "workspace_1",
            session_id: "session_1",
            name: "input.csv",
            mime: undefined,
            size: 8,
            object_key: "tenant_local/workspace_1/session_1/files/upload/input.csv",
            sha256: undefined,
            time_created: 100,
            time_updated: 100,
          },
        ],
      "select * from cloud_job where tenant_id = $1 and id = $2": [
        {
          id: "job_1",
          tenant_id: "tenant_local",
          workspace_id: "workspace_1",
          session_id: "session_1",
          status: "queued",
          runtime: { engine: "opencode", version: "1.14.28", profile: "standard" },
          cost: {
            estimatedUSD: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
          error: null,
          time_created: 100,
          time_updated: 100,
        },
      ],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [
        {
          id: "job_1:000000000001",
          job_id: "job_1",
          sequence: 1,
          type: "job.status",
          data: { status: "queued" },
          time_created: 100,
        },
      ],
      "select * from cloud_artifact where tenant_id = $1 and ($2::text is null or job_id = $3) and ($4::text is null or id > $5) order by time_created, id limit $6": [
        {
          id: "artifact_1",
          tenant_id: "tenant_local",
          workspace_id: "workspace_1",
          session_id: "session_1",
          job_id: "job_1",
          name: "report.md",
          kind: "md",
          mime: "text/markdown",
          size: 123,
          object_key: "tenant_local/job_1/report.md",
          sha256: undefined,
          time_created: 100,
          time_updated: 100,
        },
      ],
      "select * from cloud_artifact where tenant_id = $1 and id = $2": [
        {
          id: "artifact_1",
          tenant_id: "tenant_local",
          workspace_id: "workspace_1",
          session_id: "session_1",
          job_id: "job_1",
          name: "report.md",
          kind: "md",
          mime: "text/markdown",
          size: 123,
          object_key: "tenant_local/job_1/report.md",
          sha256: undefined,
          time_created: 100,
          time_updated: 100,
        },
      ],
      "select * from cloud_webhook_subscription where tenant_id = $1 order by time_created, id": [
        {
          id: "webhook_1",
          tenant_id: "tenant_local",
          url: "https://saas.example.com/hooks/runtime",
          secret_ref: "secret/webhook/webhook_1",
          events: ["job.status"],
          enabled: true,
          time_created: 100,
          time_updated: 100,
        },
      ],
      "select * from cloud_webhook_subscription where tenant_id = $1 and id = $2": [
        {
          id: "webhook_1",
          tenant_id: "tenant_local",
          url: "https://saas.example.com/hooks/runtime",
          secret_ref: "secret/webhook/webhook_1",
          events: ["job.status"],
          enabled: true,
          time_created: 100,
          time_updated: 100,
        },
      ],
    })

    const workspace = await json(
      await subject.server.app.request("/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme" }),
      }),
    )
    const session = await json(
      await subject.server.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceID: workspace.id, userID: "user_local" }),
      }),
    )
    const file = await json(
      await subject.server.app.request("/v1/files", {
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
      await subject.server.app.request("/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionID: session.id,
          prompt: "Analyze from Postgres API",
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

    expect(workspace).toEqual({ id: "workspace_1", name: "Acme", created: 100, updated: 100 })
    expect(session).toMatchObject({ id: "session_1", workspaceID: "workspace_1", userID: "user_local" })
    expect(file).toMatchObject({ id: "file_1", workspaceID: "workspace_1", sessionID: "session_1", size: 8 })
    expect(await (await subject.server.app.request("/v1/files?workspaceID=workspace_1&sessionID=session_1")).json()).toEqual([
      {
        id: "file_1",
        workspaceID: "workspace_1",
        sessionID: "session_1",
        name: "input.csv",
        size: 8,
        created: 100,
      },
    ])
    expect(job).toEqual({ id: "job_1", status: "queued", sessionID: "session_1", runtimeVersion: "1.14.28" })
    expect(await json(await subject.server.app.request("/v1/jobs/job_1"))).toEqual(job)
    expect(await (await subject.server.app.request("/v1/jobs/job_1/events")).json()).toEqual([
      {
        id: "job_1:000000000001",
        jobID: "job_1",
        type: "job.status",
        data: { status: "queued" },
        time: 100,
      },
    ])
    expect(await json(await subject.server.app.request("/v1/jobs/job_1/cancel", { method: "POST" }))).toEqual({
      id: "job_1",
      status: "canceled",
      sessionID: "session_1",
      runtimeVersion: "1.14.28",
    })
    expect(await (await subject.server.app.request("/v1/artifacts?jobID=job_1")).json()).toEqual([
      {
        id: "artifact_1",
        jobID: "job_1",
        name: "report.md",
        kind: "md",
        mime: "text/markdown",
        size: 123,
        created: 100,
      },
    ])
    expect(await json(await subject.server.app.request("/v1/artifacts/artifact_1/download"))).toEqual({
      artifactID: "artifact_1",
      url: "http://localhost:9000/runtime-artifacts/tenant_local/job_1/report.md?expires=900100",
      expiresAt: 900100,
    })
    expect(
      await json(
        await subject.server.app.request("/v1/webhooks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://saas.example.com/hooks/runtime",
            events: ["job.status"],
            secret: "secret_abc",
          }),
        }),
      ),
    ).toEqual({
      id: "webhook_1",
      url: "https://saas.example.com/hooks/runtime",
      events: ["job.status"],
      enabled: true,
      created: 100,
    })
    expect(await (await subject.server.app.request("/v1/webhooks")).json()).toEqual([
      {
        id: "webhook_1",
        url: "https://saas.example.com/hooks/runtime",
        events: ["job.status"],
        enabled: true,
        created: 100,
      },
    ])
    expect(
      await json(
        await subject.server.app.request("/v1/webhooks/webhook_1", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        }),
      ),
    ).toMatchObject({ id: "webhook_1", enabled: false })
    expect(await json(await subject.server.app.request("/v1/webhooks/webhook_1", { method: "DELETE" }))).toMatchObject({
      id: "webhook_1",
    })
    expect(subject.calls.map((call) => call.sql)).toContain("insert into cloud_job (id, tenant_id, workspace_id, session_id, status, execution_mode, runtime, job_spec, cost, error, time_created, time_updated) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)")
  })

  test("enqueues created jobs through the PostgreSQL queue client", async () => {
    const subject = setup({
      "select * from cloud_session where tenant_id = $1 and id = $2": [
        {
          id: "session_1",
          tenant_id: "tenant_local",
          workspace_id: "workspace_1",
          user_id: "user_local",
          title: "Untitled",
          model: null,
          summary: null,
          time_created: 100,
          time_updated: 100,
        },
      ],
    })

    expect(
      await json(
        await subject.server.app.request("/v1/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionID: "session_1",
            prompt: "Analyze from Postgres queue",
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
    expect(subject.calls.find((call) => call.sql.startsWith("insert into cloud_queue_message"))?.params).toEqual([
      "cloud-runtime:standard:tenant_local",
      "tenant_local",
      "job_1",
      100,
      0,
      1,
      100,
      100,
    ])
  })

  test("cancels queued jobs through the PostgreSQL queue client", async () => {
    const subject = setup({
      "select * from cloud_job where tenant_id = $1 and id = $2": [
        {
          id: "job_1",
          tenant_id: "tenant_local",
          workspace_id: "workspace_1",
          session_id: "session_1",
          status: "queued",
          runtime: { engine: "opencode", version: "1.14.28", profile: "standard" },
          cost: {
            estimatedUSD: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
          error: null,
          time_created: 100,
          time_updated: 100,
        },
      ],
      "select * from cloud_job_event where job_id = $1 and id > $2 order by sequence, id limit $3": [],
    })

    expect(await json(await subject.server.app.request("/v1/jobs/job_1/cancel", { method: "POST" }))).toEqual({
      id: "job_1",
      status: "canceled",
      sessionID: "session_1",
      runtimeVersion: "1.14.28",
    })
    expect(subject.calls.find((call) => call.sql.startsWith("update cloud_queue_message set"))?.params).toEqual([
      "tenant_local",
      "job_1",
      100,
    ])
  })

  test("stages files and signs artifact downloads through S3-compatible storage", async () => {
    const storage: Array<{ action: string; input: Record<string, unknown> }> = []
    const subject = setup(
      {
        "select * from cloud_workspace where tenant_id = $1 and id = $2": [
          {
            id: "workspace_1",
            tenant_id: "tenant_local",
            external_id: null,
            name: "Acme",
            time_created: 100,
            time_updated: 100,
          },
        ],
        "select * from cloud_session where tenant_id = $1 and id = $2": [
          {
            id: "session_1",
            tenant_id: "tenant_local",
            workspace_id: "workspace_1",
            user_id: "user_local",
            title: "Untitled",
            model: null,
            summary: null,
            time_created: 100,
            time_updated: 100,
          },
        ],
        "select * from cloud_artifact where tenant_id = $1 and id = $2": [
          {
            id: "artifact_1",
            tenant_id: "tenant_local",
            workspace_id: "workspace_1",
            session_id: "session_1",
            job_id: "job_1",
            name: "report.md",
            kind: "md",
            mime: "text/markdown",
            size: 123,
            object_key: "tenant_local/job_1/report.md",
            sha256: undefined,
            time_created: 100,
            time_updated: 100,
          },
        ],
      },
      {
        bucket: "runtime-artifacts",
        storageClient: {
          putObject: async (input) => {
            storage.push({ action: "put", input })
            return { etag: "etag_file" }
          },
          signDownload: async (input) => {
            storage.push({ action: "sign", input })
            return `https://storage.example.com/${input.bucket}/${input.objectKey}?expires=${input.expiresAt}`
          },
        },
      },
    )

    expect(
      await json(
        await subject.server.app.request("/v1/files", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspaceID: "workspace_1",
            sessionID: "session_1",
            name: "input.csv",
            mime: "text/csv",
            contentBase64: Buffer.from("a,b\n1,2\n").toString("base64"),
          }),
        }),
      ),
    ).toMatchObject({ id: "file_1", size: 8 })
    expect(await json(await subject.server.app.request("/v1/artifacts/artifact_1/download"))).toEqual({
      artifactID: "artifact_1",
      url: "https://storage.example.com/runtime-artifacts/tenant_local/job_1/report.md?expires=900100",
      expiresAt: 900100,
    })
    expect(storage).toEqual([
      {
        action: "put",
        input: {
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
        },
      },
      {
        action: "sign",
        input: {
          bucket: "runtime-artifacts",
          objectKey: "tenant_local/job_1/report.md",
          expiresAt: 900100,
        },
      },
    ])
  })
})
