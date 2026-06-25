import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import type { CloudSchema } from "./schema"
import { JobStatus } from "./runtime"
import { CloudSchema as SchemaCloud } from "./schema"

export const Lease = Schema.Struct({
  jobID: Schema.String,
  workerID: Schema.String,
  expiresAt: Schema.Number,
  heartbeatAt: Schema.Number,
})
  .annotate({ identifier: "CloudJobLease" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Lease = Schema.Schema.Type<typeof Lease>

const terminal = new Set<JobStatus>(["succeeded", "failed", "canceled", "expired"])

function active(lease: Lease | undefined, now: number) {
  return lease && lease.expiresAt > now
}

export function leaseJob(input: {
  job: CloudSchema.Job
  lease?: Lease
  workerID: string
  now: number
  ttlMS: number
}) {
  if (terminal.has(input.job.status)) throw new Error(`Cannot lease terminal cloud job: ${input.job.status}`)
  if (active(input.lease, input.now) && input.lease?.workerID !== input.workerID) {
    throw new Error(`Cloud job lease is still active: ${input.job.id}`)
  }

  return {
    job: {
      ...input.job,
      status: input.job.status === "queued" ? SchemaCloud.transitionJobStatus(input.job.status, "leasing") : input.job.status,
      time: {
        ...input.job.time,
        updated: input.now,
      },
    },
    lease: {
      jobID: input.job.id,
      workerID: input.workerID,
      expiresAt: input.now + input.ttlMS,
      heartbeatAt: input.now,
    },
  }
}

export function heartbeat(input: { lease: Lease; workerID: string; now: number; ttlMS: number }) {
  if (input.lease.workerID !== input.workerID) throw new Error(`Cloud job lease owner mismatch: ${input.lease.jobID}`)
  return {
    ...input.lease,
    expiresAt: input.now + input.ttlMS,
    heartbeatAt: input.now,
  }
}

export * as CloudLease from "./lease"
