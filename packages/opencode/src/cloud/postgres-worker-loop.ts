import { CloudAttempt } from "./attempt"
import { CloudArtifact } from "./artifact"
import type { Manifest } from "./artifact"
import { CloudDatabaseAdapter } from "./database-adapter"
import { CloudEvent } from "./event"
import { CloudLease } from "./lease"
import { CloudPostgresRepository } from "./postgres-repository"
import { CloudPostgresRunner, type QueryClient } from "./postgres-runner"
import { CloudQueue } from "./queue"
import { CloudQueueAdapter } from "./queue-adapter"
import { CloudQueueRunner, type Client as QueueClient } from "./queue-runner"
import { CloudRepository } from "./repository"
import { CloudSchema } from "./schema"
import { CloudWorker } from "./worker"
import { CloudWorkerRunner } from "./worker-runner"

type KubernetesResult = Awaited<ReturnType<typeof CloudWorkerRunner.runSandbox>> & {
  manifest?: Manifest
  sizeByPath?: Record<string, number>
}

async function nextSequence(input: { client: QueryClient; jobID: string }) {
  return (await CloudPostgresRepository.listEvents({ client: input.client, jobID: input.jobID })).length + 1
}

async function attemptCount(input: { client: QueryClient; jobID: string }) {
  const result = await input.client.query("select count(*) as count from cloud_job_attempt where job_id = $1", [input.jobID])
  if (Array.isArray(result)) return Number(result.at(0)?.count ?? 0)
  return Number(result.rows?.at(0)?.count ?? 0)
}

async function runningAttemptID(input: { client: QueryClient; jobID: string }) {
  const result = await input.client.query(
    "select id from cloud_job_attempt where job_id = $1 and status = 'running' order by attempt desc limit 1",
    [input.jobID],
  )
  if (Array.isArray(result)) return result.at(0)?.id
  return result.rows?.at(0)?.id
}

function sequence(input: { event: ReturnType<typeof CloudEvent.status> }) {
  return Number(input.event.id.slice(input.event.jobID.length + 1))
}

async function leaseQueue(input: {
  queueClient?: QueueClient
  tenantID: string
  job: CloudSchema.Job
  workerID: string
  leaseTTLMS: number
}) {
  if (!input.queueClient) return undefined
  return (
    await CloudQueueRunner.run({
      client: input.queueClient,
      operations: [
        CloudQueueAdapter.lease({
          tenantID: input.tenantID,
          jobID: input.job.id,
          workerID: input.workerID,
          leaseTTLMS: input.leaseTTLMS,
          profile: input.job.runtime.profile,
        }),
      ],
    })
  ).leases[0]
}

async function ackQueue(input: {
  queueClient?: QueueClient
  jobID: string
  workerID?: string
  terminalStatus: "succeeded" | "failed" | "expired" | "canceled"
  time: number
}) {
  if (!input.queueClient || !input.workerID) return
  await CloudQueueRunner.run({
    client: input.queueClient,
    operations: [
      CloudQueueAdapter.ack({
        jobID: input.jobID,
        workerID: input.workerID,
        terminalStatus: input.terminalStatus,
        time: input.time,
      }),
    ],
  })
}

async function heartbeatQueue(input: {
  queueClient?: QueueClient
  jobID: string
  workerID: string
  leaseTTLMS: number
  time: number
}) {
  if (!input.queueClient) return
  await CloudQueueRunner.run({
    client: input.queueClient,
    operations: [
      CloudQueueAdapter.heartbeat({
        jobID: input.jobID,
        workerID: input.workerID,
        leaseTTLMS: input.leaseTTLMS,
        time: input.time,
      }),
    ],
  })
}

