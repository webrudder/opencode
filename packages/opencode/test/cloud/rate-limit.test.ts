import { describe, expect, test } from "bun:test"
import { CloudRateLimit } from "../../src/cloud/rate-limit"

describe("CloudRateLimit", () => {
  test("allows requests inside a fixed tenant action window", () => {
    const state = CloudRateLimit.create()

    expect(
      CloudRateLimit.check({
        state,
        tenantID: "tenant_abc",
        action: "jobs.create",
        limit: 3,
        windowMS: 1_000,
        now: 10,
      }),
    ).toEqual({
      allowed: true,
      remaining: 2,
      resetAt: 1_010,
    })
    expect(
      CloudRateLimit.check({
        state,
        tenantID: "tenant_abc",
        action: "jobs.create",
        limit: 3,
        windowMS: 1_000,
        now: 20,
      }).remaining,
    ).toBe(1)
  })

  test("isolates tenants and actions", () => {
    const state = CloudRateLimit.create()
    CloudRateLimit.check({
      state,
      tenantID: "tenant_abc",
      action: "jobs.create",
      limit: 1,
      windowMS: 1_000,
      now: 10,
    })

    expect(
      CloudRateLimit.check({
        state,
        tenantID: "tenant_other",
        action: "jobs.create",
        limit: 1,
        windowMS: 1_000,
        now: 20,
      }).allowed,
    ).toBe(true)
    expect(
      CloudRateLimit.check({
        state,
        tenantID: "tenant_abc",
        action: "files.create",
        limit: 1,
        windowMS: 1_000,
        now: 20,
      }).allowed,
    ).toBe(true)
  })

  test("rejects requests over limit until the window resets", () => {
    const state = CloudRateLimit.create()
    CloudRateLimit.check({
      state,
      tenantID: "tenant_abc",
      action: "jobs.create",
      limit: 1,
      windowMS: 1_000,
      now: 10,
    })

    expect(() =>
      CloudRateLimit.assertAllowed({
        state,
        tenantID: "tenant_abc",
        action: "jobs.create",
        limit: 1,
        windowMS: 1_000,
        now: 20,
      }),
    ).toThrow("Cloud rate limit exceeded")

    expect(
      CloudRateLimit.check({
        state,
        tenantID: "tenant_abc",
        action: "jobs.create",
        limit: 1,
        windowMS: 1_000,
        now: 1_011,
      }),
    ).toEqual({
      allowed: true,
      remaining: 0,
      resetAt: 2_011,
    })
  })
})
