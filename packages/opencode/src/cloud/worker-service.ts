import { CloudAttempt } from "./attempt"
import { CloudArtifact } from "./artifact"
import { CloudEvent } from "./event"
import { CloudLease } from "./lease"
import type { JobSpec, JobStatus } from "./runtime"
import type { CloudStore } from "./store"
import { CloudWorker } from "./worker"

function nextSequence(input: { store: ReturnType<typeof CloudStore.create>; jobID: string }) {
  return input.store.listEvents({ jobID: input.jobID }).length + 1
}

function appendStatus(input: {
  store: ReturnType<typeof CloudStore.create>
  job: { id: string; status: JobStatus; time: { updated: number } }
}) {
  input.store.appendEvent(
    CloudEvent.status({
      jobID: input.job.id,
      sequence: nextSequence({ store: input.store, jobID: input.job.id }),
      status: input.job.status,
      time: input.job.time.updated,
    }),
  )
}

function runningAttempt(input: { store: ReturnType<typeof CloudStore.create>; tenantID: string; jobID: string }) {
  return input.store
    .listAttempts({ tenantID: input.tenantID, jobID: input.jobID })
    .filter((attempt) => attempt.status === "running")
    .toSorted((a, b) => b.attempt - a.attempt)[0]
}

export function create(input: {
  store: ReturnType<typeof CloudStore.create>
  workerID: string
  now: () => number
  leaseTTLMS: number
}) {
  return {
    startJob(request: {
      tenantID: string
      spec: JobSpec
      prompt: string
      workdir: string
      baseEnv?: Record<string, string | undefined>
    }) {
      const job = input.store.getJob({ tenantID: request.tenantID, id: request.spec.id })
      if (!job) throw new Error("Cloud job not found")

      const result = CloudLease.leaseJob({
        job,
        lease: input.store.getLease({ jobID: job.id }),
        workerID: input.workerID,
        now: input.now(),
        ttlMS: input.leaseTTLMS,
      })
      input.store.putJob(result.job)
      input.store.putLease(result.lease)
      const attempt = input.store.putAttempt(
        CloudAttempt.start({
          job: result.job,
          workerID: input.workerID,
          attempt: input.store.listAttempts({ tenantID: request.tenantID, jobID: result.job.id }).length + 1,
          reason: input.store.listAttempts({ tenantID: request.tenantID, jobID: result.job.id }).length ? "retry" : "initial",
          now: input.now(),
        }),
      )
      appendStatus({ store: input.store, job: result.job })

      return {
        lease: result.lease,
        attempt,
        plan: CloudWorker.launchPlan(request.spec, {
          workdir: request.workdir,
          prompt: request.prompt,
          baseEnv: request.baseEnv,
        }),
      }
    },
    completeJob(request: {
      tenantID: string
      jobID: string
      manifest: unknown
      objectKeyPrefix: string
      sizeByPath: Record<string, number>
    }) {
      const job = input.store.updateJobStatus({
        tenantID: request.tenantID,
        id: request.jobID,
        status: "uploading",
        now: input.now(),
      })
      appendStatus({ store: input.store, job })

      const artifacts = CloudArtifact.decodeManifestForJob(job.id, request.manifest).artifacts.map((item, index) =>
        input.store.putArtifact({
          id: `${job.id}:artifact:${(index + 1).toString().padStart(12, "0")}`,
          tenantID: job.tenantID,
          workspaceID: job.workspaceID,
          sessionID: job.sessionID,
          jobID: job.id,
          name: item.name,
          kind: item.kind,
          mime: item.mime,
          size: request.sizeByPath[item.path] ?? 0,
          objectKey: `${request.objectKeyPrefix.replace(/\/+$/, "")}/${item.path}`,
          sha256: item.sha256,
          time: {
            created: input.now(),
            updated: input.now(),
          },
        }),
      )
      artifacts.map((artifact) =>
        input.store.appendEvent(
          CloudEvent.artifact({
            jobID: job.id,
            sequence: nextSequence({ store: input.store, jobID: job.id }),
            artifactID: artifact.id,
            name: artifact.name,
            kind: artifact.kind,
            time: artifact.time.created,
          }),
        ),
      )

      const completed = input.store.updateJobStatus({
        tenantID: request.tenantID,
        id: request.jobID,
        status: "succeeded",
        now: input.now(),
      })
      const attempt = runningAttempt({ store: input.store, tenantID: request.tenantID, jobID: request.jobID })
      if (attempt) input.store.putAttempt(CloudAttempt.complete({ attempt, now: input.now() }))
      appendStatus({ store: input.store, job: completed })

      return {
        job: completed,
        artifacts,
      }
    },
    failJob(request: { tenantID: string; jobID: string; message: string }) {
      const job = input.store.getJob({ tenantID: request.tenantID, id: request.jobID })
      if (!job) throw new Error("Cloud job not found")
      input.store.appendEvent(
        CloudEvent.error({
          jobID: job.id,
          sequence: nextSequence({ store: input.store, jobID: job.id }),
          message: request.message,
          time: input.now(),
        }),
      )
      const failed = input.store.putJob({
        ...input.store.updateJobStatus({
          tenantID: request.tenantID,
          id: request.jobID,
          status: "failed",
          now: input.now(),
        }),
        error: request.message,
      })
      const attempt = runningAttempt({ store: input.store, tenantID: request.tenantID, jobID: request.jobID })
      if (attempt) input.store.putAttempt(CloudAttempt.fail({ attempt, now: input.now(), error: request.message }))
      appendStatus({ store: input.store, job: failed })
      return failed
    },
    heartbeat(request: { jobID: string }) {
      const lease = input.store.getLease({ jobID: request.jobID })
      if (!lease) throw new Error("Cloud job lease not found")
      const updated = input.store.putLease(
        CloudLease.heartbeat({
          lease,
          workerID: input.workerID,
          now: input.now(),
          ttlMS: input.leaseTTLMS,
        }),
      )
      input.store.appendEvent(
        CloudEvent.heartbeat({
          jobID: request.jobID,
          sequence: nextSequence({ store: input.store, jobID: request.jobID }),
          time: updated.heartbeatAt,
        }),
      )
      return updated
    },
    cancelJob(request: { tenantID: string; jobID: string }) {
      const job = input.store.updateJobStatus({
        tenantID: request.tenantID,
        id: request.jobID,
        status: "canceled",
        now: input.now(),
      })
      const attempt = runningAttempt({ store: input.store, tenantID: request.tenantID, jobID: request.jobID })
      if (attempt) input.store.putAttempt(CloudAttempt.cancel({ attempt, now: input.now() }))
      appendStatus({ store: input.store, job })
      return job
    },
    expireJob(request: { tenantID: string; jobID: string }) {
      const lease = input.store.getLease({ jobID: request.jobID })
      if (lease && lease.expiresAt > input.now()) throw new Error("Cloud job lease is still active")
      const job = input.store.updateJobStatus({
        tenantID: request.tenantID,
        id: request.jobID,
        status: "expired",
        now: input.now(),
      })
      appendStatus({ store: input.store, job })
      return job
    },
  }
}

export * as CloudWorkerService from "./worker-service"
