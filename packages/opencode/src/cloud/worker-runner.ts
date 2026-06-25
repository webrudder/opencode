import { CloudDatabaseAdapter } from "./database-adapter"
import { CloudKubernetesExecutor } from "./kubernetes-executor"
import { CloudObjectStorageAdapter } from "./object-storage-adapter"
import { CloudQueueAdapter } from "./queue-adapter"
import type { CloudRepository } from "./repository"
import type { CloudWorker } from "./worker"

export function start(input: {
  tenantID: string
  jobID: string
  workerID: string
  leaseTTLMS: number
  bucket: string
  namespace: string
  launch: CloudWorker.LaunchPlan
  profile?: string
  stagedInputs: Array<{ objectKey: string; sandboxPath: string }>
  mutations: CloudRepository.Mutation[]
  now: number
}) {
  return {
    jobID: input.jobID,
    workerID: input.workerID,
    queue: CloudQueueAdapter.lease({
      tenantID: input.tenantID,
      jobID: input.jobID,
      workerID: input.workerID,
      leaseTTLMS: input.leaseTTLMS,
      profile: input.profile,
    }),
    database: CloudDatabaseAdapter.transaction({ mutations: input.mutations }),
    storage: CloudObjectStorageAdapter.stageInputs({ bucket: input.bucket, inputs: input.stagedInputs }),
    kubernetes: CloudKubernetesExecutor.start({
      namespace: input.namespace,
      launch: input.launch,
    }),
    heartbeat: CloudQueueAdapter.heartbeat({
      jobID: input.jobID,
      workerID: input.workerID,
      leaseTTLMS: input.leaseTTLMS,
      time: input.now,
    }),
  }
}

export function finish(input: {
  tenantID: string
  workspaceID: string
  sessionID: string
  jobID: string
  workerID: string
  bucket: string
  namespace: string
  status: "succeeded" | "failed" | "canceled" | "expired"
  artifactUploads: Array<{ objectKey: string; contentType?: string; contentLength: number; sha256?: string }>
  mutations: CloudRepository.Mutation[]
  now: number
}) {
  return {
    jobID: input.jobID,
    workerID: input.workerID,
    storage: input.artifactUploads.map((artifact) =>
      CloudObjectStorageAdapter.putArtifact({
        bucket: input.bucket,
        tenantID: input.tenantID,
        workspaceID: input.workspaceID,
        sessionID: input.sessionID,
        jobID: input.jobID,
        objectKey: artifact.objectKey,
        contentType: artifact.contentType,
        contentLength: artifact.contentLength,
        sha256: artifact.sha256,
      }),
    ),
    database: CloudDatabaseAdapter.transaction({ mutations: input.mutations }),
    queue: CloudQueueAdapter.ack({
      jobID: input.jobID,
      workerID: input.workerID,
      terminalStatus: input.status,
      time: input.now,
    }),
    logs: CloudKubernetesExecutor.logs({ namespace: input.namespace, jobID: input.jobID }),
    cleanup: CloudKubernetesExecutor.stop({ namespace: input.namespace, jobID: input.jobID }),
  }
}

export function recover(input: {
  tenantID: string
  jobID: string
  workerID: string
  namespace: string
  leaseTTLMS: number
  retryAt: number
  attempt: number
  reason: string
  mutations: CloudRepository.Mutation[]
}) {
  return {
    jobID: input.jobID,
    workerID: input.workerID,
    cleanup: CloudKubernetesExecutor.stop({ namespace: input.namespace, jobID: input.jobID, gracePeriodSeconds: 0 }),
    database: CloudDatabaseAdapter.transaction({ mutations: input.mutations }),
    queue: CloudQueueAdapter.retry({
      tenantID: input.tenantID,
      jobID: input.jobID,
      runAt: input.retryAt,
      attempt: input.attempt,
      reason: input.reason,
    }),
  }
}

export async function runSandbox(input: {
  namespace: string
  launch: CloudWorker.LaunchPlan
  kubernetes: CloudKubernetesExecutor.Client
  serviceAccountName?: string
  labels?: Record<string, string>
}) {
  return CloudKubernetesExecutor.runSandbox({
    namespace: input.namespace,
    launch: input.launch,
    client: input.kubernetes,
    serviceAccountName: input.serviceAccountName,
    labels: input.labels,
  })
}

export * as CloudWorkerRunner from "./worker-runner"
