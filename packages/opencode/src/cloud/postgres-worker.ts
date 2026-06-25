import { CloudPostgresClient } from "./postgres-client"
import { CloudModelCredentialEnv } from "./model-credential-env"
import { CloudPostgresRepository } from "./postgres-repository"
import { CloudPostgresSchema } from "./postgres-schema"
import { CloudPostgresWorkerLoop } from "./postgres-worker-loop"
import type { QueryClient } from "./postgres-runner"
import { CloudPostgresQueue } from "./postgres-queue"
import { CloudPostgresSharedRuntime } from "./postgres-shared-runtime"
import { CloudProductionWorker } from "./production-worker"
import { CloudKubernetesExecutor } from "./kubernetes-executor"
import { CloudWorkerRunner } from "./worker-runner"
import { CloudS3Client } from "./s3-client"
import type { CloudS3StorageRunner } from "./s3-storage-runner"
import { CloudSharedRuntimeClient } from "./shared-runtime-client"

type WorkerInput = Parameters<typeof CloudPostgresWorkerLoop.tick>[0]
type StartedTick = Extract<Awaited<ReturnType<typeof CloudPostgresWorkerLoop.tick>>, { status: "started" }>
type ModelSecretResolver = Parameters<typeof CloudModelCredentialEnv.resolve>[0]["resolveSecret"]
type KubernetesRunner = Parameters<typeof CloudProductionWorker.completeKubernetesJob>[0]["kubernetes"]
type CompleteKubernetesJob = (input: Parameters<typeof CloudProductionWorker.completeKubernetesJob>[0]) => Promise<
  Awaited<ReturnType<typeof CloudProductionWorker.completeKubernetesJob>> | { status: "completed" | "failed"; jobID: string }
>
type CompleteSharedSessionJob = (input: {
  client: QueryClient
  tenantID: string
  jobID: string
  workerID: string
  now: () => number
  bucket: string
  launch: StartedTick["launch"]
  objectKeyPrefix: string
  queueClient?: WorkerInput["queueClient"]
  storageClient?: CloudS3StorageRunner.Client
}) => Promise<{ status: "completed" | "failed"; jobID: string; runtimeID?: string }>
type SharedRuntime = Parameters<typeof CloudProductionWorker.completeSharedSessionJob>[0]["sharedRuntime"]
type SharedRuntimeClient = Parameters<typeof CloudPostgresSharedRuntime.run>[0]["runtime"]
type SharedRuntimeEndpointClient = Parameters<typeof CloudPostgresSharedRuntime.run>[0]["runtimeClient"]
type RunOnceInput = WorkerInput & {
  kubernetesRunner?: KubernetesRunner
  completeKubernetesJob?: CompleteKubernetesJob
  completeSharedSessionJob?: CompleteSharedSessionJob
  sharedRuntime?: SharedRuntime
  sharedRuntimeClient?: SharedRuntimeClient
  sharedRuntimeEndpointClient?: SharedRuntimeEndpointClient
  executionMode?: ExecutionMode
  storageClient?: CloudS3StorageRunner.Client
  modelSecretResolver?: ModelSecretResolver
}
type Config = ReturnType<typeof config>
type ExecutionMode = "shared-session" | "kubernetes" | "lease"

function number(input: string | undefined, fallback: number) {
  const value = Number(input)
  if (Number.isFinite(value) && value >= 0) return value
  return fallback
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve()
  return Bun.sleep(ms)
}

function executionMode(input: string | undefined): ExecutionMode {
  if (input === "kubernetes") return "kubernetes"
  if (input === "lease") return "lease"
  return "shared-session"
}

function errorMessage(input: unknown) {
  if (input instanceof Error) return input.message
  return String(input)
}

function baseEnv(input: Record<string, string | undefined>) {
  return {
    ...(input.CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE ? { CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE: input.CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE } : {}),
  }
}

