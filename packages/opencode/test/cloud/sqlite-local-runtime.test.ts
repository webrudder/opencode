import { describe, expect, test } from "bun:test"
import { CloudSQLiteLocalRuntime } from "../../src/cloud/sqlite-local-runtime"

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

describe("CloudSQLiteLocalRuntime", () => {
  test("connects the SQLite API app and worker loop through the same database", async () => {
    const runtime = CloudSQLiteLocalRuntime.create({ server: { now: () => 100 } })
    const workspace = await json(
      await runtime.app.request("/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme" }),
      }),
    )
    const session = await json(
      await runtime.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceID: workspace.id, userID: "user_local" }),
      }),
    )
    const job = await json(
      await runtime.app.request("/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionID: session.id,
          prompt: "Analyze with persisted local runtime",
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

    expect(runtime.tickWorker()).toMatchObject({
      status: "started",
      jobID: job.id,
      lease: { workerID: "local-worker-1", expiresAt: 30100 },
      launch: {
        command: "opencode",
        args: ["run", "Analyze with persisted local runtime"],
        cwd: `/tmp/cloud-runtime/${job.id}/work`,
      },
    })
    expect(runtime.db.query("select status from cloud_job where id = ?").get(`${job.id}`)).toEqual({
      status: "leasing",
    })
  })

  test("heartbeats through the SQLite worker loop", () => {
    const runtime = CloudSQLiteLocalRuntime.create({ server: { now: () => 100 } })
    runtime.db
      .query(
        "insert into cloud_job (id, tenant_id, workspace_id, session_id, status, runtime, cost, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "job_local",
        "tenant_local",
        "workspace_local",
        "session_local",
        "leasing",
        JSON.stringify({ engine: "opencode", version: "1.14.28", profile: "standard" }),
        JSON.stringify({
          estimatedUSD: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        }),
        100,
        100,
      )
    runtime.db.query("insert into cloud_job_lease (job_id, worker_id, expires_at, heartbeat_at) values (?, ?, ?, ?)").run(
      "job_local",
      "local-worker-1",
      200,
      100,
    )

    expect(runtime.heartbeatWorker({ jobID: "job_local" })).toEqual({
      jobID: "job_local",
      workerID: "local-worker-1",
      expiresAt: 30100,
      heartbeatAt: 100,
    })
  })
})
