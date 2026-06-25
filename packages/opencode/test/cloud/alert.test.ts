import { describe, expect, test } from "bun:test"
import { CloudAlert } from "../../src/cloud/alert"

describe("CloudAlert", () => {
  test("raises operational alerts from cloud runtime signals", () => {
    expect(
      CloudAlert.evaluate({
        now: 1000,
        queue: { depth: 120, oldestQueuedAgeMS: 400_000 },
        jobs: { failureRate: 0.08, runtimeVersion: "1.14.28" },
        sandbox: { startP95MS: 90_000, runtimeVersion: "1.14.28" },
        workers: { lastHeartbeatAgeMS: 180_000 },
        tenantBudget: { tenantID: "tenant_abc", usedUSD: 95, limitUSD: 100 },
      }).map((item) => [item.id, item.severity, item.runtimeVersion, item.tenantID]),
    ).toEqual([
      ["cloud.queue.backlog", "warning", undefined, undefined],
      ["cloud.job.failure_rate", "warning", "1.14.28", undefined],
      ["cloud.sandbox.start_latency", "warning", "1.14.28", undefined],
      ["cloud.worker.heartbeat_stale", "critical", undefined, undefined],
      ["cloud.tenant.budget_exhaustion", "critical", undefined, "tenant_abc"],
    ])
  })

  test("stays quiet when signals are below thresholds", () => {
    expect(
      CloudAlert.evaluate({
        now: 1000,
        queue: { depth: 99, oldestQueuedAgeMS: 400_000 },
        jobs: { failureRate: 0.01 },
        sandbox: { startP95MS: 10_000 },
        workers: { lastHeartbeatAgeMS: 10_000 },
        tenantBudget: { tenantID: "tenant_abc", usedUSD: 10, limitUSD: 100 },
      }),
    ).toEqual([])
  })

  test("uses custom thresholds for tenant-specific alert tuning", () => {
    expect(
      CloudAlert.evaluate({
        now: 1000,
        thresholds: { queueDepthWarning: 5, oldestQueuedAgeWarningMS: 1_000 },
        queue: { depth: 6, oldestQueuedAgeMS: 2_000 },
      }),
    ).toMatchObject([{ id: "cloud.queue.backlog", value: 2000, threshold: 1000 }])
  })
})
