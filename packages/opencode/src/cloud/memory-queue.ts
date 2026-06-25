import type { Client } from "./queue-runner"

type Message = {
  queue: string
  tenantID: string
  jobID: string
  runAt: number
  priority: number
  attempt: number
  status: "queued" | "leased" | "acked" | "canceled"
  workerID?: string
  leaseExpiresAt?: number
  reason?: string
  terminalStatus?: "succeeded" | "failed" | "canceled" | "expired"
}

export type State = {
  now: () => number
  messages: Map<string, Message>
}

function key(input: { queue?: string; tenantID?: string; jobID: string }) {
  return `${input.queue ?? "*"}:${input.tenantID ?? "*"}:${input.jobID}`
}

function visible(input: { message: Message; now: number }) {
  if (input.message.status === "queued") return input.message.runAt <= input.now
  if (input.message.status !== "leased") return false
  return (input.message.leaseExpiresAt ?? 0) <= input.now
}

function message(input: State, jobID: string) {
  return Array.from(input.messages.values()).find((item) => item.jobID === jobID)
}

export function create(input: { now: () => number }): State {
  return {
    now: input.now,
    messages: new Map(),
  }
}

export function client(state: State): Client {
  return {
    async enqueue(input) {
      state.messages.set(key(input), {
        ...input,
        attempt: 1,
        status: "queued",
      })
      return { messageID: key(input) }
    },
    async lease(input) {
      const found = state.messages.get(key(input))
      if (!found) return { leased: false, reason: "missing" }
      if (!visible({ message: found, now: state.now() })) return { leased: false, reason: found.status === "leased" ? "leased" : found.status }
      const result = {
        ...found,
        status: "leased" as const,
        workerID: input.workerID,
        leaseExpiresAt: state.now() + input.leaseTTLMS,
      }
      state.messages.set(key(input), result)
      return { leased: true as const, leaseToken: `${input.workerID}:${input.jobID}:${result.leaseExpiresAt}` }
    },
    async heartbeat(input) {
      const found = message(state, input.jobID)
      if (!found || found.workerID !== input.workerID || found.status !== "leased") return { extended: false }
      state.messages.set(key(found), {
        ...found,
        leaseExpiresAt: input.time + input.leaseTTLMS,
      })
      return { extended: true }
    },
    async ack(input) {
      const found = message(state, input.jobID)
      if (!found || found.workerID !== input.workerID) return { acknowledged: false }
      state.messages.set(key(found), {
        ...found,
        status: "acked",
        terminalStatus: input.terminalStatus,
      })
      return { acknowledged: true }
    },
    async retry(input) {
      state.messages.set(key(input), {
        queue: input.queue,
        tenantID: input.tenantID,
        jobID: input.jobID,
        runAt: input.runAt,
        priority: 0,
        attempt: input.attempt,
        reason: input.reason,
        status: "queued",
      })
      return { messageID: key(input) }
    },
    async cancel(input) {
      const found = message(state, input.jobID)
      if (!found || found.tenantID !== input.tenantID) return { canceled: false }
      state.messages.set(key(found), {
        ...found,
        status: "canceled",
      })
      return { canceled: true }
    },
  }
}

export function snapshot(state: State) {
  return Array.from(state.messages.values()).toSorted(
    (a, b) => a.runAt - b.runAt || b.priority - a.priority || a.jobID.localeCompare(b.jobID),
  )
}

export * as CloudMemoryQueue from "./memory-queue"
