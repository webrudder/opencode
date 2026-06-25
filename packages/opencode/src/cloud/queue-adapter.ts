export type QueueOperation =
  | {
      action: "enqueue"
      queue: string
      jobID: string
      tenantID: string
      runAt: number
      priority: number
    }
  | {
      action: "lease"
      queue: string
      jobID: string
      tenantID: string
      workerID: string
      leaseTTLMS: number
    }
  | {
      action: "heartbeat"
      jobID: string
      workerID: string
      leaseTTLMS: number
      time: number
    }
  | {
      action: "ack"
      jobID: string
      workerID: string
      terminalStatus: "succeeded" | "failed" | "canceled" | "expired"
      time: number
    }
  | {
      action: "retry"
      queue: string
      jobID: string
      tenantID: string
      runAt: number
      attempt: number
      reason: string
    }
  | {
      action: "cancel"
      jobID: string
      tenantID: string
      requestedBy: "api" | "worker" | "system"
      time: number
    }

function queueName(input: { tenantID: string; profile?: string }) {
  return `cloud-runtime:${input.profile ?? "standard"}:${input.tenantID}`
}

export function enqueue(input: {
  tenantID: string
  jobID: string
  now: number
  profile?: string
  runAt?: number
  priority?: number
}): QueueOperation {
  return {
    action: "enqueue",
    queue: queueName(input),
    jobID: input.jobID,
    tenantID: input.tenantID,
    runAt: input.runAt ?? input.now,
    priority: input.priority ?? 0,
  }
}

export function lease(input: {
  tenantID: string
  jobID: string
  workerID: string
  leaseTTLMS: number
  profile?: string
}): QueueOperation {
  return {
    action: "lease",
    queue: queueName(input),
    jobID: input.jobID,
    tenantID: input.tenantID,
    workerID: input.workerID,
    leaseTTLMS: input.leaseTTLMS,
  }
}

export function heartbeat(input: { jobID: string; workerID: string; leaseTTLMS: number; time: number }): QueueOperation {
  return {
    action: "heartbeat",
    jobID: input.jobID,
    workerID: input.workerID,
    leaseTTLMS: input.leaseTTLMS,
    time: input.time,
  }
}

export function ack(input: {
  jobID: string
  workerID: string
  terminalStatus: "succeeded" | "failed" | "canceled" | "expired"
  time: number
}): QueueOperation {
  return {
    action: "ack",
    jobID: input.jobID,
    workerID: input.workerID,
    terminalStatus: input.terminalStatus,
    time: input.time,
  }
}

export function retry(input: {
  tenantID: string
  jobID: string
  runAt: number
  attempt: number
  reason: string
  profile?: string
}): QueueOperation {
  return {
    action: "retry",
    queue: queueName(input),
    jobID: input.jobID,
    tenantID: input.tenantID,
    runAt: input.runAt,
    attempt: input.attempt,
    reason: input.reason,
  }
}

export function cancel(input: {
  tenantID: string
  jobID: string
  requestedBy: "api" | "worker" | "system"
  time: number
}): QueueOperation {
  return {
    action: "cancel",
    jobID: input.jobID,
    tenantID: input.tenantID,
    requestedBy: input.requestedBy,
    time: input.time,
  }
}

export function lifecycle(input: {
  tenantID: string
  jobID: string
  workerID: string
  leaseTTLMS: number
  now: number
  profile?: string
}) {
  return {
    enqueue: enqueue(input),
    lease: lease(input),
    heartbeat: heartbeat({ jobID: input.jobID, workerID: input.workerID, leaseTTLMS: input.leaseTTLMS, time: input.now }),
    cancel: cancel({ tenantID: input.tenantID, jobID: input.jobID, requestedBy: "api", time: input.now }),
  }
}

export * as CloudQueueAdapter from "./queue-adapter"
