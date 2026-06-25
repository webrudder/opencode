import type { Database } from "bun:sqlite"
import { CloudAttempt } from "./attempt"
import { CloudArtifact } from "./artifact"
import { CloudDatabaseAdapter } from "./database-adapter"
import { CloudEvent } from "./event"
import { CloudLease } from "./lease"
import { CloudQueue } from "./queue"
import { CloudRepository } from "./repository"
import { CloudSchema } from "./schema"
import { CloudSQLiteRepository } from "./sqlite-repository"
import { CloudSQLiteRunner } from "./sqlite-runner"
import { CloudWorker } from "./worker"
import { CloudWorkerRunner } from "./worker-runner"

function nextSequence(input: { db: Database; jobID: string }) {
  return CloudSQLiteRepository.listEvents({ db: input.db, jobID: input.jobID }).length + 1
}

function attemptCount(input: { db: Database; jobID: string }) {
  return (
    input.db.query("select count(*) as count from cloud_job_attempt where job_id = ?").get(input.jobID) as {
      count: number
    }
  ).count
}

function runningAttemptID(input: { db: Database; jobID: string }) {
  const row = input.db
    .query("select id from cloud_job_attempt where job_id = ? and status = 'running' order by attempt desc limit 1")
    .get(input.jobID) as { id: string } | null
  return row?.id
}

function sequence(input: { event: ReturnType<typeof CloudEvent.status> }) {
  return Number(input.event.id.slice(input.event.jobID.length + 1))
}

export function tick(input: {
  db: Database
  tenantID: string
  workerID: string
  leaseTTLMS: number
  now: () => number
  sandboxRoot: string
  bucket: string
  namespace: string
  baseEnv?: Record<string, string | undefined>
}) {
  const job = CloudSQLiteRepository.listQueuedJobs({ db: input.db, tenantID: input.tenantID })[0]
  if (!job) return { status: "idle" as const }
  const spec = CloudSQLiteRepository.getJobSpec({ db: input.db, tenantID: input.tenantID, id: job.id })
  if (!spec) throw new Error("Cloud SQLite worker loop job spec not found")
  const prompt = CloudSQLiteRepository.getJobPrompt({ db: input.db, tenantID: input.tenantID, jobID: job.id })?.prompt ?? ""
  const result = CloudLease.leaseJob({
    job,
    lease: CloudSQLiteRepository.getLease({ db: input.db, jobID: job.id }),
    workerID: input.workerID,
    now: input.now(),
    ttlMS: input.leaseTTLMS,
  })
  const attemptNumber = attemptCount({ db: input.db, jobID: job.id }) + 1
  const attempt = CloudAttempt.start({
    job: result.job,
    workerID: input.workerID,
    attempt: attemptNumber,
    reason: attemptNumber === 1 ? "initial" : "retry",
    now: input.now(),
  })
  const event = CloudEvent.status({
    jobID: result.job.id,
    sequence: nextSequence({ db: input.db, jobID: result.job.id }),
    status: result.job.status,
    time: result.job.time.updated,
  })

  CloudSQLiteRunner.run({
    db: input.db,
    operations: CloudDatabaseAdapter.transaction({
      mutations: [
        {
          action: "update",
          table: "cloud_job",
          key: { id: result.job.id, tenant_id: result.job.tenantID },
          values: {
            status: result.job.status,
            time_updated: result.job.time.updated,
          },
        },
        {
          action: "insert",
          table: "cloud_job_lease",
          key: { job_id: result.lease.jobID },
          values: {
            job_id: result.lease.jobID,
            worker_id: result.lease.workerID,
            expires_at: result.lease.expiresAt,
            heartbeat_at: result.lease.heartbeatAt,
          },
        },
        {
          action: "insert",
          table: "cloud_job_attempt",
          key: { id: attempt.id },
          values: {
            id: attempt.id,
            tenant_id: attempt.tenantID,
            workspace_id: attempt.workspaceID,
            session_id: attempt.sessionID,
            job_id: attempt.jobID,
            worker_id: attempt.workerID,
            attempt: attempt.attempt,
            reason: attempt.reason,
            runtime: attempt.runtime,
            status: attempt.status,
            error: attempt.error,
            time_created: attempt.time.created,
            time_updated: attempt.time.updated,
          },
        },
        {
          action: "insert",
          table: "cloud_job_event",
          key: { id: event.id },
          values: {
            id: event.id,
            job_id: event.jobID,
            sequence: Number(event.id.slice(event.jobID.length + 1)),
            type: event.type,
            data: event.data,
            time_created: event.time,
          },
        },
      ],
    }),
  })

  const launch = CloudWorker.launchPlan(spec, {
    workdir: `${input.sandboxRoot.replace(/\/+$/, "")}/${job.id}/work`,
    prompt,
    baseEnv: input.baseEnv,
  })

  return {
    status: "started" as const,
    jobID: job.id,
    lease: result.lease,
    attempt,
    launch,
    runner: CloudWorkerRunner.start({
      tenantID: input.tenantID,
      jobID: job.id,
      workerID: input.workerID,
      leaseTTLMS: input.leaseTTLMS,
      bucket: input.bucket,
      namespace: input.namespace,
      launch,
      profile: spec.runtime.profile,
      stagedInputs: [],
      mutations: [],
      now: input.now(),
    }),
  }
}

