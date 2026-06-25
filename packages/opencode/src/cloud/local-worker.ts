import { Database } from "bun:sqlite"
import { CloudLocalExecutor } from "./local-executor"
import { CloudModelCredentialEnv } from "./model-credential-env"
import type { Manifest } from "./artifact"
import { CloudMetrics, type MetricPoint } from "./metrics"
import { CloudQueue } from "./queue"
import { CloudQueueAdapter } from "./queue-adapter"
import { CloudQueueRunner, type Client as QueueClient } from "./queue-runner"
import { CloudRuntimePool, type RuntimeWorker } from "./runtime-pool"
import { CloudS3StorageRunner, type Client as S3StorageClient } from "./s3-storage-runner"
import { CloudSessionWorkspace } from "./session-workspace"
import { CloudSchema, type Artifact, type File } from "./schema"
import { CloudSQLiteRepository } from "./sqlite-repository"
import { CloudSQLiteSchema } from "./sqlite-schema"
import { CloudSQLiteWorkerLoop as SQLiteWorkerLoop } from "./sqlite-worker-loop"
import { CloudStorageService } from "./storage-service"
import { CloudKubernetesExecutor } from "./kubernetes-executor"
import { CloudWorkerRunner } from "./worker-runner"

type WorkerInput = Parameters<typeof SQLiteWorkerLoop.tick>[0]
type StartedTick = Extract<ReturnType<typeof SQLiteWorkerLoop.tick>, { status: "started" }>
type ExecutionMode = "lease" | "simulate" | "opencode" | "kubernetes" | "shared-session"
type LocalExecutor = (input: { jobID: string; launch: StartedTick["launch"] }) => Promise<CloudLocalExecutor.Result>
type ModelSecretResolver = Parameters<typeof CloudModelCredentialEnv.resolve>[0]["resolveSecret"]
type SharedRuntime = (input: {
  runtimeID: string
  jobID: string
  launch: StartedTick["launch"]
  workspace: ReturnType<typeof CloudSessionWorkspace.plan>
}) => Promise<CloudLocalExecutor.Result>
type KubernetesRunner = (input: { jobID: string; launch: StartedTick["launch"] }) => Promise<
  Awaited<ReturnType<typeof CloudWorkerRunner.runSandbox>> & {
    manifest?: Manifest
    sizeByPath?: Record<string, number>
  }
>
type MetricsExporter = (metrics: MetricPoint[]) => Promise<void>
type RuntimeMetricsSample = Partial<
  Pick<RuntimeWorker["metrics"], "cpuPercent" | "memoryPercent" | "diskPercent" | "childProcesses" | "openFiles">
>
type LocalWorkerInput = WorkerInput & {
  executionMode?: ExecutionMode
  localExecutor?: LocalExecutor
  sharedRuntime?: SharedRuntime
  sharedRuntimeID?: string
  sharedRuntimeVersion?: string
  sharedRuntimeProfile?: RuntimeWorker["profile"]
  sharedRuntimeMaxActiveJobs?: number
  sharedRuntimeMaxSessions?: number
  kubernetesRunner?: KubernetesRunner
  modelSecretResolver?: ModelSecretResolver
  metricsExporter?: MetricsExporter
  runtimeMetrics?: () => RuntimeMetricsSample | Promise<RuntimeMetricsSample>
  storageClient?: S3StorageClient
  queueClient?: QueueClient
  retry?: RetryPolicy
  executionTimeoutMS?: number
  sessionCacheTTLMS?: number
}
type RetryPolicy = {
  maxAttempts: number
  baseDelayMS: number
  maxDelayMS: number
}
type Summary = {
  steps: number
  started: number
  idle: number
  errors: number
}
type Config = ReturnType<typeof config>
type Fetcher = Parameters<typeof CloudKubernetesExecutor.fetchClient>[0]["fetch"]

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
  if (input === "lease") return "lease"
  if (input === "simulate") return "simulate"
  if (input === "opencode") return "opencode"
  if (input === "kubernetes") return "kubernetes"
  if (input === "shared-session") return "shared-session"
  return "shared-session"
}

function runtimeProfile(input: string | undefined): RuntimeWorker["profile"] | undefined {
  if (input === "small" || input === "standard" || input === "large" || input === "gpu") return input
  return undefined
}

function retryPolicy(input: Record<string, string | undefined>): RetryPolicy | undefined {
  if (!input.CLOUD_RUNTIME_RETRY_MAX_ATTEMPTS) return undefined
  return {
    maxAttempts: number(input.CLOUD_RUNTIME_RETRY_MAX_ATTEMPTS, 1),
    baseDelayMS: number(input.CLOUD_RUNTIME_RETRY_BASE_DELAY_MS, 1_000),
    maxDelayMS: number(input.CLOUD_RUNTIME_RETRY_MAX_DELAY_MS, 30_000),
  }
}

