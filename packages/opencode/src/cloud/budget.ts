import type { Cost } from "./usage"

function remaining(input: { limit?: number; spent: number; projected: number }) {
  if (input.limit === undefined) return undefined
  return Math.round((input.limit - input.spent - input.projected) * 1_000_000) / 1_000_000
}

export function check(input: { spent: Cost; projected: Cost; tenantBudgetUSD?: number; jobBudgetUSD?: number }) {
  const remainingTenantUSD = remaining({
    limit: input.tenantBudgetUSD,
    spent: input.spent.estimatedUSD,
    projected: input.projected.estimatedUSD,
  })
  const remainingJobUSD = remaining({
    limit: input.jobBudgetUSD,
    spent: 0,
    projected: input.projected.estimatedUSD,
  })

  return {
    allowed:
      (remainingTenantUSD === undefined || remainingTenantUSD >= 0) &&
      (remainingJobUSD === undefined || remainingJobUSD >= 0),
    remainingTenantUSD,
    remainingJobUSD,
  }
}

export function assertAllowed(input: { spent: Cost; projected: Cost; tenantBudgetUSD?: number; jobBudgetUSD?: number }) {
  const result = check(input)
  if (result.remainingTenantUSD !== undefined && result.remainingTenantUSD < 0) {
    throw new Error("Cloud tenant budget exceeded")
  }
  if (result.remainingJobUSD !== undefined && result.remainingJobUSD < 0) {
    throw new Error("Cloud job budget exceeded")
  }
  return result
}

export * as CloudBudget from "./budget"