export function config(input?: {
  env?: Record<string, string | undefined>
}) {
  const env = input?.env ?? Bun.env
  return {
    databaseURL: env.CLOUD_RUNTIME_DATABASE_URL,
    workerID: env.CLOUD_RUNTIME_WORKER_ID ?? "postgres-worker-1",
    tenantID: env.CLOUD_RUNTIME_TENANT_ID ?? "tenant_local",
    leaseTTLMS: number(env.CLOUD_RUNTIME_LEASE_TTL_MS, 30_000),
    pollIntervalMS: number(env.CLOUD_RUNTIME_POLL_INTERVAL_MS, 1_000),
    steps: env.CLOUD_RUNTIME_WORKER_STEPS ? number(env.CLOUD_RUNTIME_WORKER_STEPS, 0) : undefined,
    sandboxRoot: env.CLOUD_RUNTIME_SANDBOX_ROOT ?? "/tmp/cloud-runtime",
    bucket: env.CLOUD_RUNTIME_OBJECT_BUCKET ?? "runtime-artifacts",
    objectEndpoint: env.CLOUD_RUNTIME_OBJECT_ENDPOINT,
    objectRegion: env.CLOUD_RUNTIME_OBJECT_REGION,
    objectAccessKeyID: env.CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID,
    objectSecretAccessKey: env.CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY,
    namespace: env.CLOUD_RUNTIME_K8S_NAMESPACE ?? "cloud-runtime",
    k8sServerURL: env.CLOUD_RUNTIME_K8S_SERVER_URL,
    k8sToken: env.CLOUD_RUNTIME_K8S_TOKEN,
    k8sPollIntervalMS: number(env.CLOUD_RUNTIME_K8S_POLL_INTERVAL_MS, 1_000),
    k8sMaxPolls: number(env.CLOUD_RUNTIME_K8S_MAX_POLLS, 120),
    executionMode: executionMode(env.CLOUD_RUNTIME_EXECUTION_MODE),
    baseEnv: baseEnv(env),
    modelSecretResolver: CloudModelCredentialEnv.envSecretResolver({ env }),
  }
}

export function kubernetesRunner(input: {
  namespace: string
  serverURL: string
  token?: string
  pollIntervalMS?: number
  maxPolls?: number
}): KubernetesRunner {
  const client = CloudKubernetesExecutor.fetchClient({
    serverURL: input.serverURL,
    token: input.token,
    pollIntervalMS: input.pollIntervalMS,
    maxPolls: input.maxPolls,
  })
  return (request) =>
    CloudWorkerRunner.runSandbox({
      namespace: input.namespace,
      launch: request.launch,
      kubernetes: client,
    })
}