function otelToken(input: string | undefined) {
  return input
    ?.split(",")
    .map((item) => item.trim())
    .find((item) => item.toLowerCase().startsWith("authorization=bearer "))
    ?.slice("authorization=Bearer ".length)
}

async function exportJobMetrics(input: LocalWorkerInput & { job: Parameters<typeof CloudMetrics.job>[0] }) {
  await input.metricsExporter?.(CloudMetrics.job(input.job)).catch(() => undefined)
}

async function cleanupSessionCache(input: LocalWorkerInput) {
  if (!input.sessionCacheTTLMS) return undefined
  return CloudSessionWorkspace.cleanupCache({
    plan: CloudSessionWorkspace.cacheCleanupPlan({
      runtimeRoot: input.sandboxRoot,
      now: input.now(),
      ttlMS: input.sessionCacheTTLMS,
      sessions: input.db
        .query("select id, time_updated from cloud_session where tenant_id = ?")
        .all(input.tenantID)
        .map((row) => ({
          sessionID: (row as Record<string, unknown>).id as string,
          lastUsedAt: (row as Record<string, unknown>).time_updated as number,
        })),
    }),
  })
}

async function runtimeMetrics(input: LocalWorkerInput) {
  return (await input.runtimeMetrics?.()) ?? {}
}

function metricsExporter(input: Config): MetricsExporter | undefined {
  if (!input.otelEndpoint) return undefined
  return async (metrics) => {
    await CloudMetrics.exportOTLP({
      endpoint: input.otelEndpoint!,
      token: input.otelToken,
      serviceName: input.otelServiceName,
      timeUnixNano: Date.now() * 1_000_000,
      metrics,
    })
  }
}

async function leaseQueue(input: LocalWorkerInput) {
  if (!input.queueClient) return undefined
  const job = CloudSQLiteRepository.listQueuedJobs({ db: input.db, tenantID: input.tenantID })[0]
  if (!job) return { leased: false as const, reason: "empty" }
  return (
    await CloudQueueRunner.run({
      client: input.queueClient,
      operations: [
        CloudQueueAdapter.lease({
          tenantID: input.tenantID,
          jobID: job.id,
          workerID: input.workerID,
          leaseTTLMS: input.leaseTTLMS,
          profile: job.runtime.profile,
        }),
      ],
    })
  ).leases[0]
}

async function ackQueue(input: LocalWorkerInput & { jobID: string; terminalStatus: "succeeded" | "failed" | "expired" | "canceled" }) {
  if (!input.queueClient) return
  await CloudQueueRunner.run({
    client: input.queueClient,
    operations: [
      CloudQueueAdapter.ack({
        jobID: input.jobID,
        workerID: input.workerID,
        terminalStatus: input.terminalStatus,
        time: input.now(),
      }),
    ],
  })
}

async function finishFailedQueue(input: LocalWorkerInput & { jobID: string; message: string }) {
  if (!input.queueClient) return
  if (input.retry) {
    const job = CloudSQLiteRepository.getJob({ db: input.db, tenantID: input.tenantID, id: input.jobID })
    if (!job) throw new Error("Cloud job not found")
    const attempts = (
      input.db.query("select count(*) as count from cloud_job_attempt where job_id = ?").get(input.jobID) as {
        count: number
      }
    ).count
    const retry = CloudQueue.retry({
      job: {
        ...job,
        status: "failed",
        error: input.message,
      },
      attempts,
      maxAttempts: input.retry.maxAttempts,
      now: input.now(),
      baseDelayMS: input.retry.baseDelayMS,
      maxDelayMS: input.retry.maxDelayMS,
    })
    if (retry.allowed && retry.retryAt) {
      await CloudQueueRunner.run({
        client: input.queueClient,
        operations: [
          CloudQueueAdapter.retry({
            tenantID: input.tenantID,
            jobID: input.jobID,
            runAt: retry.retryAt,
            attempt: retry.nextAttempt,
            reason: input.message,
            profile: job.runtime.profile,
          }),
        ],
      })
      return
    }
  }
  await ackQueue({ ...input, terminalStatus: "failed" })
}

async function finishCanceled(input: LocalWorkerInput & { tick: StartedTick }) {
  const job = CloudSQLiteRepository.getJob({ db: input.db, tenantID: input.tenantID, id: input.tick.jobID })
  if (job?.status !== "canceled") return undefined
  const canceled = SQLiteWorkerLoop.cancelJob({
    db: input.db,
    tenantID: input.tenantID,
    jobID: input.tick.jobID,
    message: job.error ?? "canceled",
    now: input.now,
  })
  await ackQueue({ ...input, jobID: input.tick.jobID, terminalStatus: "canceled" })
  return {
    status: "canceled" as const,
    jobID: input.tick.jobID,
    started: input.tick,
    canceled,
  }
}

