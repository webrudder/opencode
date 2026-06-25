import { describe, expect, test } from "bun:test"
import { CloudStore } from "../../src/cloud/store"
import { CloudUsage } from "../../src/cloud/usage"

const time = { created: 1, updated: 1 }
const runtime = { engine: "opencode" as const, version: "1.14.28", profile: "standard" as const }

describe("CloudUsage", () => {
  test("calculates model cost from token usage and per-million pricing", () => {
    expect(
      CloudUsage.modelCost({
        tokens: { input: 1_000_000, output: 500_000, reasoning: 250_000, cacheRead: 100_000, cacheWrite: 50_000 },
        pricePerMillion: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
      }),
    ).toEqual({
      estimatedUSD: 14.43,
      tokens: { input: 1_000_000, output: 500_000, reasoning: 250_000, cacheRead: 100_000, cacheWrite: 50_000 },
    })
  })

  test("adds model, tool, and runtime costs", () => {
    expect(
      CloudUsage.totalCost([
        CloudUsage.modelCost({
          tokens: { input: 1000, output: 1000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          pricePerMillion: { input: 1, output: 2 },
        }),
        CloudUsage.fixedCost(0.25),
        CloudUsage.runtimeCost({ durationMS: 120_000, pricePerHour: 0.36 }),
      ]),
    ).toEqual({
      estimatedUSD: 0.265,
      tokens: { input: 1000, output: 1000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
  })

  test("updates a job cost inside the tenant boundary", () => {
    const store = CloudStore.create()
    store.putJob({
      id: "job_abc",
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      status: "running",
      runtime,
      cost: CloudUsage.emptyCost(),
      time,
    })

    expect(
      store.updateJobCost({
        tenantID: "tenant_abc",
        id: "job_abc",
        cost: CloudUsage.fixedCost(0.5),
        now: 10,
      }).cost,
    ).toEqual({
      estimatedUSD: 0.5,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })

    expect(() =>
      store.updateJobCost({
        tenantID: "tenant_other",
        id: "job_abc",
        cost: CloudUsage.fixedCost(1),
        now: 11,
      }),
    ).toThrow("Cloud job not found")
  })
})