export function heartbeat(input: {
  db: Database
  workerID: string
  leaseTTLMS: number
  now: () => number
  jobID: string
}) {
  const lease = CloudSQLiteRepository.getLease({ db: input.db, jobID: input.jobID })
  if (!lease) throw new Error("Cloud job lease not found")
  const updated = CloudLease.heartbeat({
    lease,
    workerID: input.workerID,
    now: input.now(),
    ttlMS: input.leaseTTLMS,
  })
  const event = CloudEvent.heartbeat({
    jobID: input.jobID,
    sequence: nextSequence({ db: input.db, jobID: input.jobID }),
    time: updated.heartbeatAt,
  })

  CloudSQLiteRunner.run({
    db: input.db,
    operations: CloudDatabaseAdapter.transaction({
      mutations: [
        {
          action: "update",
          table: "cloud_job_lease",
          key: { job_id: updated.jobID },
          values: {
            worker_id: updated.workerID,
            expires_at: updated.expiresAt,
            heartbeat_at: updated.heartbeatAt,
          },
        },
        {
          action: "insert",
          table: "cloud_job_event",
          key: { id: event.id },
          values: {
            id: event.id,
            job_id: event.jobID,
            sequence: Number(event.id.slice(event.jobID.length + 1)),
            type: event.type,
            data: event.data,
            time_created: event.time,
          },
        },
      ],
    }),
  })

  return updated
}

