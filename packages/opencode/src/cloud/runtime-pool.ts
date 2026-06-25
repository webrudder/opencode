import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { optionalOmitUndefined, withStatics } from "@/util/schema"

const Time = Schema.Struct({
  created: Schema.Number,
  updated: Schema.Number,
})

const ExecutionMode = Schema.Literals(["shared_session_pool", "isolated_job_runtime", "local_dev"])
const RuntimeStatus = Schema.Literals(["healthy", "draining", "overloaded", "offline"])
const RuntimeProfile = Schema.Literals(["small", "standard", "large", "gpu"])

const RuntimeMetrics = Schema.Struct({
  activeJobs: Schema.Number,
  busySessions: Schema.Number,
  idleSessions: Schema.Number,
  cpuPercent: Schema.Number,
  memoryPercent: Schema.Number,
  diskPercent: Schema.Number,
  recentErrorRate: Schema.Number,
  heartbeatDelayMS: Schema.Number,
  childProcesses: optionalOmitUndefined(Schema.Number),
  openFiles: optionalOmitUndefined(Schema.Number),
  oldestQueueAgeMS: optionalOmitUndefined(Schema.Number),
})

export const RuntimeWorker = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  executionMode: ExecutionMode,
  status: RuntimeStatus,
  version: Schema.String,
  profile: RuntimeProfile,
  maxActiveJobs: Schema.Number,
  maxSessions: Schema.Number,
  endpoint: optionalOmitUndefined(Schema.String),
  metrics: RuntimeMetrics,
  time: Time,
})
  .annotate({ identifier: "CloudRuntimeWorker" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type RuntimeWorker = Schema.Schema.Type<typeof RuntimeWorker>

export const SessionBinding = Schema.Struct({
  tenantID: Schema.String,
  sessionID: Schema.String,
  runtimeID: Schema.String,
  time: Time,
})
  .annotate({ identifier: "CloudSessionRuntimeBinding" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SessionBinding = Schema.Schema.Type<typeof SessionBinding>

function boundSessionCounts(input: { tenantID: string; bindings: SessionBinding[] }) {
  return new Map(
    input.bindings
      .filter((binding) => binding.tenantID === input.tenantID)
      .map((binding) => binding.runtimeID)
      .map((runtimeID) => [
        runtimeID,
        input.bindings.filter((binding) => binding.tenantID === input.tenantID && binding.runtimeID === runtimeID)
          .length,
      ]),
  )
}

export function capacity(input: { runtime: RuntimeWorker; boundSessions?: number }) {
  const boundSessions = input.boundSessions ?? input.runtime.metrics.idleSessions + input.runtime.metrics.busySessions
  const reasons = [
    input.runtime.status === "healthy" ? undefined : `status:${input.runtime.status}`,
    input.runtime.metrics.activeJobs < input.runtime.maxActiveJobs ? undefined : "active_jobs",
    boundSessions < input.runtime.maxSessions ? undefined : "max_sessions",
    input.runtime.metrics.memoryPercent < 85 ? undefined : "memory",
    input.runtime.metrics.diskPercent < 90 ? undefined : "disk",
    input.runtime.metrics.cpuPercent < 95 ? undefined : "cpu",
    input.runtime.metrics.recentErrorRate < 0.1 ? undefined : "error_rate",
    input.runtime.metrics.heartbeatDelayMS < 30_000 ? undefined : "heartbeat",
  ].filter((reason): reason is string => Boolean(reason))
  return {
    healthy: reasons.length === 0,
    reasons,
    boundSessions,
    remainingJobs: Math.max(0, input.runtime.maxActiveJobs - input.runtime.metrics.activeJobs),
    remainingSessions: Math.max(0, input.runtime.maxSessions - boundSessions),
    loadScore: loadScore(input.runtime),
  }
}

export function poolPlan(input: { tenantID: string; runtimes: RuntimeWorker[]; bindings: SessionBinding[] }) {
  const counts = boundSessionCounts(input)
  const runtimes = input.runtimes.filter((runtime) => runtime.tenantID === input.tenantID)
  const runtimeCapacities = runtimes.map((runtime) => ({
    runtime,
    capacity: capacity({ runtime, boundSessions: counts.get(runtime.id) ?? 0 }),
  }))
  const capacities = runtimeCapacities.map((item) => item.capacity)
  const healthy = capacities.filter((item) => item.healthy)
  const availableJobSlots = healthy.reduce((total, item) => total + item.remainingJobs, 0)
  const availableSessionSlots = healthy.reduce((total, item) => total + item.remainingSessions, 0)
  const saturatedRuntimes = capacities.filter((item) => item.remainingJobs === 0 || item.remainingSessions === 0).length
  const unavailableRuntimes = capacities.filter((item) => !item.healthy).length
  const desiredRuntimes =
    availableJobSlots === 0 || availableSessionSlots === 0
      ? runtimes.length + 1
      : runtimes.length > 1 && healthy.length > 0 && availableJobSlots > healthy.length * 2 && availableSessionSlots > healthy.length * 5
        ? Math.max(1, runtimes.length - 1)
        : runtimes.length
  const scaleDownCount = Math.max(0, runtimes.length - desiredRuntimes)
  const releaseRuntimeIDs = new Set(
    runtimeCapacities
      .filter((item) => item.runtime.status === "offline" || item.capacity.reasons.includes("heartbeat"))
      .map((item) => item.runtime.id),
  )
  return {
    desiredRuntimes,
    action: desiredRuntimes > runtimes.length ? "scale_up" as const : desiredRuntimes < runtimes.length ? "scale_down" as const : "hold" as const,
    reason:
      desiredRuntimes > runtimes.length
        ? "capacity_exhausted" as const
        : desiredRuntimes < runtimes.length
          ? "idle_capacity" as const
          : unavailableRuntimes > 0 || saturatedRuntimes > 0
            ? "partial_pressure" as const
            : "steady" as const,
    availableJobSlots,
    availableSessionSlots,
    boundSessions: input.bindings.filter((binding) => binding.tenantID === input.tenantID).length,
    saturatedRuntimes,
    unavailableRuntimes,
    drainRuntimeIDs: runtimeCapacities
      .filter((item) => item.capacity.healthy && item.runtime.metrics.activeJobs === 0 && (counts.get(item.runtime.id) ?? 0) === 0)
      .toSorted((a, b) => b.capacity.loadScore - a.capacity.loadScore)
      .slice(0, scaleDownCount)
      .map((item) => item.runtime.id),
    releaseSessionIDs: input.bindings
      .filter((binding) => binding.tenantID === input.tenantID && releaseRuntimeIDs.has(binding.runtimeID))
      .map((binding) => binding.sessionID),
  }
}

export function loadScore(input: RuntimeWorker) {
  return (
    input.metrics.activeJobs * 100 +
    input.metrics.busySessions * 25 +
    input.metrics.cpuPercent +
    input.metrics.memoryPercent +
    input.metrics.diskPercent +
    input.metrics.recentErrorRate * 1000 +
    input.metrics.heartbeatDelayMS / 1000 +
    (input.metrics.oldestQueueAgeMS ?? 0) / 1000
  )
}

export function bindSession(input: { tenantID: string; sessionID: string; runtimeID: string; now: number }) {
  return Schema.decodeUnknownSync(SessionBinding)({
    tenantID: input.tenantID,
    sessionID: input.sessionID,
    runtimeID: input.runtimeID,
    time: {
      created: input.now,
      updated: input.now,
    },
  })
}

export function assign(input: {
  tenantID: string
  sessionID: string
  runtimes: RuntimeWorker[]
  bindings: SessionBinding[]
}) {
  const counts = boundSessionCounts({ tenantID: input.tenantID, bindings: input.bindings })
  const binding = input.bindings.find(
    (item) => item.tenantID === input.tenantID && item.sessionID === input.sessionID,
  )
  const candidates = input.runtimes.filter(
    (runtime) =>
      runtime.tenantID === input.tenantID &&
      capacity({
        runtime,
        boundSessions: Math.max(0, (counts.get(runtime.id) ?? 0) - (runtime.id === binding?.runtimeID ? 1 : 0)),
      }).healthy,
  )
  const bound = candidates.find((runtime) => runtime.id === binding?.runtimeID)
  if (bound) {
    return {
      assigned: true as const,
      runtimeID: bound.id,
      reusedBinding: true,
      loadScore: loadScore(bound),
    }
  }
  const next = candidates.toSorted((a, b) => loadScore(a) - loadScore(b))[0]
  if (!next) return { assigned: false as const, reason: "no_capacity" as const }
  return {
    assigned: true as const,
    runtimeID: next.id,
    reusedBinding: false,
    loadScore: loadScore(next),
  }
}

export function reconcile(input: {
  tenantID: string
  now: number
  heartbeatTTLMS: number
  runtimes: RuntimeWorker[]
  bindings: SessionBinding[]
}) {
  const runtimes = input.runtimes.map((runtime) => {
    if (runtime.tenantID !== input.tenantID) return runtime
    const heartbeatDelayMS = Math.max(0, input.now - runtime.time.updated)
    if (heartbeatDelayMS <= input.heartbeatTTLMS) {
      return {
        ...runtime,
        metrics: {
          ...runtime.metrics,
          heartbeatDelayMS,
        },
      }
    }
    return decodeRuntimeWorker({
      ...runtime,
      status: "offline",
      metrics: {
        ...runtime.metrics,
        heartbeatDelayMS,
      },
      time: {
        ...runtime.time,
        updated: input.now,
      },
    })
  })
  const offline = new Set(runtimes.filter((runtime) => runtime.tenantID === input.tenantID && runtime.status === "offline").map((runtime) => runtime.id))
  return {
    runtimes,
    releasedBindings: input.bindings.filter((binding) => binding.tenantID === input.tenantID && offline.has(binding.runtimeID)),
  }
}

export const decodeRuntimeWorker = Schema.decodeUnknownSync(RuntimeWorker)
export const decodeSessionBinding = Schema.decodeUnknownSync(SessionBinding)

export * as CloudRuntimePool from "./runtime-pool"
