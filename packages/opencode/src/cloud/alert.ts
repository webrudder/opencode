type Severity = "warning" | "critical"

type Alert = {
  id: string
  severity: Severity
  tenantID?: string
  runtimeVersion?: string
  reason: string
  value: number
  threshold: number
  time: number
}

type Thresholds = {
  queueDepthWarning: number
  oldestQueuedAgeWarningMS: number
  jobFailureRateWarning: number
  sandboxStartP95WarningMS: number
  workerHeartbeatStaleMS: number
  tenantBudgetCriticalRatio: number
}

export const DefaultThresholds: Thresholds = {
  queueDepthWarning: 100,
  oldestQueuedAgeWarningMS: 300_000,
  jobFailureRateWarning: 0.05,
  sandboxStartP95WarningMS: 60_000,
  workerHeartbeatStaleMS: 120_000,
  tenantBudgetCriticalRatio: 0.9,
}

function alert(input: {
  id: string
  severity: Severity
  tenantID?: string
  runtimeVersion?: string
  reason: string
  value: number
  threshold: number
  time: number
}) {
  return input
}

export function evaluate(input: {
  now: number
  thresholds?: Partial<Thresholds>
  queue?: {
    depth: number
    oldestQueuedAgeMS: number
  }
  jobs?: {
    failureRate: number
    runtimeVersion?: string
  }
  sandbox?: {
    startP95MS: number
    runtimeVersion?: string
  }
  workers?: {
    lastHeartbeatAgeMS: number
  }
  tenantBudget?: {
    tenantID: string
    usedUSD: number
    limitUSD: number
  }
}): Alert[] {
  const thresholds = { ...DefaultThresholds, ...input.thresholds }
  return [
    input.queue &&
    input.queue.depth >= thresholds.queueDepthWarning &&
    input.queue.oldestQueuedAgeMS >= thresholds.oldestQueuedAgeWarningMS
      ? alert({
          id: "cloud.queue.backlog",
          severity: "warning",
          reason: "Queued jobs are backing up",
          value: input.queue.oldestQueuedAgeMS,
          threshold: thresholds.oldestQueuedAgeWarningMS,
          time: input.now,
        })
      : undefined,
    input.jobs && input.jobs.failureRate >= thresholds.jobFailureRateWarning
      ? alert({
          id: "cloud.job.failure_rate",
          severity: "warning",
          runtimeVersion: input.jobs.runtimeVersion,
          reason: "Runtime jobs are failing above the configured rate",
          value: input.jobs.failureRate,
          threshold: thresholds.jobFailureRateWarning,
          time: input.now,
        })
      : undefined,
    input.sandbox && input.sandbox.startP95MS >= thresholds.sandboxStartP95WarningMS
      ? alert({
          id: "cloud.sandbox.start_latency",
          severity: "warning",
          runtimeVersion: input.sandbox.runtimeVersion,
          reason: "Sandbox startup p95 is above the configured latency",
          value: input.sandbox.startP95MS,
          threshold: thresholds.sandboxStartP95WarningMS,
          time: input.now,
        })
      : undefined,
    input.workers && input.workers.lastHeartbeatAgeMS >= thresholds.workerHeartbeatStaleMS
      ? alert({
          id: "cloud.worker.heartbeat_stale",
          severity: "critical",
          reason: "Worker heartbeat is stale",
          value: input.workers.lastHeartbeatAgeMS,
          threshold: thresholds.workerHeartbeatStaleMS,
          time: input.now,
        })
      : undefined,
    input.tenantBudget && input.tenantBudget.usedUSD / input.tenantBudget.limitUSD >= thresholds.tenantBudgetCriticalRatio
      ? alert({
          id: "cloud.tenant.budget_exhaustion",
          severity: "critical",
          tenantID: input.tenantBudget.tenantID,
          reason: "Tenant budget usage is near the configured limit",
          value: input.tenantBudget.usedUSD / input.tenantBudget.limitUSD,
          threshold: thresholds.tenantBudgetCriticalRatio,
          time: input.now,
        })
      : undefined,
  ].filter((item): item is Alert => Boolean(item))
}

export * as CloudAlert from "./alert"
