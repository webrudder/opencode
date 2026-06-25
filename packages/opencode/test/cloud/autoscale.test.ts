import { describe, expect, test } from "bun:test"
import { CloudAutoscale } from "../../src/cloud/autoscale"

describe("CloudAutoscale", () => {
  test("scales up from queue depth and oldest queued age", () => {
    expect(
      CloudAutoscale.decide({
        queue: { depth: 23, oldestQueuedAgeMS: 90_000 },
        workers: { current: 2, busy: 2 },
        policy: {
          min: 1,
          max: 10,
          jobsPerWorker: 5,
          targetOldestQueuedAgeMS: 30_000,
          scaleUpStep: 3,
          scaleDownStep: 1,
        },
      }),
    ).toEqual({
      desired: 5,
      reason: "queue_depth",
    })
  })

  test("scales down conservatively when the queue is empty", () => {
    expect(
      CloudAutoscale.decide({
        queue: { depth: 0, oldestQueuedAgeMS: 0 },
        workers: { current: 6, busy: 1 },
        policy: {
          min: 1,
          max: 10,
          jobsPerWorker: 5,
          targetOldestQueuedAgeMS: 30_000,
          scaleUpStep: 3,
          scaleDownStep: 2,
        },
      }),
    ).toEqual({
      desired: 4,
      reason: "idle_capacity",
    })
  })

  test("holds steady under high resource pressure", () => {
    expect(
      CloudAutoscale.decide({
        queue: { depth: 50, oldestQueuedAgeMS: 120_000 },
        workers: { current: 4, busy: 4 },
        resources: { cpuPressure: 0.95, memoryPressure: 0.7 },
        policy: {
          min: 1,
          max: 20,
          jobsPerWorker: 5,
          targetOldestQueuedAgeMS: 30_000,
          scaleUpStep: 5,
          scaleDownStep: 1,
          maxResourcePressure: 0.9,
        },
      }),
    ).toEqual({
      desired: 4,
      reason: "resource_pressure",
    })
  })

  test("clamps decisions to min and max workers", () => {
    expect(
      CloudAutoscale.decide({
        queue: { depth: 500, oldestQueuedAgeMS: 1 },
        workers: { current: 9, busy: 9 },
        policy: {
          min: 1,
          max: 10,
          jobsPerWorker: 1,
          targetOldestQueuedAgeMS: 30_000,
          scaleUpStep: 50,
          scaleDownStep: 1,
        },
      }).desired,
    ).toBe(10)
  })
})
