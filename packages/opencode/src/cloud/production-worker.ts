import { CloudS3StorageRunner } from "./s3-storage-runner"
import { CloudPostgresWorkerLoop } from "./postgres-worker-loop"
import type { QueryClient } from "./postgres-runner"
import type { CloudQueueRunner } from "./queue-runner"
import { CloudStorageService } from "./storage-service"
import type { CloudWorker } from "./worker"
import type { CloudWorkerRunner } from "./worker-runner"

type KubernetesResult = Awaited<ReturnType<typeof CloudWorkerRunner.runSandbox>> & {
  manifest?: NonNullable<Parameters<typeof CloudPostgresWorkerLoop.completeKubernetesRun>[0]["result"]["manifest"]>
  sizeByPath?: Record<string, number>
}
type KubernetesRunner = (input: { jobID: string; launch: CloudWorker.LaunchPlan }) => Promise<KubernetesResult>
type SharedSessionResult =
  | {
      status: "succeeded"
      runtimeID: string
      manifest: NonNullable<Parameters<typeof CloudPostgresWorkerLoop.completeKubernetesRun>[0]["result"]["manifest"]>
      sizeByPath: Record<string, number>
    }
  | {
      status: "failed"
      runtimeID: string
      message: string
    }
type SharedSessionRuntime = (input: { jobID: string; launch: CloudWorker.LaunchPlan }) => Promise<SharedSessionResult>
type StorageClient = CloudS3StorageRunner.Client
type QueueClient = CloudQueueRunner.Client

function message(input: unknown) {
  if (input instanceof Error) return input.message
  return String(input)
}

export async function completeKubernetesJob(input: {
  client: QueryClient
  tenantID: string
  jobID: string
  workerID: string
  now: () => number
  bucket: string
  launch: CloudWorker.LaunchPlan
  objectKeyPrefix: string
  kubernetes: KubernetesRunner
  storageClient?: StorageClient
  queueClient?: QueueClient
  retry?: Parameters<typeof CloudPostgresWorkerLoop.completeKubernetesRun>[0]["retry"]
}) {
  const result = await input.kubernetes({ jobID: input.jobID, launch: input.launch })
  if (result.status === "succeeded" && result.manifest && input.storageClient) {
    const uploaded = await CloudStorageService.uploadArtifacts({
      bucket: input.bucket,
      tenantID: input.tenantID,
      workspaceID: input.launch.env.OPENCODE_RUNTIME_WORKSPACE_ID ?? "",
      sessionID: input.launch.env.OPENCODE_RUNTIME_SESSION_ID ?? "",
      jobID: input.jobID,
      workdir: input.launch.cwd,
      objectKeyPrefix: input.objectKeyPrefix,
      manifest: result.manifest,
      sizeByPath: result.sizeByPath ?? {},
      run: (operation) => CloudS3StorageRunner.run({ ...operation, client: input.storageClient! }),
    }).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    )
    if (!uploaded.ok) {
      const failed = await CloudPostgresWorkerLoop.failJob({
        client: input.client,
        tenantID: input.tenantID,
        jobID: input.jobID,
        message: `Artifact upload failed for Kubernetes sandbox ${result.podName}: ${message(uploaded.error)}`,
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
  }
  return CloudPostgresWorkerLoop.completeKubernetesRun({
    client: input.client,
    tenantID: input.tenantID,
    jobID: input.jobID,
    now: input.now,
    objectKeyPrefix: input.objectKeyPrefix,
    result,
    workerID: input.workerID,
    queueClient: input.queueClient,
    retry: input.retry,
  })
}

export async function completeSharedSessionJob(input: {
  client: QueryClient
  tenantID: string
  jobID: string
  workerID: string
  now: () => number
  bucket: string
  launch: CloudWorker.LaunchPlan
  objectKeyPrefix: string
  sharedRuntime: SharedSessionRuntime
  storageClient?: StorageClient
  queueClient?: QueueClient
  retry?: Parameters<typeof CloudPostgresWorkerLoop.failJob>[0]["retry"]
}) {
  const result = await input.sharedRuntime({ jobID: input.jobID, launch: input.launch })
  if (result.status === "failed") {
    const failed = await CloudPostgresWorkerLoop.failJob({
      client: input.client,
      tenantID: input.tenantID,
      jobID: input.jobID,
      message: `Shared session runtime ${result.runtimeID} failed: ${result.message}`,
      now: input.now,
      workerID: input.workerID,
      queueClient: input.queueClient,
      retry: input.retry,
    })
    return {
      status: "failed" as const,
      jobID: input.jobID,
      runtimeID: result.runtimeID,
      failed,
    }
  }
  if (input.storageClient) {
    const uploaded = await CloudStorageService.uploadArtifacts({
      bucket: input.bucket,
      tenantID: input.tenantID,
      workspaceID: input.launch.env.OPENCODE_RUNTIME_WORKSPACE_ID ?? "",
      sessionID: input.launch.env.OPENCODE_RUNTIME_SESSION_ID ?? "",
      jobID: input.jobID,
      workdir: input.launch.cwd,
      objectKeyPrefix: input.objectKeyPrefix,
      manifest: result.manifest,
      sizeByPath: result.sizeByPath,
      run: (operation) => CloudS3StorageRunner.run({ ...operation, client: input.storageClient! }),
    }).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    )
    if (!uploaded.ok) {
      const failed = await CloudPostgresWorkerLoop.failJob({
        client: input.client,
        tenantID: input.tenantID,
        jobID: input.jobID,
        message: `Artifact upload failed for shared session runtime ${result.runtimeID}: ${message(uploaded.error)}`,
        now: input.now,
        workerID: input.workerID,
        queueClient: input.queueClient,
        retry: input.retry,
      })
      return {
        status: "failed" as const,
        jobID: input.jobID,
        runtimeID: result.runtimeID,
        failed,
      }
    }
  }
  const completed = await CloudPostgresWorkerLoop.completeJob({
    client: input.client,
    tenantID: input.tenantID,
    jobID: input.jobID,
    now: input.now,
    manifest: result.manifest,
    objectKeyPrefix: input.objectKeyPrefix,
    sizeByPath: result.sizeByPath,
    workerID: input.workerID,
    queueClient: input.queueClient,
  })
  return {
    status: "completed" as const,
    jobID: input.jobID,
    runtimeID: result.runtimeID,
    completed,
  }
}

export * as CloudProductionWorker from "./production-worker"