async function finishFailedQueue(input: {
  queueClient?: QueueClient
  job: CloudSchema.Job
  workerID?: string
  attempts: number
  message: string
  time: number
  retry?: {
    maxAttempts: number
    baseDelayMS: number
    maxDelayMS: number
  }
}) {
  if (!input.queueClient) return
  if (input.retry) {
    const retry = CloudQueue.retry({
      job: input.job,
      attempts: input.attempts,
      maxAttempts: input.retry.maxAttempts,
      now: input.time,
      baseDelayMS: input.retry.baseDelayMS,
      maxDelayMS: input.retry.maxDelayMS,
    })
    if (retry.allowed && retry.retryAt) {
      await CloudQueueRunner.run({
        client: input.queueClient,
        operations: [
          CloudQueueAdapter.retry({
            tenantID: input.job.tenantID,
            jobID: input.job.id,
            runAt: retry.retryAt,
            attempt: retry.nextAttempt,
            reason: input.message,
            profile: input.job.runtime.profile,
          }),
        ],
      })
      return
    }
  }
  await ackQueue({
    queueClient: input.queueClient,
    jobID: input.job.id,
    workerID: input.workerID,
    terminalStatus: "failed",
    time: input.time,
  })
}

export async function tick(input: {
  client: QueryClient
  tenantID: string
  workerID: string
  leaseTTLMS: number
  now: () => number
  sandboxRoot: string
  bucket: string
  namespace: string
  baseEnv?: Record<string, string | undefined>
  queueClient?: QueueClient
}) {
  const job = (
    await Promise.all(
      (await CloudPostgresRepository.listQueuedJobs({ client: input.client, tenantID: input.tenantID })).map(async (item) => ({
        job: item,
        busy: await CloudPostgresRepository.hasRunningSessionAttempt({
          client: input.client,
          tenantID: input.tenantID,
          sessionID: item.sessionID,
        }),
      })),
    )
  ).find((item) => !item.busy)?.job
  if (!job) return { status: "idle" as const }
  const queueLease = await leaseQueue({
    queueClient: input.queueClient,
    tenantID: input.tenantID,
    job,
    workerID: input.workerID,
    leaseTTLMS: input.leaseTTLMS,
  })
  if (queueLease && !queueLease.leased) return { status: "idle" as const, reason: `queue:${queueLease.reason ?? "not_leased"}` }
  const spec = await CloudPostgresRepository.getJobSpec({ client: input.client, tenantID: input.tenantID, id: job.id })
  if (!spec) throw new Error("Cloud PostgreSQL worker loop job spec not found")
  const prompt = (await CloudPostgresRepository.getJobPrompt({ client: input.client, tenantID: input.tenantID, jobID: job.id }))?.prompt ?? ""
  const result = CloudLease.leaseJob({
    job,
    lease: await CloudPostgresRepository.getLease({ client: input.client, jobID: job.id }),
    workerID: input.workerID,
    now: input.now(),
    ttlMS: input.leaseTTLMS,
  })
  const attemptNumber = (await attemptCount({ client: input.client, jobID: job.id })) + 1
  const attempt = CloudAttempt.start({
    job: result.job,
    workerID: input.workerID,
    attempt: attemptNumber,
    reason: attemptNumber === 1 ? "initial" : "retry",
    now: input.now(),
  })
  const event = CloudEvent.status({
    jobID: result.job.id,
    sequence: await nextSequence({ client: input.client, jobID: result.job.id }),
    status: result.job.status,
    time: result.job.time.updated,
  })

  await CloudPostgresRunner.run({
    client: input.client,
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
            sequence: sequence({ event }),
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

export async function heartbeat(input: {
  client: QueryClient
  workerID: string
  leaseTTLMS: number
  now: () => number
  jobID: string
  queueClient?: QueueClient
}) {
  const lease = await CloudPostgresRepository.getLease({ client: input.client, jobID: input.jobID })
  if (!lease) throw new Error("Cloud job lease not found")
  const updated = CloudLease.heartbeat({
    lease,
    workerID: input.workerID,
    now: input.now(),
    ttlMS: input.leaseTTLMS,
  })
  const event = CloudEvent.heartbeat({
    jobID: input.jobID,
    sequence: await nextSequence({ client: input.client, jobID: input.jobID }),
    time: updated.heartbeatAt,
  })

  await CloudPostgresRunner.run({
    client: input.client,
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
            sequence: sequence({ event }),
            type: event.type,
            data: event.data,
            time_created: event.time,
          },
        },
      ],
    }),
  })
  await heartbeatQueue({
    queueClient: input.queueClient,
    jobID: input.jobID,
    workerID: input.workerID,
    leaseTTLMS: input.leaseTTLMS,
    time: updated.heartbeatAt,
  })

  return updated
}

