import { describe, expect, test } from "bun:test"
import { CloudRuntime } from "../../src/cloud/runtime"
import { CloudSharedRuntimeClient } from "../../src/cloud/shared-runtime-client"
import { CloudWorker } from "../../src/cloud/worker"

const launch = CloudWorker.launchPlan(
  CloudRuntime.decodeJobSpec({
    id: "job_abc",
    tenantID: "tenant_abc",
    workspaceID: "workspace_abc",
    sessionID: "session_abc",
    runtime: {
      engine: "opencode",
      version: "1.14.28",
      image: "cloud-runtime-opencode:1.14.28",
      profile: "standard",
    },
    model: { provider: "anthropic", model: "claude-sonnet-4-5" },
    tools: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false }, mcp: {}, skills: [] },
    permissions: { filesystem: "workspace_only", shell: "restricted", network: ["storage.internal"] },
    inputs: [],
    outputs: ["md"],
  }),
  { workdir: "/runtime/sessions/session_abc/jobs/job_abc", prompt: "Analyze" },
)

describe("CloudSharedRuntimeClient", () => {
  test("posts a shared-session job to a runtime worker endpoint", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const client = CloudSharedRuntimeClient.create({
      fetch: async (request, init) => {
        calls.push({ url: `${request}`, init })
        return new Response(
          JSON.stringify({
            status: "succeeded",
            manifest: { version: 1, jobID: "job_abc", artifacts: [] },
            sizeByPath: {},
          }),
          { status: 200 },
        )
      },
    })

    expect(await client.runJob({ endpoint: "http://runtime.internal/", runtimeID: "runtime_abc", jobID: "job_abc", launch })).toEqual({
      status: "succeeded",
      manifest: { version: 1, jobID: "job_abc", artifacts: [] },
      sizeByPath: {},
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://runtime.internal/v1/runtime/jobs")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json" })
    expect(JSON.parse(`${calls[0]?.init?.body}`)).toMatchObject({
      runtimeID: "runtime_abc",
      jobID: "job_abc",
      launch: { command: "opencode", args: ["run", "Analyze"] },
    })
  })

  test("returns a failed runtime result for non-2xx responses", async () => {
    const client = CloudSharedRuntimeClient.create({
      fetch: async () => new Response("runtime saturated", { status: 503 }),
    })

    expect(await client.runJob({ endpoint: "http://runtime.internal", runtimeID: "runtime_abc", jobID: "job_abc", launch })).toEqual({
      status: "failed",
      message: "Shared runtime runtime_abc POST /v1/runtime/jobs failed: 503 runtime saturated",
      runtimeUnavailable: true,
    })
  })

  test("redacts launch model secrets from non-2xx runtime responses", async () => {
    const client = CloudSharedRuntimeClient.create({
      fetch: async () => new Response("upstream saw OPENAI_API_KEY=sk-user-secret", { status: 500 }),
    })
    const result = await client.runJob({
      endpoint: "http://runtime.internal",
      runtimeID: "runtime_abc",
      jobID: "job_abc",
      launch: {
        ...launch,
        env: {
          ...launch.env,
          OPENAI_API_KEY: "sk-user-secret",
        },
      },
    })

    expect(result).toEqual({
      status: "failed",
      message: "Shared runtime runtime_abc POST /v1/runtime/jobs failed: 500 upstream saw OPENAI_API_KEY=[redacted]",
      runtimeUnavailable: true,
    })
    expect(JSON.stringify(result)).not.toContain("sk-user-secret")
  })

  test("returns a runtime unavailable failure when the runtime endpoint cannot be reached", async () => {
    const client = CloudSharedRuntimeClient.create({
      fetch: async () => {
        throw new Error("connection refused")
      },
    })

    expect(await client.runJob({ endpoint: "http://runtime.internal", runtimeID: "runtime_abc", jobID: "job_abc", launch })).toEqual({
      status: "failed",
      message: "Shared runtime runtime_abc POST /v1/runtime/jobs failed: 503 connection refused",
      runtimeUnavailable: true,
    })
  })
})
