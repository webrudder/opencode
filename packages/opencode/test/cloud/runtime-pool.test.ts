import { describe, expect, test } from "bun:test"
import { CloudRuntimePool } from "../../src/cloud/runtime-pool"

const base = {
  tenantID: "tenant_abc",
  executionMode: "shared_session_pool" as const,
  version: "1.14.28",
  profile: "standard" as const,
  maxActiveJobs: 4,
  maxSessions: 100,
  time: { created: 10, updated: 10 },
}

describe("CloudRuntimePool", () => {
  test("prefers an existing healthy session binding", () => {
    const runtimes = [
      CloudRuntimePool.decodeRuntimeWorker({
        ...base,
        id: "runtime_a",
        status: "healthy",
        metrics: { activeJobs: 1, busySessions: 1, idleSessions: 10, cpuPercent: 20, memoryPercent: 30, diskPercent: 20, recentErrorRate: 0, heartbeatDelayMS: 100 },
      }),
      CloudRuntimePool.decodeRuntimeWorker({
        ...base,
        id: "runtime_b",
        status: "healthy",
        metrics: { activeJobs: 0, busySessions: 0, idleSessions: 1, cpuPercent: 5, memoryPercent: 10, diskPercent: 10, recentErrorRate: 0, heartbeatDelayMS: 100 },
      }),
    ]

    expect(
      CloudRuntimePool.assign({
        tenantID: "tenant_abc",
        sessionID: "session_abc",
        runtimes,
        bindings: [CloudRuntimePool.bindSession({ tenantID: "tenant_abc", sessionID: "session_abc", runtimeID: "runtime_a", now: 20 })],
      }),
    ).toMatchObject({ runtimeID: "runtime_a", reusedBinding: true })
  })

  test("avoids overloaded bound runtimes and chooses the lowest load healthy runtime", () => {
    const overloaded = CloudRuntimePool.decodeRuntimeWorker({
      ...base,
      id: "runtime_a",
      status: "healthy",
      metrics: { activeJobs: 4, busySessions: 4, idleSessions: 10, cpuPercent: 30, memoryPercent: 40, diskPercent: 20, recentErrorRate: 0, heartbeatDelayMS: 100 },
    })
    const available = CloudRuntimePool.decodeRuntimeWorker({
      ...base,
      id: "runtime_b",
      status: "healthy",
      metrics: { activeJobs: 1, busySessions: 1, idleSessions: 5, cpuPercent: 20, memoryPercent: 20, diskPercent: 20, recentErrorRate: 0, heartbeatDelayMS: 100 },
    })

    expect(
      CloudRuntimePool.assign({
        tenantID: "tenant_abc",
        sessionID: "session_abc",
        runtimes: [overloaded, available],
        bindings: [CloudRuntimePool.bindSession({ tenantID: "tenant_abc", sessionID: "session_abc", runtimeID: "runtime_a", now: 20 })],
      }),
    ).toMatchObject({ runtimeID: "runtime_b", reusedBinding: false })
  })

  test("reports no capacity when all runtimes are full or offline", () => {
    expect(
      CloudRuntimePool.assign({
        tenantID: "tenant_abc",
        sessionID: "session_abc",
        runtimes: [
          CloudRuntimePool.decodeRuntimeWorker({
            ...base,
            id: "runtime_offline",
            status: "offline",
            metrics: { activeJobs: 0, busySessions: 0, idleSessions: 0, cpuPercent: 0, memoryPercent: 0, diskPercent: 0, recentErrorRate: 0, heartbeatDelayMS: 60_000 },
          }),
        ],
        bindings: [],
      }),
    ).toEqual({ assigned: false, reason: "no_capacity" })
  })

  test("uses session bindings as the authoritative shared runtime session capacity", () => {
    const runtime = CloudRuntimePool.decodeRuntimeWorker({
      ...base,
      id: "runtime_a",
      status: "healthy",
      maxSessions: 1,
      metrics: {
        activeJobs: 0,
        busySessions: 0,
        idleSessions: 0,
        cpuPercent: 10,
        memoryPercent: 10,
        diskPercent: 10,
        recentErrorRate: 0,
        heartbeatDelayMS: 100,
      },
    })
    const binding = CloudRuntimePool.bindSession({
      tenantID: "tenant_abc",
      sessionID: "session_existing",
      runtimeID: "runtime_a",
      now: 20,
    })

    expect(CloudRuntimePool.capacity({ runtime, boundSessions: 1 })).toMatchObject({
      healthy: false,
      reasons: ["max_sessions"],
      remainingSessions: 0,
    })
    expect(
      CloudRuntimePool.assign({
        tenantID: "tenant_abc",
        sessionID: "session_new",
        runtimes: [runtime],
        bindings: [binding],
      }),
    ).toEqual({ assigned: false, reason: "no_capacity" })
  })

  test("keeps using a bound runtime for the same session even at session capacity", () => {
    const runtime = CloudRuntimePool.decodeRuntimeWorker({
      ...base,
      id: "runtime_a",
      status: "healthy",
      maxSessions: 1,
      metrics: {
        activeJobs: 0,
        busySessions: 0,
        idleSessions: 0,
        cpuPercent: 10,
        memoryPercent: 10,
        diskPercent: 10,
        recentErrorRate: 0,
        heartbeatDelayMS: 100,
      },
    })
    const binding = CloudRuntimePool.bindSession({
      tenantID: "tenant_abc",
      sessionID: "session_existing",
      runtimeID: "runtime_a",
      now: 20,
    })

    expect(
      CloudRuntimePool.assign({
        tenantID: "tenant_abc",
        sessionID: "session_existing",
        runtimes: [runtime],
        bindings: [binding],
      }),
    ).toMatchObject({ assigned: true, runtimeID: "runtime_a", reusedBinding: true })
  })

  test("summarizes pool capacity and recommends scale up when slots are exhausted", () => {
    const runtime = CloudRuntimePool.decodeRuntimeWorker({
      ...base,
      id: "runtime_full",
      status: "healthy",
      maxActiveJobs: 1,
      maxSessions: 1,
      metrics: {
        activeJobs: 1,
        busySessions: 0,
        idleSessions: 0,
        cpuPercent: 10,
        memoryPercent: 10,
        diskPercent: 10,
        recentErrorRate: 0,
        heartbeatDelayMS: 100,
      },
    })

    expect(
      CloudRuntimePool.poolPlan({
        tenantID: "tenant_abc",
        runtimes: [runtime],
        bindings: [
          CloudRuntimePool.bindSession({
            tenantID: "tenant_abc",
            sessionID: "session_existing",
            runtimeID: "runtime_full",
            now: 20,
          }),
        ],
      }),
    ).toEqual({
      desiredRuntimes: 2,
      action: "scale_up",
      reason: "capacity_exhausted",
      availableJobSlots: 0,
      availableSessionSlots: 0,
      boundSessions: 1,
      saturatedRuntimes: 1,
      unavailableRuntimes: 1,
      drainRuntimeIDs: [],
      releaseSessionIDs: [],
    })
  })

  test("summarizes idle pool capacity and recommends conservative scale down", () => {
    const runtime = (id: string) =>
      CloudRuntimePool.decodeRuntimeWorker({
        ...base,
        id,
        status: "healthy",
        maxActiveJobs: 10,
        maxSessions: 50,
        metrics: {
          activeJobs: 0,
          busySessions: 0,
          idleSessions: 0,
          cpuPercent: 5,
          memoryPercent: 10,
          diskPercent: 10,
          recentErrorRate: 0,
          heartbeatDelayMS: 100,
        },
      })

    expect(
      CloudRuntimePool.poolPlan({
        tenantID: "tenant_abc",
        runtimes: [runtime("runtime_a"), runtime("runtime_b")],
        bindings: [],
      }),
    ).toMatchObject({
      desiredRuntimes: 1,
      action: "scale_down",
      reason: "idle_capacity",
      availableJobSlots: 20,
      availableSessionSlots: 100,
      drainRuntimeIDs: ["runtime_a"],
    })
  })

  test("plans session binding release for offline runtimes", () => {
    const runtime = CloudRuntimePool.decodeRuntimeWorker({
      ...base,
      id: "runtime_offline",
      status: "offline",
      metrics: {
        activeJobs: 0,
        busySessions: 0,
        idleSessions: 0,
        cpuPercent: 0,
        memoryPercent: 0,
        diskPercent: 0,
        recentErrorRate: 0,
        heartbeatDelayMS: 60_000,
      },
    })

    expect(
      CloudRuntimePool.poolPlan({
        tenantID: "tenant_abc",
        runtimes: [runtime],
        bindings: [
          CloudRuntimePool.bindSession({
            tenantID: "tenant_abc",
            sessionID: "session_stale",
            runtimeID: "runtime_offline",
            now: 20,
          }),
        ],
      }).releaseSessionIDs,
    ).toEqual(["session_stale"])
  })

  test("plans stale runtime offline updates and releases its session bindings", () => {
    const stale = CloudRuntimePool.decodeRuntimeWorker({
      ...base,
      id: "runtime_stale",
      status: "healthy",
      metrics: { activeJobs: 0, busySessions: 1, idleSessions: 2, cpuPercent: 10, memoryPercent: 20, diskPercent: 10, recentErrorRate: 0, heartbeatDelayMS: 100 },
      time: { created: 10, updated: 1_000 },
    })
    const healthy = CloudRuntimePool.decodeRuntimeWorker({
      ...base,
      id: "runtime_healthy",
      status: "healthy",
      metrics: { activeJobs: 0, busySessions: 0, idleSessions: 2, cpuPercent: 10, memoryPercent: 20, diskPercent: 10, recentErrorRate: 0, heartbeatDelayMS: 100 },
      time: { created: 10, updated: 4_900 },
    })
    const binding = CloudRuntimePool.bindSession({
      tenantID: "tenant_abc",
      sessionID: "session_abc",
      runtimeID: "runtime_stale",
      now: 2_000,
    })

    expect(
      CloudRuntimePool.reconcile({
        tenantID: "tenant_abc",
        now: 5_000,
        heartbeatTTLMS: 3_000,
        runtimes: [stale, healthy],
        bindings: [binding],
      }),
    ).toEqual({
      runtimes: [
        {
          ...stale,
          status: "offline",
          metrics: {
            ...stale.metrics,
            heartbeatDelayMS: 4_000,
          },
          time: {
            created: 10,
            updated: 5_000,
          },
        },
        {
          ...healthy,
          metrics: {
            ...healthy.metrics,
            heartbeatDelayMS: 100,
          },
        },
      ],
      releasedBindings: [binding],
    })
  })
})