export async function completeJob(input: {
  client: QueryClient
  tenantID: string
  jobID: string
  now: () => number
  manifest: unknown
  objectKeyPrefix: string
  sizeByPath: Record<string, number>
  workerID?: string
  queueClient?: QueueClient
}) {
  const job = await CloudPostgresRepository.getJob({ client: input.client, tenantID: input.tenantID, id: input.jobID })
  if (!job) throw new Error("Cloud job not found")
  const manifest = CloudArtifact.decodeManifestForJob(job.id, input.manifest)
  const start = await nextSequence({ client: input.client, jobID: job.id })
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
  const attemptID = await runningAttemptID({ client: input.client, jobID: job.id })

  await CloudPostgresRunner.run({
    client: input.client,
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
                key: { id: `${attemptID}` },
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
          values: CloudRepository.eventRow(event),
        })),
        {
          action: "delete" as const,
          table: "cloud_job_lease",
          key: { job_id: job.id },
        },
      ],
    }),
  })
  await ackQueue({
    queueClient: input.queueClient,
    jobID: job.id,
    workerID: input.workerID,
    terminalStatus: "succeeded",
    time: succeeded.time.updated,
  })

  return {
    job: succeeded,
    artifacts,
  }
}

export async function completeKubernetesRun(input: {
  client: QueryClient
  tenantID: string
  jobID: string
  now: () => number
  objectKeyPrefix: string
  result: KubernetesResult
  workerID?: string
  queueClient?: QueueClient
  retry?: {
    maxAttempts: number
    baseDelayMS: number
    maxDelayMS: number
  }
}) {
  if (input.result.status === "succeeded") {
    const completed = await completeJob({
      client: input.client,
      tenantID: input.tenantID,
      jobID: input.jobID,
      now: input.now,
      manifest: input.result.manifest ?? {
        version: 1,
        jobID: input.jobID,
        artifacts: [],
      },
      objectKeyPrefix: input.objectKeyPrefix,
      sizeByPath: input.result.sizeByPath ?? {},
      workerID: input.workerID,
      queueClient: input.queueClient,
    })
    return {
      status: "completed" as const,
      jobID: input.jobID,
      completed,
    }
  }
  if (input.result.status === "expired") {
    const expired = await expireJob({
      client: input.client,
      tenantID: input.tenantID,
      jobID: input.jobID,
      message: `Kubernetes sandbox ${input.result.podName} expired: ${input.result.logs}`.trim(),
      now: input.now,
      workerID: input.workerID,
      queueClient: input.queueClient,
    })
    return {
      status: "expired" as const,
      jobID: input.jobID,
      expired,
    }
  }
  const failed = await failJob({
    client: input.client,
    tenantID: input.tenantID,
    jobID: input.jobID,
    message: `Kubernetes sandbox ${input.result.podName} failed: ${input.result.logs}`.trim(),
    now: input.now,
    workerID: input.workerID,
    queueClient: input.queueClient,
    retry: input.retry,
  })
  return {
    status: "failed" as const,
    jobID: input.jobID,
    failed,
  }
}