export function completeJob(input: {
  db: Database
  tenantID: string
  jobID: string
  now: () => number
  manifest: unknown
  objectKeyPrefix: string
  sizeByPath: Record<string, number>
}) {
  const job = CloudSQLiteRepository.getJob({ db: input.db, tenantID: input.tenantID, id: input.jobID })
  if (!job) throw new Error("Cloud job not found")
  const manifest = CloudArtifact.decodeManifestForJob(job.id, input.manifest)
  const start = nextSequence({ db: input.db, jobID: job.id })
  const statusEvents = [
    CloudEvent.status({ jobID: job.id, sequence: start, status: "starting", time: input.now() }),
    CloudEvent.status({ jobID: job.id, sequence: start + 1, status: "running", time: input.now() }),
    CloudEvent.status({ jobID: job.id, sequence: start + 2, status: "uploading", time: input.now() }),
  ]
  const artifacts = manifest.artifacts.map((item, index) =>
    CloudSchema.decodeArtifact({
      id: `${job.id}:artifact:${(index + 1).toString().padStart(12, "0")}`,
      tenantID: job.tenantID,
      workspaceID: job.workspaceID,
      sessionID: job.sessionID,
      jobID: job.id,
      name: item.name,
      kind: item.kind,
      mime: item.mime,
      size: input.sizeByPath[item.path] ?? 0,
      objectKey: `${input.objectKeyPrefix.replace(/\/+$/, "")}/${item.path}`,
      sha256: item.sha256,
      time: {
        created: input.now(),
        updated: input.now(),
      },
    }),
  )
  const artifactEvents = artifacts.map((artifact, index) =>
    CloudEvent.artifact({
      jobID: job.id,
      sequence: start + 3 + index,
      artifactID: artifact.id,
      name: artifact.name,
      kind: artifact.kind,
      time: artifact.time.created,
    }),
  )
  const succeeded = {
    ...job,
    status: "succeeded" as const,
    time: {
      ...job.time,
      updated: input.now(),
    },
  }
  const completed = CloudEvent.status({
    jobID: job.id,
    sequence: start + 3 + artifactEvents.length,
    status: "succeeded",
    time: input.now(),
  })
  const attemptID = runningAttemptID({ db: input.db, jobID: job.id })

  CloudSQLiteRunner.run({
    db: input.db,
    operations: CloudDatabaseAdapter.transaction({
      mutations: [
        {
          action: "update",
          table: "cloud_job",
          key: { id: job.id, tenant_id: job.tenantID },
          values: {
            status: succeeded.status,
            time_updated: succeeded.time.updated,
          },
        },
        ...(attemptID
          ? [
              {
                action: "update" as const,
                table: "cloud_job_attempt",
                key: { id: attemptID },
                values: {
                  status: "succeeded",
                  time_updated: input.now(),
                },
              },
            ]
          : []),
        ...artifacts.map((artifact) => ({
          action: "insert" as const,
          table: "cloud_artifact",
          key: { id: artifact.id },
          values: CloudRepository.artifactRow(artifact),
        })),
        ...[...statusEvents, ...artifactEvents, completed].map((event) => ({
          action: "insert" as const,
          table: "cloud_job_event",
          key: { id: event.id },
          values: {
            id: event.id,
            job_id: event.jobID,
            sequence: sequence({ event }),
            type: event.type,
            data: event.data,
            time_created: event.time,
          },
        })),
        {
          action: "delete",
          table: "cloud_job_lease",
          key: { job_id: job.id },
        },
      ],
    }),
  })

  return {
    job: succeeded,
    artifacts,
  }
}

export function failJob(input: {
  db: Database
  tenantID: string
  jobID: string
  message: string
  now: () => number
  retry?: {
    maxAttempts: number
    baseDelayMS: number
    maxDelayMS: number
  }
}) {
  const job = CloudSQLiteRepository.getJob({ db: input.db, tenantID: input.tenantID, id: input.jobID })
  if (!job) throw new Error("Cloud job not found")
  const start = nextSequence({ db: input.db, jobID: job.id })
  const error = CloudEvent.error({ jobID: job.id, sequence: start, message: input.message, time: input.now() })
  const failedForRetry = {
    ...job,
    status: "failed" as const,
    error: input.message,
    time: {
      ...job.time,
      updated: input.now(),
    },
  }
  const retry = input.retry
    ? CloudQueue.retry({
        job: failedForRetry,
        attempts: attemptCount({ db: input.db, jobID: job.id }),
        maxAttempts: input.retry.maxAttempts,
        now: failedForRetry.time.updated,
        baseDelayMS: input.retry.baseDelayMS,
        maxDelayMS: input.retry.maxDelayMS,
      })
    : undefined
  const failed = {
    ...failedForRetry,
    status: retry?.allowed ? ("queued" as const) : ("failed" as const),
  }
  const status = CloudEvent.status({ jobID: job.id, sequence: start + 1, status: failed.status, time: input.now() })
  const attemptID = runningAttemptID({ db: input.db, jobID: job.id })

  CloudSQLiteRunner.run({
    db: input.db,
    operations: CloudDatabaseAdapter.transaction({
      mutations: [
        {
          action: "update",
          table: "cloud_job",
          key: { id: job.id, tenant_id: job.tenantID },
          values: {
            status: failed.status,
            error: failed.error,
            time_updated: failed.time.updated,
          },
        },
        ...(attemptID
          ? [
              {
                action: "update" as const,
                table: "cloud_job_attempt",
                key: { id: attemptID },
                values: {
                  status: "failed",
                  error: input.message,
                  time_updated: input.now(),
                },
              },
            ]
          : []),
        ...[error, status].map((event) => ({
          action: "insert" as const,
          table: "cloud_job_event",
          key: { id: event.id },
          values: {
            id: event.id,
            job_id: event.jobID,
            sequence: sequence({ event }),
            type: event.type,
            data: event.data,
            time_created: event.time,
          },
        })),
        {
          action: "delete",
          table: "cloud_job_lease",
          key: { job_id: job.id },
        },
      ],
    }),
  })

  return failed
}

