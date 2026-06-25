import { describe, expect, test } from "bun:test"
import { CloudBudget } from "../../src/cloud/budget"
import { CloudUsage } from "../../src/cloud/usage"

describe("CloudBudget", () => {
  test("allows a job when projected cost fits tenant and job budgets", () => {
    expect(
      CloudBudget.check({
        spent: CloudUsage.fixedCost(3),
        projected: CloudUsage.fixedCost(2),
        tenantBudgetUSD: 10,
        jobBudgetUSD: 3,
      }),
    ).toEqual({
      allowed: true,
      remainingTenantUSD: 5,
      remainingJobUSD: 1,
    })
  })

  test("rejects a job when projected cost exceeds tenant budget", () => {
    expect(() =>
      CloudBudget.assertAllowed({
        spent: CloudUsage.fixedCost(9),
        projected: CloudUsage.fixedCost(2),
        tenantBudgetUSD: 10,
      }),
    ).toThrow("Cloud tenant budget exceeded")
  })

  test("rejects a job when projected cost exceeds job budget", () => {
    expect(() =>
      CloudBudget.assertAllowed({
        spent: CloudUsage.fixedCost(1),
        projected: CloudUsage.fixedCost(2),
        tenantBudgetUSD: 10,
        jobBudgetUSD: 1,
      }),
    ).toThrow("Cloud job budget exceeded")
  })

  test("treats missing budgets as unlimited", () => {
    expect(
      CloudBudget.check({
        spent: CloudUsage.fixedCost(100),
        projected: CloudUsage.fixedCost(50),
      }),
    ).toEqual({
      allowed: true,
      remainingTenantUSD: undefined,
      remainingJobUSD: undefined,
    })
  })
})
