import { CloudQueue } from "./queue"
import type { JobSpec } from "./runtime"
import type { CloudStore } from "./store"
import { CloudWorkerRunner } from "./worker-runner"
import { CloudWorkerService } from "./worker-service"

export function tick(input: {
  store: ReturnType<typeof CloudStore.create>
  tenantID: string
  workerID: string
  leaseTTLMS: number
  now: () => number
  jobSpecs?: Record<string, JobSpec>
  prompts?: Record<string, string>
  sandboxRoot: string
  bucket: string
  namespace: string
  baseEnv?: Record<string, string | undefined>
}) {
  const job = CloudQueue.next({ tenantID: input.tenantID, jobs: input.store.listJobs({ tenantID: input.tenantID }) })
  if (!job) return { status: "idle" as const }
  const spec = input.store.getJobSpec({ tenantID: input.tenantID, id: job.id }) ?? input.jobSpecs?.[job.id]
  if (!spec) throw new Error("Cloud worker loop job spec not found")
  const prompt = input.store.getJobPrompt({ tenantID: input.tenantID, jobID: job.id })?.prompt ?? input.prompts?.[job.id] ?? ""

  const started = CloudWorkerService.create({
    store: input.store,
    workerID: input.workerID,
    now: input.now,
    leaseTTLMS: input.leaseTTLMS,
  }).startJob({
    tenantID: input.tenantID,
    spec,
    prompt,
    workdir: `${input.sandboxRoot.replace(/\/+$/, "")}/${job.id}/work`,
    baseEnv: input.baseEnv,
  })

  return {
    status: "started" as const,
    jobID: job.id,
    lease: started.lease,
    attempt: started.attempt,
    launch: started.plan,
    runner: CloudWorkerRunner.start({
      tenantID: input.tenantID,
      jobID: job.id,
      workerID: input.workerID,
      leaseTTLMS: input.leaseTTLMS,
      bucket: input.bucket,
      namespace: input.namespace,
      launch: started.plan,
      profile: spec.runtime.profile,
      stagedInputs: [],
      mutations: [],
      now: input.now(),
    }),
  }
}

export function heartbeat(input: {
  store: ReturnType<typeof CloudStore.create>
  workerID: string
  leaseTTLMS: number
  now: () => number
  jobID: string
}) {
  return CloudWorkerService.create({
    store: input.store,
    workerID: input.workerID,
    now: input.now,
    leaseTTLMS: input.leaseTTLMS,
  }).heartbeat({ jobID: input.jobID })
}

export * as CloudWorkerLoop from "./worker-loop"
