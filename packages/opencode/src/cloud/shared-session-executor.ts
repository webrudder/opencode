import { CloudEvent } from "./event"
import type { Manifest } from "./artifact"
import type { JobSpec, JobStatus } from "./runtime"
import { CloudRuntimePool } from "./runtime-pool"
import type { CloudStore } from "./store"
import type { LaunchPlan } from "./worker"
import { CloudWorkerService } from "./worker-service"

type RuntimeResult =
  | {
      status: "succeeded"
      manifest: Manifest
      sizeByPath: Record<string, number>
    }
  | {
      status: "failed"
      message: string
    }

type Runtime = (input: {
  runtimeID: string
  spec: JobSpec
  launch: LaunchPlan
}) => Promise<RuntimeResult>

const activeStatuses = new Set<JobStatus>(["leasing", "starting", "running", "uploading"])

function nextSequence(input: { store: ReturnType<typeof CloudStore.create>; jobID: string }) {
  return input.store.listEvents({ jobID: input.jobID }).length + 1
}

function appendStatus(input: {
  store: ReturnType<typeof CloudStore.create>
  jobID: string
  status: JobStatus
  time: number
}) {
  input.store.appendEvent(
    CloudEvent.status({
      jobID: input.jobID,
      sequence: nextSequence({ store: input.store, jobID: input.jobID }),
      status: input.status,
      time: input.time,
    }),
  )
}

function requireJob(input: { store: ReturnType<typeof CloudStore.create>; tenantID: string; jobID: string }) {
  const job = input.store.getJob({ tenantID: input.tenantID, id: input.jobID })
  if (!job) throw new Error("Cloud job not found")
  return job
}

function requireSpec(input: { store: ReturnType<typeof CloudStore.create>; tenantID: string; jobID: string }) {
  const spec = input.store.getJobSpec({ tenantID: input.tenantID, id: input.jobID })
  if (!spec) throw new Error("Cloud job spec not found")
  return spec
}

function requirePrompt(input: { store: ReturnType<typeof CloudStore.create>; tenantID: string; jobID: string }) {
  const prompt = input.store.getJobPrompt({ tenantID: input.tenantID, jobID: input.jobID })
  if (!prompt) throw new Error("Cloud job prompt not found")
  return prompt.prompt
}

function assertSessionAvailable(input: {
  store: ReturnType<typeof CloudStore.create>
  tenantID: string
  jobID: string
  sessionID: string
}) {
  const active = input.store
    .listJobs({ tenantID: input.tenantID })
    .filter((job) => job.id !== input.jobID && job.sessionID === input.sessionID && activeStatuses.has(job.status))
  if (active.length) throw new Error("Cloud session already has an active job")
}

function workdir(input: { runtimeRoot: string; sessionID: string; jobID: string }) {
  return `${input.runtimeRoot.replace(/\/+$/, "")}/sessions/${input.sessionID}/jobs/${input.jobID}`
}

function paths(input: { runtimeRoot: string; sessionID: string; jobID: string }) {
  const session = `${input.runtimeRoot.replace(/\/+$/, "")}/sessions/${input.sessionID}`
  const job = `${session}/jobs/${input.jobID}`
  return {
    workspace: `${session}/workspace`,
    job,
    input: `${job}/input`,
    output: `${job}/output`,
    artifactManifest: `${job}/.opencode-cloud/artifacts.json`,
  }
}

function launchEnv(input: { runtimeRoot: string; sessionID: string; jobID: string }) {
  const result = paths(input)
  return {
    OPENCODE_RUNTIME_WORKSPACE_DIR: result.workspace,
    OPENCODE_RUNTIME_INPUT_DIR: result.input,
    OPENCODE_RUNTIME_OUTPUT_DIR: result.output,
    OPENCODE_RUNTIME_ARTIFACT_MANIFEST: result.artifactManifest,
  }
}

function runStatus(input: {
  store: ReturnType<typeof CloudStore.create>
  tenantID: string
  jobID: string
  status: "starting" | "running"
  now: number
}) {
  const job = input.store.updateJobStatus({
    tenantID: input.tenantID,
    id: input.jobID,
    status: input.status,
    now: input.now,
  })
  appendStatus({ store: input.store, jobID: job.id, status: job.status, time: job.time.updated })
  return job
}

export function create(input: {
  store: ReturnType<typeof CloudStore.create>
  workerID: string
  now: () => number
  leaseTTLMS: number
  runtimeRoot: string
  runtime: Runtime
  baseEnv?: Record<string, string | undefined>
}) {
  return {
    async runJob(request: { tenantID: string; jobID: string }) {
      const job = requireJob({ store: input.store, tenantID: request.tenantID, jobID: request.jobID })
      assertSessionAvailable({
        store: input.store,
        tenantID: request.tenantID,
        jobID: request.jobID,
        sessionID: job.sessionID,
      })
      const spec = requireSpec({ store: input.store, tenantID: request.tenantID, jobID: request.jobID })
      const assignment = CloudRuntimePool.assign({
        tenantID: request.tenantID,
        sessionID: job.sessionID,
        runtimes: input.store.listRuntimeWorkers({ tenantID: request.tenantID }),
        bindings: input.store.listSessionRuntimeBindings({ tenantID: request.tenantID }),
      })
      if (!assignment.assigned) throw new Error("Cloud runtime capacity exhausted")

      input.store.putSessionRuntimeBinding(
        CloudRuntimePool.bindSession({
          tenantID: request.tenantID,
          sessionID: job.sessionID,
          runtimeID: assignment.runtimeID,
          now: input.now(),
        }),
      )

      const worker = CloudWorkerService.create({
        store: input.store,
        workerID: `${input.workerID}:${assignment.runtimeID}`,
        now: input.now,
        leaseTTLMS: input.leaseTTLMS,
      })
      const started = worker.startJob({
        tenantID: request.tenantID,
        spec,
        prompt: requirePrompt({ store: input.store, tenantID: request.tenantID, jobID: request.jobID }),
        workdir: workdir({ runtimeRoot: input.runtimeRoot, sessionID: job.sessionID, jobID: job.id }),
        baseEnv: {
          ...input.baseEnv,
          ...launchEnv({ runtimeRoot: input.runtimeRoot, sessionID: job.sessionID, jobID: job.id }),
        },
      })
      runStatus({
        store: input.store,
        tenantID: request.tenantID,
        jobID: job.id,
        status: "starting",
        now: input.now(),
      })
      runStatus({
        store: input.store,
        tenantID: request.tenantID,
        jobID: job.id,
        status: "running",
        now: input.now(),
      })

      const result = await input.runtime({
        runtimeID: assignment.runtimeID,
        spec,
        launch: started.plan,
      })
      if (result.status === "failed") {
        const failed = worker.failJob({ tenantID: request.tenantID, jobID: job.id, message: result.message })
        return {
          jobID: failed.id,
          runtimeID: assignment.runtimeID,
          status: failed.status,
          error: failed.error,
        }
      }
      const completed = worker.completeJob({
        tenantID: request.tenantID,
        jobID: job.id,
        manifest: result.manifest,
        objectKeyPrefix: `${request.tenantID}/${job.id}/artifacts`,
        sizeByPath: result.sizeByPath,
      })
      return {
        jobID: completed.job.id,
        runtimeID: assignment.runtimeID,
        status: completed.job.status,
      }
    },
  }
}

export * as CloudSharedSessionExecutor from "./shared-session-executor"
