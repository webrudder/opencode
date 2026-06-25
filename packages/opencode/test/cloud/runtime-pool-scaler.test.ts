import { describe, expect, test } from "bun:test"
import { CloudRuntimePoolScaler } from "../../src/cloud/runtime-pool-scaler"

const plan = {
  desiredRuntimes: 3,
  action: "scale_up" as const,
  reason: "capacity_exhausted" as const,
  drainedRuntimeIDs: ["runtime_drain"],
  releasedSessionIDs: ["session_stale"],
}

describe("CloudRuntimePoolScaler", () => {
  test("builds provider-neutral runtime pool operations", () => {
    expect(
      CloudRuntimePoolScaler.operations({
        target: "local",
        currentRuntimes: 1,
        plan,
      }),
    ).toEqual([
      {
        action: "scale",
        target: "local",
        desiredRuntimes: 3,
        currentRuntimes: 1,
      },
      {
        action: "drain",
        target: "local",
        runtimeID: "runtime_drain",
      },
      {
        action: "release_session",
        target: "local",
        sessionID: "session_stale",
      },
    ])
  })

  test("converts Kubernetes scale operations into deployment scale patches", () => {
    expect(
      CloudRuntimePoolScaler.runnable({
        target: "kubernetes",
        namespace: "runtime",
        deploymentName: "runtime-worker",
        currentRuntimes: 1,
        plan,
      })[0],
    ).toEqual({
      action: "patch",
      resource: "deployment_scale",
      namespace: "runtime",
      name: "runtime-worker",
      patch: {
        spec: {
          replicas: 3,
        },
      },
    })
  })

  test("builds Kubernetes executor scale operations", () => {
    expect(
      CloudRuntimePoolScaler.kubernetesOperations({
        namespace: "runtime",
        deploymentName: "runtime-worker",
        currentRuntimes: 1,
        plan,
      }),
    ).toEqual([
      {
        action: "patch",
        resource: "deployment_scale",
        namespace: "runtime",
        name: "runtime-worker",
        replicas: 3,
      },
    ])
  })

  test("omits scale operations when desired runtime count already matches", () => {
    expect(
      CloudRuntimePoolScaler.operations({
        target: "local",
        currentRuntimes: 3,
        plan: {
          ...plan,
          desiredRuntimes: 3,
          drainedRuntimeIDs: [],
          releasedSessionIDs: [],
        },
      }),
    ).toEqual([])
  })
})
