import { describe, expect, test } from "bun:test"
import { CloudRuntimeExecutor } from "../../src/cloud/runtime-executor"

describe("CloudRuntimeExecutor", () => {
  test("defaults deployments to the shared session pool mode", () => {
    expect(CloudRuntimeExecutor.mode({})).toBe("shared_session_pool")
  })

  test("accepts explicit supported deployment modes", () => {
    expect(CloudRuntimeExecutor.mode({ CLOUD_RUNTIME_DEPLOYMENT_MODE: "isolated_job_runtime" })).toBe("isolated_job_runtime")
    expect(CloudRuntimeExecutor.mode({ CLOUD_RUNTIME_DEPLOYMENT_MODE: "local_dev" })).toBe("local_dev")
  })

  test("rejects unknown deployment modes before scheduling work", () => {
    expect(() => CloudRuntimeExecutor.mode({ CLOUD_RUNTIME_DEPLOYMENT_MODE: "unknown" })).toThrow("Unsupported cloud runtime deployment mode")
  })
})