export function config(input?: {
  env?: Record<string, string | undefined>
}) {
  const env = input?.env ?? Bun.env
  return {
    sqlitePath: env.CLOUD_RUNTIME_SQLITE_PATH ?? "cloud-runtime.sqlite",
    workerID: env.CLOUD_RUNTIME_WORKER_ID ?? "local-worker-1",
    tenantID: env.CLOUD_RUNTIME_TENANT_ID ?? "tenant_local",
    leaseTTLMS: number(env.CLOUD_RUNTIME_LEASE_TTL_MS, 30_000),
    pollIntervalMS: number(env.CLOUD_RUNTIME_POLL_INTERVAL_MS, 1_000),
    steps: env.CLOUD_RUNTIME_WORKER_STEPS ? number(env.CLOUD_RUNTIME_WORKER_STEPS, 0) : undefined,
    sandboxRoot: env.CLOUD_RUNTIME_SANDBOX_ROOT ?? "/tmp/cloud-runtime",
    bucket: env.CLOUD_RUNTIME_OBJECT_BUCKET ?? "runtime-artifacts",
    namespace: env.CLOUD_RUNTIME_K8S_NAMESPACE ?? "cloud-runtime",
    k8sServerURL: env.CLOUD_RUNTIME_K8S_SERVER_URL,
    k8sToken: env.CLOUD_RUNTIME_K8S_TOKEN,
    k8sPollIntervalMS: number(env.CLOUD_RUNTIME_K8S_POLL_INTERVAL_MS, 1_000),
    k8sMaxPolls: number(env.CLOUD_RUNTIME_K8S_MAX_POLLS, 120),
    executionMode: executionMode(env.CLOUD_RUNTIME_EXECUTION_MODE),
    sharedRuntimeID: env.CLOUD_RUNTIME_SHARED_RUNTIME_ID,
    sharedRuntimeVersion: env.CLOUD_RUNTIME_SHARED_RUNTIME_VERSION,
    sharedRuntimeProfile: runtimeProfile(env.CLOUD_RUNTIME_SHARED_RUNTIME_PROFILE),
    sharedRuntimeMaxActiveJobs: env.CLOUD_RUNTIME_SHARED_RUNTIME_MAX_ACTIVE_JOBS
      ? number(env.CLOUD_RUNTIME_SHARED_RUNTIME_MAX_ACTIVE_JOBS, 1)
      : undefined,
    sharedRuntimeMaxSessions: env.CLOUD_RUNTIME_SHARED_RUNTIME_MAX_SESSIONS
      ? number(env.CLOUD_RUNTIME_SHARED_RUNTIME_MAX_SESSIONS, 20)
      : undefined,
    retry: retryPolicy(env),
    executionTimeoutMS: env.CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS ? number(env.CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS, 0) : undefined,
    sessionCacheTTLMS: env.CLOUD_RUNTIME_SESSION_CACHE_TTL_MS ? number(env.CLOUD_RUNTIME_SESSION_CACHE_TTL_MS, 0) : undefined,
    otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelToken: otelToken(env.OTEL_EXPORTER_OTLP_HEADERS),
    otelServiceName: env.OTEL_SERVICE_NAME ?? "cloud-opencode-runtime-worker",
    modelSecretResolver: CloudModelCredentialEnv.envSecretResolver({ env }),
  }
}

export function kubernetesRunner(input: {
  namespace: string
  serverURL: string
  token?: string
  pollIntervalMS?: number
  maxPolls?: number
  fetch?: Fetcher
}): KubernetesRunner {
  const client = CloudKubernetesExecutor.fetchClient({
    serverURL: input.serverURL,
    token: input.token,
    pollIntervalMS: input.pollIntervalMS,
    maxPolls: input.maxPolls,
    fetch: input.fetch,
  })
  return (request) =>
    CloudWorkerRunner.runSandbox({
      namespace: input.namespace,
      launch: request.launch,
      kubernetes: client,
    })
}

async function executeWithTimeout(input: LocalWorkerInput & { tick: StartedTick }) {
  const execution = (input.localExecutor ?? CloudLocalExecutor.execute)({ jobID: input.tick.jobID, launch: input.tick.launch })
  if (!input.executionTimeoutMS) return execution
  const result = await Promise.race([
    execution,
    Bun.sleep(input.executionTimeoutMS).then(() => ({ status: "expired" as const, message: "execution timeout" })),
  ])
  execution.catch(() => undefined)
  return result
}

