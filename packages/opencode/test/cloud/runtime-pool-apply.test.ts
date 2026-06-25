import { describe, expect, test } from "bun:test"
import { CloudRuntimePoolApply } from "../../src/cloud/runtime-pool-apply"

const env = {
  CLOUD_RUNTIME_CONFIRM_APPLY_PLAN: "1",
  CLOUD_RUNTIME_API_BASE_URL: "https://runtime.example.com",
  CLOUD_RUNTIME_API_KEY: "key_abc",
  CLOUD_RUNTIME_POOL_SCALE_TARGET: "kubernetes",
  CLOUD_RUNTIME_CURRENT_RUNTIMES: "1",
  CLOUD_RUNTIME_NAMESPACE: "runtime",
  CLOUD_RUNTIME_WORKER_DEPLOYMENT_NAME: "runtime-worker",
}

describe("CloudRuntimePoolApply", () => {
  test("requires confirmation before applying runtime pool plans", async () => {
    const result = await CloudRuntimePoolApply.runCLI({
      env: {
        CLOUD_RUNTIME_API_BASE_URL: "https://runtime.example.com",
      },
      fetch: async () => {
        throw new Error("should not call API")
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1")
  })

  test("calls apply-plan and executes returned Kubernetes scale operations", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = []
    const kubernetesCalls: string[] = []
    const result = await CloudRuntimePoolApply.runCLI({
      env,
      fetch: async (request) => {
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: await request.json(),
        })
        return Response.json({
          desiredRuntimes: 3,
          action: "scale_up",
          reason: "capacity_exhausted",
          drainedRuntimeIDs: ["runtime_old"],
          releasedSessionIDs: ["session_old"],
          scaleOperations: [
            {
              action: "scale",
              target: "kubernetes",
              desiredRuntimes: 3,
              currentRuntimes: 1,
              namespace: "runtime",
              deploymentName: "runtime-worker",
            },
          ],
        })
      },
      kubernetes: {
        applyNetworkPolicy: async (input) => ({ name: input.name }),
        createPod: async (input) => ({ name: input.name }),
        watchPod: async () => ({}),
        logs: async () => ({ text: "" }),
        deletePod: async (input) => ({ name: input.name }),
        deleteNetworkPolicy: async (input) => ({ name: input.name }),
        patchDeploymentScale: async (input) => {
          kubernetesCalls.push(`${input.namespace}:${input.name}:${input.replicas}`)
          return { name: input.name, replicas: input.replicas }
        },
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime apply-plan: passed")
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/admin/runtime-pools/apply-plan",
        body: {
          target: "kubernetes",
          currentRuntimes: 1,
          namespace: "runtime",
          deploymentName: "runtime-worker",
        },
      },
    ])
    expect(kubernetesCalls).toEqual(["runtime:runtime-worker:3"])
  })

  test("renders JSON evidence for apply-plan runs", async () => {
    const result = await CloudRuntimePoolApply.runCLI({
      env,
      json: true,
      fetch: async () =>
        Response.json({
          desiredRuntimes: 1,
          action: "hold",
          reason: "steady",
          drainedRuntimeIDs: [],
          releasedSessionIDs: [],
          scaleOperations: [],
        }),
      kubernetes: {
        applyNetworkPolicy: async (input) => ({ name: input.name }),
        createPod: async (input) => ({ name: input.name }),
        watchPod: async () => ({}),
        logs: async () => ({ text: "" }),
        deletePod: async (input) => ({ name: input.name }),
        deleteNetworkPolicy: async (input) => ({ name: input.name }),
        patchDeploymentScale: async (input) => ({ name: input.name, replicas: input.replicas }),
      },
    })
    const evidence = JSON.parse(result.output) as { status: string; applyPlan: { action: string } }

    expect(result.exitCode).toBe(0)
    expect(evidence.status).toBe("passed")
    expect(evidence.applyPlan.action).toBe("hold")
  })
})