export function expireJob(input: {
  db: Database
  tenantID: string
  jobID: string
  message: string
  now: () => number
}) {
  const job = CloudSQLiteRepository.getJob({ db: input.db, tenantID: input.tenantID, id: input.jobID })
  if (!job) throw new Error("Cloud job not found")
  const expired = {
    ...job,
    status: "expired" as const,
    error: input.message,
    time: {
      ...job.time,
      updated: input.now(),
    },
  }
  const event = CloudEvent.status({
    jobID: job.id,
    sequence: nextSequence({ db: input.db, jobID: job.id }),
    status: expired.status,
    time: expired.time.updated,
  })
  const attemptID = runningAttemptID({ db: input.db, jobID: job.id })

  CloudSQLiteRunner.run({
    db: input.db,
    operations: CloudDatabaseAdapter.transaction({
      mutations: [
        {
          action: "update",
          table: "cloud_job",
          key: { id: job.id, tenant_id: job.tenantID },
          values: {
            status: expired.status,
            error: expired.error,
            time_updated: expired.time.updated,
          },
        },
        ...(attemptID
          ? [
              {
                action: "update" as const,
                table: "cloud_job_attempt",
                key: { id: attemptID },
                values: {
                  status: "failed",
                  error: input.message,
                  time_updated: input.now(),
                },
              },
            ]
          : []),
        {
          action: "insert" as const,
          table: "cloud_job_event",
          key: { id: event.id },
          values: {
            id: event.id,
            job_id: event.jobID,
            sequence: sequence({ event }),
            type: event.type,
            data: event.data,
            time_created: event.time,
          },
        },
        {
          action: "delete" as const,
          table: "cloud_job_lease",
          key: { job_id: job.id },
        },
      ],
    }),
  })

  return expired
}

export function cancelJob(input: {
  db: Database
  tenantID: string
  jobID: string
  message: string
  now: () => number
}) {
  const job = CloudSQLiteRepository.getJob({ db: input.db, tenantID: input.tenantID, id: input.jobID })
  if (!job) throw new Error("Cloud job not found")
  const canceled = {
    ...job,
    status: "canceled" as const,
    error: job.error ?? input.message,
    time: {
      ...job.time,
      updated: input.now(),
    },
  }
  const event = CloudEvent.status({
    jobID: job.id,
    sequence: nextSequence({ db: input.db, jobID: job.id }),
    status: canceled.status,
    time: canceled.time.updated,
  })
  const attemptID = runningAttemptID({ db: input.db, jobID: job.id })

  CloudSQLiteRunner.run({
    db: input.db,
    operations: CloudDatabaseAdapter.transaction({
      mutations: [
        {
          action: "update",
          table: "cloud_job",
          key: { id: job.id, tenant_id: job.tenantID },
          values: {
            status: canceled.status,
            error: canceled.error,
            time_updated: canceled.time.updated,
          },
        },
        ...(attemptID
          ? [
              {
                action: "update" as const,
                table: "cloud_job_attempt",
                key: { id: attemptID },
                values: {
                  status: "canceled",
                  error: canceled.error,
                  time_updated: input.now(),
                },
              },
            ]
          : []),
        {
          action: "insert" as const,
          table: "cloud_job_event",
          key: { id: event.id },
          values: {
            id: event.id,
            job_id: event.jobID,
            sequence: sequence({ event }),
            type: event.type,
            data: event.data,
            time_created: event.time,
          },
        },
        {
          action: "delete" as const,
          table: "cloud_job_lease",
          key: { job_id: job.id },
        },
      ],
    }),
  })

  return canceled
}

export * as CloudSQLiteWorkerLoop from "./sqlite-worker-loop"
