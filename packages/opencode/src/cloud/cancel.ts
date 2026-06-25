import { CloudAttempt } from "./attempt"
import type { CloudLease } from "./lease"

type Attempt = ReturnType<typeof CloudAttempt.start>

function name(input: string) {
  const result = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
  return result || "job"
}

export function plan(input: {
  tenantID: string
  jobID: string
  namespace: string
  lease?: CloudLease.Lease
  workerID?: string
  attempt?: Attempt
  now: number
}) {
  if (input.lease && input.workerID && input.lease.workerID !== input.workerID) {
    throw new Error("Cloud cancel lease owner mismatch")
  }

  return {
    jobID: input.jobID,
    tenantID: input.tenantID,
    ...(input.lease ? { workerID: input.lease.workerID } : {}),
    kubernetes: {
      deletePod: {
        apiVersion: "v1",
        kind: "Pod",
        namespace: input.namespace,
        name: `opencode-${name(input.jobID)}`,
        propagationPolicy: "Background",
      },
    },
    ...(input.attempt ? { attempt: CloudAttempt.cancel({ attempt: input.attempt, now: input.now }) } : {}),
  }
}

export * as CloudCancel from "./cancel"
