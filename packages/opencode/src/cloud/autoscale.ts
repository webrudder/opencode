type Policy = {
  min: number
  max: number
  jobsPerWorker: number
  targetOldestQueuedAgeMS: number
  scaleUpStep: number
  scaleDownStep: number
  maxResourcePressure?: number
}

function clamp(input: { value: number; min: number; max: number }) {
  return Math.max(input.min, Math.min(input.max, input.value))
}

function pressureExceeded(input: { cpuPressure?: number; memoryPressure?: number; maxResourcePressure?: number }) {
  if (input.maxResourcePressure === undefined) return false
  return (input.cpuPressure ?? 0) > input.maxResourcePressure || (input.memoryPressure ?? 0) > input.maxResourcePressure
}

export function decide(input: {
  queue: {
    depth: number
    oldestQueuedAgeMS: number
  }
  workers: {
    current: number
    busy: number
  }
  resources?: {
    cpuPressure?: number
    memoryPressure?: number
  }
  policy: Policy
}) {
  if (pressureExceeded({ ...input.resources, maxResourcePressure: input.policy.maxResourcePressure })) {
    return {
      desired: clamp({ value: input.workers.current, min: input.policy.min, max: input.policy.max }),
      reason: "resource_pressure" as const,
    }
  }

  if (input.queue.depth > 0) {
    const desiredByDepth = Math.ceil(input.queue.depth / input.policy.jobsPerWorker)
    return {
      desired: clamp({
        value:
          desiredByDepth > input.workers.current
            ? Math.min(desiredByDepth, input.workers.current + input.policy.scaleUpStep)
            : input.workers.current,
        min: input.policy.min,
        max: input.policy.max,
      }),
      reason: "queue_depth" as const,
    }
  }

  if (input.workers.current > input.policy.min && input.workers.busy < input.workers.current) {
    return {
      desired: clamp({
        value: input.workers.current - input.policy.scaleDownStep,
        min: Math.max(input.policy.min, input.workers.busy),
        max: input.policy.max,
      }),
      reason: "idle_capacity" as const,
    }
  }

  return {
    desired: clamp({ value: input.workers.current, min: input.policy.min, max: input.policy.max }),
    reason: "steady" as const,
  }
}

export * as CloudAutoscale from "./autoscale"