async function complete(input: RunOnceInput & { tick: StartedTick }) {
  if (input.executionMode === "shared-session" && input.completeSharedSessionJob) {
    return input.completeSharedSessionJob({
      client: input.client,
      tenantID: input.tenantID,
      jobID: input.tick.jobID,
      workerID: input.workerID,
      now: input.now,
      bucket: input.bucket,
      launch: input.tick.launch,
      objectKeyPrefix: `${input.tenantID}/${input.tick.jobID}/artifacts`,
      queueClient: input.queueClient,
      storageClient: input.storageClient,
    })
  }
  if (input.executionMode === "shared-session" && input.sharedRuntime) {
    return CloudProductionWorker.completeSharedSessionJob({
      client: input.client,
      tenantID: input.tenantID,
      jobID: input.tick.jobID,
      workerID: input.workerID,
      now: input.now,
      bucket: input.bucket,
      launch: input.tick.launch,
      objectKeyPrefix: `${input.tenantID}/${input.tick.jobID}/artifacts`,
      queueClient: input.queueClient,
      storageClient: input.storageClient,
      sharedRuntime: input.sharedRuntime,
    })
  }
  if (input.executionMode === "shared-session" && input.sharedRuntimeClient) {
    return CloudProductionWorker.completeSharedSessionJob({
      client: input.client,
      tenantID: input.tenantID,
      jobID: input.tick.jobID,
      workerID: input.workerID,
      now: input.now,
      bucket: input.bucket,
      launch: input.tick.launch,
      objectKeyPrefix: `${input.tenantID}/${input.tick.jobID}/artifacts`,
      queueClient: input.queueClient,
      storageClient: input.storageClient,
      sharedRuntime: (request) =>
        CloudPostgresSharedRuntime.run({
          client: input.client,
          tenantID: input.tenantID,
          sessionID: input.tick.attempt.sessionID,
          jobID: request.jobID,
          launch: request.launch,
          now: input.now,
          runtime: input.sharedRuntimeClient!,
        }),
    })
  }
  if (input.executionMode === "shared-session") {
    return CloudProductionWorker.completeSharedSessionJob({
      client: input.client,
      tenantID: input.tenantID,
      jobID: input.tick.jobID,
      workerID: input.workerID,
      now: input.now,
      bucket: input.bucket,
      launch: input.tick.launch,
      objectKeyPrefix: `${input.tenantID}/${input.tick.jobID}/artifacts`,
      queueClient: input.queueClient,
      storageClient: input.storageClient,
      sharedRuntime: (request) =>
        CloudPostgresSharedRuntime.run({
          client: input.client,
          tenantID: input.tenantID,
          sessionID: input.tick.attempt.sessionID,
          jobID: request.jobID,
          launch: request.launch,
          now: input.now,
          runtimeClient: input.sharedRuntimeEndpointClient ?? CloudSharedRuntimeClient.create(),
        }),
    })
  }
  if (!input.kubernetesRunner) return input.tick
  return (input.completeKubernetesJob ?? CloudProductionWorker.completeKubernetesJob)({
    client: input.client,
    tenantID: input.tenantID,
    jobID: input.tick.jobID,
    workerID: input.workerID,
    now: input.now,
    bucket: input.bucket,
    launch: input.tick.launch,
    objectKeyPrefix: `${input.tenantID}/${input.tick.jobID}/artifacts`,
    kubernetes: input.kubernetesRunner,
    queueClient: input.queueClient,
    storageClient: input.storageClient,
  })
}

async function applyModelCredentialEnv(input: RunOnceInput & { tick: StartedTick }) {
  if (!input.modelSecretResolver) return input.tick
  const spec = await CloudPostgresRepository.getJobSpec({
    client: input.client,
    tenantID: input.tenantID,
    id: input.tick.jobID,
  })
  const resolved = await CloudModelCredentialEnv.resolve({
    snapshot: spec?.modelConfigSnapshot,
    resolveSecret: input.modelSecretResolver,
  })
  return {
    ...input.tick,
    launch: {
      ...input.tick.launch,
      env: {
        ...input.tick.launch.env,
        ...resolved.env,
      },
    },
  }
}

export async function runOnce(input: RunOnceInput) {
  const leased = await CloudPostgresWorkerLoop.tick(input)
  if (leased.status !== "started") return leased
  const tick = await applyModelCredentialEnv({ ...input, tick: leased }).catch((error) => ({ error }))
  if ("error" in tick) {
    return CloudPostgresWorkerLoop.failJob({
      client: input.client,
      tenantID: input.tenantID,
      jobID: leased.jobID,
      message: errorMessage(tick.error),
      now: input.now,
      workerID: input.workerID,
      queueClient: input.queueClient,
    }).then((failed) => ({ status: "failed" as const, jobID: leased.jobID, failed }))
  }
  return complete({ ...input, tick })
}

export async function runSteps(input: RunOnceInput & {
  pollIntervalMS: number
  steps: number
}) {
  async function step(remaining: number, summary: { steps: number; started: number; idle: number; errors: number }): Promise<typeof summary> {
    if (remaining <= 0) return summary
    return runOnce(input).then(
      async (tick) => {
        await sleep(input.pollIntervalMS)
        return step(remaining - 1, {
          ...summary,
          started: summary.started + (tick.status === "idle" ? 0 : 1),
          idle: summary.idle + (tick.status === "idle" ? 1 : 0),
        })
      },
      async () => {
        await sleep(input.pollIntervalMS)
        return step(remaining - 1, {
          ...summary,
          errors: summary.errors + 1,
        })
      },
    )
  }

  return step(input.steps, { steps: input.steps, started: 0, idle: 0, errors: 0 })
}