export async function failJob(input: {
  client: QueryClient
  tenantID: string
  jobID: string
  message: string
  now: () => number
  workerID?: string
  queueClient?: QueueClient
  retry?: {
    maxAttempts: number
    baseDelayMS: number
    maxDelayMS: number
  }
}) {
  const job = await CloudPostgresRepository.getJob({ client: input.client, tenantID: input.tenantID, id: input.jobID })
  if (!job) throw new Error("Cloud job not found")
  const start = await nextSequence({ client: input.client, jobID: job.id })
  const error = CloudEvent.error({ jobID: job.id, sequence: start, message: input.message, time: input.now() })
  const attempts = await attemptCount({ client: input.client, jobID: job.id })
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
        attempts,
        maxAttempts: input.retry.maxAttempts,
        now: failedForRetry.time.updated,
        baseDelayMS: input.retry.baseDelayMS,
        maxDelayMS: input.retry.maxDelayMS,
      })
    : undefined
  const finalStatus = retry?.allowed ? "queued" : "failed"
  const status = CloudEvent.status({ jobID: job.id, sequence: start + 1, status: finalStatus, time: input.now() })
  const failed = {
    ...job,
    status: finalStatus,
    error: input.message,
    time: {
      ...job.time,
      updated: input.now(),
    },
  }
  const attemptID = await runningAttemptID({ client: input.client, jobID: job.id })

  await CloudPostgresRunner.run({
    client: input.client,
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
                key: { id: `${attemptID}` },
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
          values: CloudRepository.eventRow(event),
        })),
        {
          action: "delete" as const,
          table: "cloud_job_lease",
          key: { job_id: job.id },
        },
      ],
    }),
  })
  await finishFailedQueue({
    queueClient: input.queueClient,
    job: failedForRetry,
    workerID: input.workerID,
    attempts,
    message: input.message,
    time: failed.time.updated,
    retry: input.retry,
  })

  return failed
}

export async function expireJob(input: {
  client: QueryClient
  tenantID: string
  jobID: string
  message: string
  now: () => number
  workerID?: string
  queueClient?: QueueClient
}) {
  const job = await CloudPostgresRepository.getJob({ client: input.client, tenantID: input.tenantID, id: input.jobID })
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
    sequence: await nextSequence({ client: input.client, jobID: job.id }),
    status: expired.status,
    time: expired.time.updated,
  })
  const attemptID = await runningAttemptID({ client: input.client, jobID: job.id })

  await CloudPostgresRunner.run({
    client: input.client,
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
                key: { id: `${attemptID}` },
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
          values: CloudRepository.eventRow(event),
        },
        {
          action: "delete" as const,
          table: "cloud_job_lease",
          key: { job_id: job.id },
        },
      ],
    }),
  })
  await ackQueue({
    queueClient: input.queueClient,
    jobID: job.id,
    workerID: input.workerID,
    terminalStatus: "expired",
    time: expired.time.updated,
  })

  return expired
}

export async function cancelJob(input: {
  client: QueryClient
  tenantID: string
  jobID: string
  message: string
  now: () => number
  workerID?: string
  queueClient?: QueueClient
}) {
  const job = await CloudPostgresRepository.getJob({ client: input.client, tenantID: input.tenantID, id: input.jobID })
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
    sequence: await nextSequence({ client: input.client, jobID: job.id }),
    status: canceled.status,
    time: canceled.time.updated,
  })
  const attemptID = await runningAttemptID({ client: input.client, jobID: job.id })

  await CloudPostgresRunner.run({
    client: input.client,
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
                key: { id: `${attemptID}` },
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
          values: CloudRepository.eventRow(event),
        },
        {
          action: "delete" as const,
          table: "cloud_job_lease",
          key: { job_id: job.id },
        },
      ],
    }),
  })
  await ackQueue({
    queueClient: input.queueClient,
    jobID: job.id,
    workerID: input.workerID,
    terminalStatus: "canceled",
    time: canceled.time.updated,
  })

  return canceled
}

export * as CloudPostgresWorkerLoop from "./postgres-worker-loop"
