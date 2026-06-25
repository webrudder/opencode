import type { QueueOperation } from "./queue-adapter"

type LeaseResult =
  | {
      leased: true
      leaseToken?: string
    }
  | {
      leased: false
      reason?: string
    }

export type Client = {
  enqueue?: (input: Extract<QueueOperation, { action: "enqueue" }> extends infer T ? Omit<T, "action"> : never) => Promise<{
    messageID?: string
  }>
  lease?: (input: Extract<QueueOperation, { action: "lease" }> extends infer T ? Omit<T, "action"> : never) => Promise<LeaseResult>
  heartbeat?: (input: Extract<QueueOperation, { action: "heartbeat" }> extends infer T ? Omit<T, "action"> : never) => Promise<{
    extended: boolean
  }>
  ack?: (input: Extract<QueueOperation, { action: "ack" }> extends infer T ? Omit<T, "action"> : never) => Promise<{
    acknowledged: boolean
  }>
  retry?: (input: Extract<QueueOperation, { action: "retry" }> extends infer T ? Omit<T, "action"> : never) => Promise<{
    messageID?: string
  }>
  cancel?: (input: Extract<QueueOperation, { action: "cancel" }> extends infer T ? Omit<T, "action"> : never) => Promise<{
    canceled: boolean
  }>
}

function requireMethod<T>(input: T | undefined, name: string): T {
  if (input) return input
  throw new Error(`Cloud queue client ${name} is not configured`)
}

function stripAction<T extends QueueOperation>(input: T): Omit<T, "action"> {
  const { action: _, ...rest } = input
  return rest
}

export async function run(input: { client: Client; operations: QueueOperation[] }) {
  const result = {
    enqueued: 0,
    leases: [] as Array<{ jobID: string } & LeaseResult>,
    heartbeats: 0,
    acknowledgements: 0,
    retries: 0,
    cancellations: 0,
  }

  for (const operation of input.operations) {
    if (operation.action === "enqueue") {
      await requireMethod(input.client.enqueue, "enqueue")(stripAction(operation))
      result.enqueued += 1
      continue
    }
    if (operation.action === "lease") {
      result.leases.push({
        jobID: operation.jobID,
        ...(await requireMethod(input.client.lease, "lease")(stripAction(operation))),
      })
      continue
    }
    if (operation.action === "heartbeat") {
      await requireMethod(input.client.heartbeat, "heartbeat")(stripAction(operation))
      result.heartbeats += 1
      continue
    }
    if (operation.action === "ack") {
      await requireMethod(input.client.ack, "ack")(stripAction(operation))
      result.acknowledgements += 1
      continue
    }
    if (operation.action === "retry") {
      await requireMethod(input.client.retry, "retry")(stripAction(operation))
      result.retries += 1
      continue
    }
    await requireMethod(input.client.cancel, "cancel")(stripAction(operation))
    result.cancellations += 1
  }

  return result
}

export * as CloudQueueRunner from "./queue-runner"