function worker(input: Config & {
  client: QueryClient
  queueClient?: WorkerInput["queueClient"]
  storageClient?: CloudS3StorageRunner.Client
  kubernetesRunner?: KubernetesRunner
  completeKubernetesJob?: CompleteKubernetesJob
  completeSharedSessionJob?: CompleteSharedSessionJob
  sharedRuntime?: SharedRuntime
  sharedRuntimeClient?: SharedRuntimeClient
  sharedRuntimeEndpointClient?: SharedRuntimeEndpointClient
}) {
  return {
    client: input.client,
    tenantID: input.tenantID,
    workerID: input.workerID,
    executionMode: input.executionMode,
    leaseTTLMS: input.leaseTTLMS,
    now: Date.now,
    sandboxRoot: input.sandboxRoot,
    bucket: input.bucket,
    namespace: input.namespace,
    baseEnv: input.baseEnv,
    queueClient: input.queueClient,
    storageClient: input.storageClient,
    modelSecretResolver: input.modelSecretResolver,
    completeKubernetesJob: input.completeKubernetesJob,
    completeSharedSessionJob: input.completeSharedSessionJob,
    sharedRuntime: input.sharedRuntime,
    sharedRuntimeClient: input.sharedRuntimeClient,
    sharedRuntimeEndpointClient: input.sharedRuntimeEndpointClient,
    ...(input.k8sServerURL
      ? {
          kubernetesRunner: input.kubernetesRunner ?? kubernetesRunner({
            namespace: input.namespace,
            serverURL: input.k8sServerURL,
            token: input.k8sToken,
            pollIntervalMS: input.k8sPollIntervalMS,
            maxPolls: input.k8sMaxPolls,
          }),
        }
      : {}),
  }
}

export async function run(input?: {
  env?: Record<string, string | undefined>
  client?: QueryClient
  schema?: (input: { client: QueryClient }) => Promise<void>
  kubernetesRunner?: KubernetesRunner
  completeKubernetesJob?: CompleteKubernetesJob
  completeSharedSessionJob?: CompleteSharedSessionJob
  sharedRuntime?: SharedRuntime
  sharedRuntimeClient?: SharedRuntimeClient
  sharedRuntimeEndpointClient?: SharedRuntimeEndpointClient
  storageClient?: CloudS3StorageRunner.Client
}) {
  const cfg = config(input)
  const client = input?.client ?? CloudPostgresClient.create({ url: cfg.databaseURL })
  await (input?.schema ?? CloudPostgresSchema.apply)({ client })
  const item = worker({
    ...cfg,
    client,
    queueClient: CloudPostgresQueue.client({ client, now: Date.now }),
    storageClient: input?.storageClient ?? (cfg.objectEndpoint
      ? CloudS3Client.create({
          endpoint: cfg.objectEndpoint,
          region: cfg.objectRegion,
          accessKeyID: cfg.objectAccessKeyID,
          secretAccessKey: cfg.objectSecretAccessKey,
        })
      : undefined),
    kubernetesRunner: input?.kubernetesRunner,
    completeKubernetesJob: input?.completeKubernetesJob,
    completeSharedSessionJob: input?.completeSharedSessionJob,
    sharedRuntime: input?.sharedRuntime,
    sharedRuntimeClient: input?.sharedRuntimeClient,
    sharedRuntimeEndpointClient: input?.sharedRuntimeEndpointClient,
  })
  if (cfg.steps !== undefined) return runSteps({ ...item, pollIntervalMS: cfg.pollIntervalMS, steps: cfg.steps })
  for (;;) {
    await runOnce(item)
    await sleep(cfg.pollIntervalMS)
  }
}

if (import.meta.main) {
  const cfg = config()
  console.log(`cloud opencode runtime postgres worker polling ${cfg.databaseURL ?? "<missing>"} as ${cfg.workerID}`)
  await run()
}

export * as CloudPostgresWorker from "./postgres-worker"
