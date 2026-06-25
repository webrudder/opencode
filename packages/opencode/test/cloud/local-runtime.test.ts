import { describe, expect, test } from "bun:test"
import { CloudLocalRuntime } from "../../src/cloud/local-runtime"

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

describe("CloudLocalRuntime", () => {
  test("connects the local API app and worker loop through the same store", async () => {
    const runtime = CloudLocalRuntime.create({ server: { now: () => 100 } })
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
          prompt: "Analyze the local workspace",
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

    const result = runtime.tickWorker()

    expect(result).toMatchObject({
      status: "started",
      jobID: job.id,
      lease: { workerID: "local-worker-1", expiresAt: 30100 },
      launch: {
        command: "opencode",
        args: ["run", "Analyze the local workspace"],
        cwd: `/tmp/cloud-runtime/${job.id}/work`,
      },
    })
    expect(runtime.store.getJob({ tenantID: "tenant_local", id: `${job.id}` })?.status).toBe("leasing")
  })

  test("heartbeats the local worker lease", async () => {
    const runtime = CloudLocalRuntime.create({ server: { now: () => 100 } })
    runtime.store.putLease({ jobID: "job_local", workerID: "local-worker-1", expiresAt: 200, heartbeatAt: 100 })

    expect(runtime.heartbeatWorker({ jobID: "job_local" })).toEqual({
      jobID: "job_local",
      workerID: "local-worker-1",
      expiresAt: 30100,
      heartbeatAt: 100,
    })
  })
})