async function applyModelCredentialEnv(input: LocalWorkerInput & { tick: StartedTick }) {
  if (!input.modelSecretResolver) return input.tick
  const spec = CloudSQLiteRepository.getJobSpec({ db: input.db, tenantID: input.tenantID, id: input.tick.jobID })
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

async function executeKubernetes(input: LocalWorkerInput & { tick: StartedTick }) {
  if (!input.kubernetesRunner) throw new Error("Cloud Kubernetes runner not configured")
  return input.kubernetesRunner({ jobID: input.tick.jobID, launch: input.tick.launch })
}

function parseJSON(input: unknown) {
  if (typeof input !== "string") return input
  return JSON.parse(input)
}

function runtimeWorker(input: Record<string, unknown>) {
  return CloudRuntimePool.decodeRuntimeWorker({
    id: input.id,
    tenantID: input.tenant_id,
    executionMode: input.execution_mode,
    status: input.status,
    version: input.version,
    profile: input.profile,
    maxActiveJobs: input.max_active_jobs,
    maxSessions: input.max_sessions,
    metrics: parseJSON(input.metrics),
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function sessionBinding(input: Record<string, unknown>) {
  return CloudRuntimePool.decodeSessionBinding({
    tenantID: input.tenant_id,
    sessionID: input.session_id,
    runtimeID: input.runtime_id,
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function file(input: Record<string, unknown>): File {
  return CloudSchema.decodeFile({
    id: input.id,
    tenantID: input.tenant_id,
    workspaceID: input.workspace_id,
    sessionID: input.session_id ?? undefined,
    name: input.name,
    mime: input.mime ?? undefined,
    size: input.size,
    objectKey: input.object_key,
    sha256: input.sha256 ?? undefined,
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function artifact(input: Record<string, unknown>): Artifact {
  return CloudSchema.decodeArtifact({
    id: input.id,
    tenantID: input.tenant_id,
    workspaceID: input.workspace_id,
    sessionID: input.session_id,
    jobID: input.job_id,
    name: input.name,
    kind: input.kind,
    mime: input.mime ?? undefined,
    size: input.size,
    objectKey: input.object_key,
    sha256: input.sha256 ?? undefined,
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function sharedWorkspacePlan(input: LocalWorkerInput & { tick: StartedTick }) {
  const spec = CloudSQLiteRepository.getJobSpec({ db: input.db, tenantID: input.tenantID, id: input.tick.jobID })
  if (!spec) throw new Error("Cloud SQLite worker loop job spec not found")
  const inputIDs = new Set(spec.inputs)
  return CloudSessionWorkspace.plan({
    tenantID: input.tenantID,
    workspaceID: input.tick.attempt.workspaceID,
    sessionID: input.tick.attempt.sessionID,
    jobID: input.tick.jobID,
    runtimeRoot: input.sandboxRoot,
    files: input.db
      .query("select * from cloud_file where tenant_id = ? order by time_created, id")
      .all(input.tenantID)
      .map((row) => file(row as Record<string, unknown>))
      .filter((item) => inputIDs.has(item.id)),
    artifacts: input.db
      .query("select * from cloud_artifact where tenant_id = ? and session_id = ? and job_id != ? order by time_created, id")
      .all(input.tenantID, input.tick.attempt.sessionID, input.tick.jobID)
      .map((row) => artifact(row as Record<string, unknown>)),
  })
}

function assignSharedRuntime(input: LocalWorkerInput & { tick: StartedTick }) {
  const assignment = CloudRuntimePool.assign({
    tenantID: input.tenantID,
    sessionID: input.tick.attempt.sessionID,
    runtimes: input.db
      .query("select * from cloud_runtime_worker where tenant_id = ? order by id")
      .all(input.tenantID)
      .map((row) => runtimeWorker(row as Record<string, unknown>)),
    bindings: input.db
      .query("select * from cloud_session_runtime_binding where tenant_id = ?")
      .all(input.tenantID)
      .map((row) => sessionBinding(row as Record<string, unknown>)),
  })
  if (!assignment.assigned) throw new Error("Cloud runtime capacity exhausted")
  const binding = CloudRuntimePool.bindSession({
    tenantID: input.tenantID,
    sessionID: input.tick.attempt.sessionID,
    runtimeID: assignment.runtimeID,
    now: input.now(),
  })
  input.db
    .query(
      `insert into cloud_session_runtime_binding (
        tenant_id, session_id, runtime_id, time_created, time_updated
      ) values (?, ?, ?, ?, ?)
      on conflict(tenant_id, session_id) do update set
        runtime_id = excluded.runtime_id,
        time_updated = excluded.time_updated`,
    )
    .run(binding.tenantID, binding.sessionID, binding.runtimeID, binding.time.created, binding.time.updated)
  return assignment.runtimeID
}

function ensureSharedRuntime(input: LocalWorkerInput & { tick?: StartedTick; metrics?: RuntimeMetricsSample }) {
  const found = input.db
    .query("select * from cloud_runtime_worker where tenant_id = ? and id = ?")
    .get(input.tenantID, input.sharedRuntimeID ?? input.workerID) as Record<string, unknown> | null
  const existing = found ? runtimeWorker(found) : undefined
  const metrics = {
    activeJobs: existing?.metrics.activeJobs ?? 0,
    busySessions: existing?.metrics.busySessions ?? 0,
    idleSessions: existing?.metrics.idleSessions ?? 0,
    cpuPercent: input.metrics?.cpuPercent ?? existing?.metrics.cpuPercent ?? 0,
    memoryPercent: input.metrics?.memoryPercent ?? existing?.metrics.memoryPercent ?? 0,
    diskPercent: input.metrics?.diskPercent ?? existing?.metrics.diskPercent ?? 0,
    recentErrorRate: existing?.metrics.recentErrorRate ?? 0,
    heartbeatDelayMS: 0,
    ...(input.metrics?.childProcesses ?? existing?.metrics.childProcesses
      ? { childProcesses: input.metrics?.childProcesses ?? existing?.metrics.childProcesses }
      : {}),
    ...(input.metrics?.openFiles ?? existing?.metrics.openFiles
      ? { openFiles: input.metrics?.openFiles ?? existing?.metrics.openFiles }
      : {}),
  }
  const runtime = CloudRuntimePool.decodeRuntimeWorker({
    id: input.sharedRuntimeID ?? input.workerID,
    tenantID: input.tenantID,
    executionMode: "shared_session_pool",
    status: existing?.status === "draining" ? "draining" : "healthy",
    version: input.sharedRuntimeVersion ?? input.tick?.attempt.runtime.version ?? "1.14.28",
    profile: input.sharedRuntimeProfile ?? input.tick?.attempt.runtime.profile ?? "standard",
    maxActiveJobs: input.sharedRuntimeMaxActiveJobs ?? 1,
    maxSessions: input.sharedRuntimeMaxSessions ?? 20,
    metrics,
    time: {
      created: input.now(),
      updated: input.now(),
    },
  })
  input.db
    .query(
      `insert into cloud_runtime_worker (
        id, tenant_id, execution_mode, status, version, profile, max_active_jobs, max_sessions, metrics, time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        execution_mode = excluded.execution_mode,
        status = excluded.status,
        version = excluded.version,
        profile = excluded.profile,
        max_active_jobs = excluded.max_active_jobs,
        max_sessions = excluded.max_sessions,
        metrics = excluded.metrics,
        time_updated = excluded.time_updated`,
    )
    .run(
      runtime.id,
      runtime.tenantID,
      runtime.executionMode,
      runtime.status,
      runtime.version,
      runtime.profile,
      runtime.maxActiveJobs,
      runtime.maxSessions,
      JSON.stringify(runtime.metrics),
      runtime.time.created,
      runtime.time.updated,
    )
  return runtime
}

async function heartbeatSharedRuntime(input: LocalWorkerInput) {
  if (input.executionMode !== "shared-session") return undefined
  return ensureSharedRuntime({ ...input, metrics: await runtimeMetrics(input) })
}

function updateSharedRuntimeMetrics(input: LocalWorkerInput & { runtimeID: string; activeDelta: number; busyDelta: number; idleDelta: number }) {
  const found = input.db
    .query("select * from cloud_runtime_worker where tenant_id = ? and id = ?")
    .get(input.tenantID, input.runtimeID) as Record<string, unknown> | null
  if (!found) throw new Error("Cloud runtime worker not found")
  const runtime = runtimeWorker(found)
  const metrics = {
    ...runtime.metrics,
    activeJobs: Math.max(0, runtime.metrics.activeJobs + input.activeDelta),
    busySessions: Math.max(0, runtime.metrics.busySessions + input.busyDelta),
    idleSessions: Math.max(0, runtime.metrics.idleSessions + input.idleDelta),
  }
  input.db
    .query("update cloud_runtime_worker set metrics = ?, time_updated = ? where tenant_id = ? and id = ?")
    .run(JSON.stringify(metrics), input.now(), input.tenantID, input.runtimeID)
  return metrics
}

function sharedSessionPaths(input: { sandboxRoot: string; sessionID: string; jobID: string }) {
  const root = input.sandboxRoot.replace(/\/+$/, "")
  const session = `${root}/sessions/${input.sessionID}`
  const job = `${session}/jobs/${input.jobID}`
  return {
    workspace: `${session}/workspace`,
    job,
    input: `${job}/input`,
    output: `${job}/output`,
    artifactManifest: `${job}/.opencode-cloud/artifacts.json`,
  }
}

function sharedSessionLaunch(input: LocalWorkerInput & { tick: StartedTick }) {
  const paths = sharedSessionPaths({
    sandboxRoot: input.sandboxRoot,
    sessionID: input.tick.attempt.sessionID,
    jobID: input.tick.jobID,
  })
  return {
    ...input.tick.launch,
    cwd: paths.job,
    artifactManifest: paths.artifactManifest,
    env: {
      ...input.tick.launch.env,
      OPENCODE_RUNTIME_WORKSPACE_DIR: paths.workspace,
      OPENCODE_RUNTIME_INPUT_DIR: paths.input,
      OPENCODE_RUNTIME_OUTPUT_DIR: paths.output,
      OPENCODE_RUNTIME_ARTIFACT_MANIFEST: paths.artifactManifest,
    },
  }
}

async function executeSharedSession(input: LocalWorkerInput & { tick: StartedTick }) {
  ensureSharedRuntime({ ...input, metrics: await runtimeMetrics(input) })
  const runtimeID = assignSharedRuntime(input)
  const launch = sharedSessionLaunch(input)
  const workspace = sharedWorkspacePlan(input)
  if (input.storageClient) {
    await CloudSessionWorkspace.restore({
      bucket: input.bucket,
      plan: workspace,
      run: (operation) => CloudS3StorageRunner.run({ ...operation, client: input.storageClient! }),
    })
  }
  updateSharedRuntimeMetrics({ ...input, runtimeID, activeDelta: 1, busyDelta: 1, idleDelta: -1 })
  const result = await (input.sharedRuntime ?? ((request) => (input.localExecutor ?? CloudLocalExecutor.execute)(request)))({
    runtimeID,
    jobID: input.tick.jobID,
    launch,
    workspace,
  }).finally(() => {
    updateSharedRuntimeMetrics({ ...input, runtimeID, activeDelta: -1, busyDelta: -1, idleDelta: 1 })
  })
  return {
    runtimeID,
    launch,
    workspace,
    result,
  }
}

async function cleanupSharedWorkspace(input: { workspace?: ReturnType<typeof CloudSessionWorkspace.plan> }) {
  if (!input.workspace) return
  await CloudSessionWorkspace.cleanup({ plan: input.workspace }).catch(() => undefined)
}

async function uploadArtifacts(input: LocalWorkerInput & {
  tick: StartedTick
  manifest: Manifest
  sizeByPath: Record<string, number>
}) {
  if (!input.storageClient) return
  await CloudStorageService.uploadArtifacts({
    bucket: input.bucket,
    tenantID: input.tenantID,
    workspaceID: input.tick.attempt.workspaceID,
    sessionID: input.tick.attempt.sessionID,
    jobID: input.tick.jobID,
    workdir: input.tick.launch.cwd,
    objectKeyPrefix: `${input.tenantID}/${input.tick.jobID}/artifacts`,
    manifest: input.manifest,
    sizeByPath: input.sizeByPath,
    run: (operation) => CloudS3StorageRunner.run({ ...operation, client: input.storageClient! }),
  })
}

async function failFromError(input: LocalWorkerInput & { tick: StartedTick; error: unknown }) {
  const message = input.error instanceof Error ? input.error.message : String(input.error)
  const failed = SQLiteWorkerLoop.failJob({
    db: input.db,
    tenantID: input.tenantID,
    jobID: input.tick.jobID,
    message,
    now: input.now,
    retry: input.retry,
  })
  await finishFailedQueue({ ...input, jobID: input.tick.jobID, message })
  await exportJobMetrics({ ...input, job: failed })
  return {
    status: "failed" as const,
    jobID: input.tick.jobID,
    started: input.tick,
    failed,
  }
}

export async function runOnce(input: LocalWorkerInput) {
  await cleanupSessionCache(input)
  await heartbeatSharedRuntime(input)
  const queueLease = await leaseQueue(input)
  if (queueLease && !queueLease.leased) return { status: "idle" as const, reason: `queue:${queueLease.reason ?? "not_leased"}` }
  const leased = SQLiteWorkerLoop.tick(input)
  if (leased.status !== "started") return leased
  const tick = await applyModelCredentialEnv({ ...input, tick: leased }).catch((error) => ({ error }))
  if ("error" in tick) return failFromError({ ...input, tick: leased, error: tick.error })
  if (input.executionMode === "simulate") {
    const completed = SQLiteWorkerLoop.completeJob({
      db: input.db,
      tenantID: input.tenantID,
      jobID: tick.jobID,
      now: input.now,
      manifest: {
        version: 1,
        jobID: tick.jobID,
        artifacts: [
          {
            name: "summary.md",
            path: "summary.md",
            kind: "md",
            mime: "text/markdown",
          },
        ],
      },
      objectKeyPrefix: `${input.tenantID}/${tick.jobID}/artifacts`,
      sizeByPath: {
        "summary.md": 0,
      },
    })
    await ackQueue({ ...input, jobID: tick.jobID, terminalStatus: "succeeded" })
    await exportJobMetrics({ ...input, job: completed.job })
    return {
      status: "completed" as const,
      jobID: tick.jobID,
      started: tick,
      completed,
    }
  }
  if (input.executionMode === "kubernetes") {
    const result = await executeKubernetes({ ...input, tick })
    const canceled = await finishCanceled({ ...input, tick })
    if (canceled) return canceled
    if (result.status === "expired") {
      const expired = SQLiteWorkerLoop.expireJob({
        db: input.db,
        tenantID: input.tenantID,
        jobID: tick.jobID,
        message: `Kubernetes sandbox ${result.podName} expired: ${result.logs}`.trim(),
        now: input.now,
      })
      await ackQueue({ ...input, jobID: tick.jobID, terminalStatus: "expired" })
      await exportJobMetrics({ ...input, job: expired })
      return {
        status: "expired" as const,
        jobID: tick.jobID,
        started: tick,
        expired,
      }
    }
    if (result.status !== "succeeded") {
      const failed = SQLiteWorkerLoop.failJob({
        db: input.db,
        tenantID: input.tenantID,
        jobID: tick.jobID,
        message: `Kubernetes sandbox ${result.podName} failed: ${result.logs}`.trim(),
        now: input.now,
        retry: input.retry,
      })
      await finishFailedQueue({ ...input, jobID: tick.jobID, message: `Kubernetes sandbox ${result.podName} failed: ${result.logs}`.trim() })
      await exportJobMetrics({ ...input, job: failed })
      return {
        status: "failed" as const,
        jobID: tick.jobID,
        started: tick,
        failed,
      }
    }
    const manifest = result.manifest ?? {
      version: 1 as const,
      jobID: tick.jobID,
      artifacts: [],
    }
    const sizeByPath = result.sizeByPath ?? {}
    try {
      await uploadArtifacts({ ...input, tick, manifest, sizeByPath })
    } catch (error) {
      return failFromError({ ...input, tick, error })
    }
    const completed = SQLiteWorkerLoop.completeJob({
      db: input.db,
      tenantID: input.tenantID,
      jobID: tick.jobID,
      now: input.now,
      manifest,
      objectKeyPrefix: `${input.tenantID}/${tick.jobID}/artifacts`,
      sizeByPath,
    })
    await ackQueue({ ...input, jobID: tick.jobID, terminalStatus: "succeeded" })
    await exportJobMetrics({ ...input, job: completed.job })
    return {
      status: "completed" as const,
      jobID: tick.jobID,
      started: tick,
      completed,
    }
  }
  if (input.executionMode === "shared-session") {
    const shared = await executeSharedSession({ ...input, tick }).catch((error) => ({ error }))
    if ("error" in shared) return failFromError({ ...input, tick, error: shared.error })
    const sharedTick = { ...tick, launch: shared.launch }
    const canceled = await finishCanceled({ ...input, tick })
    if (canceled) {
      await cleanupSharedWorkspace({ workspace: shared.workspace })
      return { ...canceled, runtimeID: shared.runtimeID }
    }
    if (shared.result.status === "failed") {
      const failed = SQLiteWorkerLoop.failJob({
        db: input.db,
        tenantID: input.tenantID,
        jobID: tick.jobID,
        message: shared.result.message,
        now: input.now,
        retry: input.retry,
      })
      await finishFailedQueue({ ...input, jobID: tick.jobID, message: shared.result.message })
      await exportJobMetrics({ ...input, job: failed })
      await cleanupSharedWorkspace({ workspace: shared.workspace })
      return {
        status: "failed" as const,
        jobID: tick.jobID,
        runtimeID: shared.runtimeID,
        started: tick,
        failed,
      }
    }
    try {
      await uploadArtifacts({ ...input, tick: sharedTick, manifest: shared.result.manifest, sizeByPath: shared.result.sizeByPath })
    } catch (error) {
      const failed = { ...(await failFromError({ ...input, tick, error })), runtimeID: shared.runtimeID }
      await cleanupSharedWorkspace({ workspace: shared.workspace })
      return failed
    }
    const completed = SQLiteWorkerLoop.completeJob({
      db: input.db,
      tenantID: input.tenantID,
      jobID: tick.jobID,
      now: input.now,
      manifest: shared.result.manifest,
      objectKeyPrefix: `${input.tenantID}/${tick.jobID}/artifacts`,
      sizeByPath: shared.result.sizeByPath,
    })
    await ackQueue({ ...input, jobID: tick.jobID, terminalStatus: "succeeded" })
    await exportJobMetrics({ ...input, job: completed.job })
    await cleanupSharedWorkspace({ workspace: shared.workspace })
    return {
      status: "completed" as const,
      jobID: tick.jobID,
      runtimeID: shared.runtimeID,
      started: tick,
      completed,
    }
  }
  if (input.executionMode !== "opencode") return tick
  const result = await executeWithTimeout({ ...input, tick })
  const canceled = await finishCanceled({ ...input, tick })
  if (canceled) return canceled
  if (result.status === "expired") {
    const expired = SQLiteWorkerLoop.expireJob({
      db: input.db,
      tenantID: input.tenantID,
      jobID: tick.jobID,
      message: result.message,
      now: input.now,
    })
    await ackQueue({ ...input, jobID: tick.jobID, terminalStatus: "expired" })
    await exportJobMetrics({ ...input, job: expired })
    return {
      status: "expired" as const,
      jobID: tick.jobID,
      started: tick,
      expired,
    }
  }
  if (result.status === "failed") {
    const failed = SQLiteWorkerLoop.failJob({
      db: input.db,
      tenantID: input.tenantID,
      jobID: tick.jobID,
      message: result.message,
      now: input.now,
      retry: input.retry,
    })
    await finishFailedQueue({ ...input, jobID: tick.jobID, message: result.message })
    await exportJobMetrics({ ...input, job: failed })
    return {
      status: "failed" as const,
      jobID: tick.jobID,
      started: tick,
      failed,
    }
  }
  try {
    await uploadArtifacts({ ...input, tick, manifest: result.manifest, sizeByPath: result.sizeByPath })
  } catch (error) {
    return failFromError({ ...input, tick, error })
  }
  const completed = SQLiteWorkerLoop.completeJob({
    db: input.db,
    tenantID: input.tenantID,
    jobID: tick.jobID,
    now: input.now,
    manifest: result.manifest,
    objectKeyPrefix: `${input.tenantID}/${tick.jobID}/artifacts`,
    sizeByPath: result.sizeByPath,
  })
  await ackQueue({ ...input, jobID: tick.jobID, terminalStatus: "succeeded" })
  await exportJobMetrics({ ...input, job: completed.job })
  return {
    status: "completed" as const,
    jobID: tick.jobID,
    started: tick,
    completed,
  }
}

export async function runSteps(input: LocalWorkerInput & {
  pollIntervalMS: number
  steps: number
}) {
  async function step(remaining: number, summary: Summary): Promise<Summary> {
    if (remaining <= 0) return summary
    try {
      const tick = await runOnce(input)
      await sleep(input.pollIntervalMS)
      return step(remaining - 1, {
        ...summary,
        started: summary.started + (tick.status === "started" || tick.status === "completed" ? 1 : 0),
        idle: summary.idle + (tick.status === "idle" ? 1 : 0),
      })
    } catch {
      await sleep(input.pollIntervalMS)
      return step(remaining - 1, {
        ...summary,
        errors: summary.errors + 1,
      })
    }
  }

  return step(input.steps, { steps: input.steps, started: 0, idle: 0, errors: 0 })
}

export async function run(input?: {
  env?: Record<string, string | undefined>
}) {
  const cfg = config(input)
  const db = new Database(cfg.sqlitePath)
  CloudSQLiteSchema.apply({ db })
  const worker = {
    db,
    tenantID: cfg.tenantID,
    workerID: cfg.workerID,
    leaseTTLMS: cfg.leaseTTLMS,
    now: Date.now,
    sandboxRoot: cfg.sandboxRoot,
    bucket: cfg.bucket,
    namespace: cfg.namespace,
    executionMode: cfg.executionMode,
    sharedRuntimeID: cfg.sharedRuntimeID,
    sharedRuntimeVersion: cfg.sharedRuntimeVersion,
    sharedRuntimeProfile: cfg.sharedRuntimeProfile,
    sharedRuntimeMaxActiveJobs: cfg.sharedRuntimeMaxActiveJobs,
    sharedRuntimeMaxSessions: cfg.sharedRuntimeMaxSessions,
    retry: cfg.retry,
    executionTimeoutMS: cfg.executionTimeoutMS,
    sessionCacheTTLMS: cfg.sessionCacheTTLMS,
    metricsExporter: metricsExporter(cfg),
    ...(cfg.k8sServerURL
      ? {
          kubernetesRunner: kubernetesRunner({
            namespace: cfg.namespace,
            serverURL: cfg.k8sServerURL,
            token: cfg.k8sToken,
            pollIntervalMS: cfg.k8sPollIntervalMS,
            maxPolls: cfg.k8sMaxPolls,
          }),
        }
      : {}),
  }
  if (cfg.steps !== undefined) return runSteps({ ...worker, pollIntervalMS: cfg.pollIntervalMS, steps: cfg.steps })
  for (;;) {
    await runOnce(worker)
    await sleep(cfg.pollIntervalMS)
  }
}

if (import.meta.main) {
  const cfg = config()
  console.log(`cloud opencode runtime worker polling ${cfg.sqlitePath} as ${cfg.workerID}`)
  await run()
}

export * as CloudLocalWorker from "./local-worker"
