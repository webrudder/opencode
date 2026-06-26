import { Hono } from "hono"
import { mkdir } from "fs/promises"
import path from "path"
import { CloudLocalExecutor } from "./local-executor"
import { CloudPostgresClient } from "./postgres-client"
import type { QueryClient } from "./postgres-runner"
import { CloudPostgresSchema } from "./postgres-schema"
import { CloudPostgresService } from "./postgres-service"
import type { RuntimeWorker } from "./runtime-pool"
import type { CloudWorker } from "./worker"

type Result = Awaited<ReturnType<typeof CloudLocalExecutor.execute>>
type Execute = (input: { runtimeID: string; jobID: string; launch: CloudWorker.LaunchPlan }) => Promise<Result>
type Config = ReturnType<typeof config>
type Metrics = RuntimeWorker["metrics"]
type Heartbeat = (input: { metrics: Metrics }) => Promise<void>

const emptyMetrics = {
  activeJobs: 0,
  busySessions: 0,
  idleSessions: 0,
  cpuPercent: 0,
  memoryPercent: 0,
  diskPercent: 0,
  recentErrorRate: 0,
  heartbeatDelayMS: 0,
}

function number(input: string | undefined, fallback: number) {
  const value = Number(input)
  if (Number.isFinite(value) && value > 0) return value
  return fallback
}

function profile(input: string | undefined): "small" | "standard" | "large" | "gpu" {
  if (input === "small" || input === "standard" || input === "large" || input === "gpu") return input
  return "standard"
}

function record(input: unknown) {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) return input as Record<string, unknown>
  return {}
}

function launch(input: unknown) {
  return input as CloudWorker.LaunchPlan
}

function launchWithRuntimeEnv(input: CloudWorker.LaunchPlan) {
  return {
    ...input,
    env: {
      ...input.env,
      OPENCODE_RUNTIME_ARTIFACT_MANIFEST: input.env.OPENCODE_RUNTIME_ARTIFACT_MANIFEST ?? input.artifactManifest,
    },
  }
}

function message(input: unknown) {
  if (input instanceof Error) return input.message
  return String(input)
}

function secretValues(input: CloudWorker.LaunchPlan) {
  return Object.entries(input.env)
    .filter(([key, value]) => key.endsWith("_API_KEY") && value)
    .map((entry) => entry[1])
}

function redactMessage(input: { message: string; launch: CloudWorker.LaunchPlan }) {
  return secretValues(input.launch).reduce(
    (message, value) => message.replaceAll(value, "[redacted]"),
    input.message.replaceAll(/([A-Z0-9_]*API_KEY=)[^\s,;]+/g, "$1[redacted]"),
  )
}

function sanitizeResult(input: { result: Result; launch: CloudWorker.LaunchPlan }): Result {
  if (input.result.status !== "failed") return input.result
  return {
    ...input.result,
    message: redactMessage({ message: input.result.message, launch: input.launch }),
  }
}

export function config(input?: { env?: Record<string, string | undefined> }) {
  const env = input?.env ?? Bun.env
  return {
    runtimeID: env.CLOUD_RUNTIME_ID ?? "runtime-local-1",
    port: number(env.CLOUD_RUNTIME_WORKER_PORT, 8788),
    databaseURL: env.CLOUD_RUNTIME_DATABASE_URL,
    tenantID: env.CLOUD_RUNTIME_TENANT_ID ?? "tenant_local",
    endpoint: env.CLOUD_RUNTIME_ENDPOINT ?? "http://runtime-worker:8788",
    version: env.CLOUD_RUNTIME_VERSION ?? "1.14.28",
    profile: profile(env.CLOUD_RUNTIME_PROFILE),
    maxActiveJobs: number(env.CLOUD_RUNTIME_MAX_ACTIVE_JOBS, 4),
    maxSessions: number(env.CLOUD_RUNTIME_MAX_SESSIONS, 20),
    heartbeatIntervalMS: number(env.CLOUD_RUNTIME_HEARTBEAT_INTERVAL_MS, 10_000),
  }
}

export async function register(input: {
  client?: QueryClient
  config: Config
  now?: () => number
}) {
  const service = CloudPostgresService.create({
    client: input.client ?? CloudPostgresClient.create({ url: input.config.databaseURL }),
    tenant: {
      id: input.config.tenantID,
      defaultRuntimeVersion: input.config.version,
      defaultRuntimeImage: `cloud-runtime-opencode:${input.config.version}`,
      defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
      allowedModels: ["anthropic/claude-sonnet-4-5"],
    },
    tools: { mcp: {}, skills: {} },
    now: input.now ?? Date.now,
    id: (prefix) => `${prefix}_${crypto.randomUUID()}`,
    stageFile: () => ({ objectKey: "", size: 0 }),
  })
  return service.registerRuntimeWorker({
    runtimeID: input.config.runtimeID,
    version: input.config.version,
    profile: input.config.profile,
    maxActiveJobs: input.config.maxActiveJobs,
    maxSessions: input.config.maxSessions,
    endpoint: input.config.endpoint,
  })
}

export async function bootstrap(input: {
  client?: QueryClient
  config: Config
  now?: () => number
}) {
  const client = input.client ?? CloudPostgresClient.create({ url: input.config.databaseURL })
  await CloudPostgresSchema.apply({ client })
  return register({ ...input, client })
}

function service(input: { client?: QueryClient; config: Config; now?: () => number }) {
  return CloudPostgresService.create({
    client: input.client ?? CloudPostgresClient.create({ url: input.config.databaseURL }),
    tenant: {
      id: input.config.tenantID,
      defaultRuntimeVersion: input.config.version,
      defaultRuntimeImage: `cloud-runtime-opencode:${input.config.version}`,
      defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
      allowedModels: ["anthropic/claude-sonnet-4-5"],
    },
    tools: { mcp: {}, skills: {} },
    now: input.now ?? Date.now,
    id: (prefix) => `${prefix}_${crypto.randomUUID()}`,
    stageFile: () => ({ objectKey: "", size: 0 }),
  })
}

export async function heartbeat(input: {
  client?: QueryClient
  config: Config
  metrics: Metrics
  now?: () => number
}) {
  return service(input).heartbeatRuntimeWorker(input.config.runtimeID, {
    status: "healthy",
    metrics: input.metrics,
  })
}

export async function heartbeatIdle(input: { heartbeat: Heartbeat }) {
  return input.heartbeat({ metrics: { ...emptyMetrics, idleSessions: 1 } })
}

function bestEffort(input: Promise<unknown>) {
  return input.catch(() => undefined)
}

export function create(input: {
  runtimeID: string
  execute?: Execute
  heartbeat?: Heartbeat
  modelessSmoke?: boolean
}) {
  const execute = input.execute ?? (input.modelessSmoke ? modelessSmokeExecute : ((request) => CloudLocalExecutor.execute({ jobID: request.jobID, launch: request.launch })))
  const heartbeat = input.heartbeat ?? (() => Promise.resolve())
  const app = new Hono()
    .get("/health", (c) => c.json({ healthy: true, service: "cloud-opencode-runtime-worker", runtimeID: input.runtimeID }))
    .post("/v1/runtime/jobs", async (c) => {
      const body = record(await c.req.json())
      const runtimeID = `${body.runtimeID ?? ""}`
      if (runtimeID !== input.runtimeID) {
        return c.json(
          {
            status: "failed" as const,
            message: `Runtime worker ${input.runtimeID} cannot execute job for ${runtimeID}`,
          },
          409,
        )
      }
      await bestEffort(heartbeat({
        metrics: {
          ...emptyMetrics,
          activeJobs: 1,
          busySessions: 1,
        },
      }))
      const requestedLaunch = launchWithRuntimeEnv(launch(body.launch))
      const result = await execute({
        runtimeID,
        jobID: `${body.jobID ?? ""}`,
        launch: requestedLaunch,
      }).catch((error) => ({
        status: "failed" as const,
        message: redactMessage({ message: message(error), launch: requestedLaunch }),
      }))
      await bestEffort(heartbeat({ metrics: { ...emptyMetrics, idleSessions: 1 } }))
      return c.json(sanitizeResult({ result, launch: requestedLaunch }))
    })
  return { app }
}

async function modelessSmokeExecute(input: { runtimeID: string; jobID: string; launch: CloudWorker.LaunchPlan }): Promise<Result> {
  await mkdir(path.dirname(input.launch.artifactManifest), { recursive: true })
  const artifact = {
    name: "modeless-smoke-report.md",
    kind: "md" as const,
    path: "modeless-smoke-report.md",
    mime: "text/markdown",
  }
  await Bun.write(
    path.join(input.launch.cwd, artifact.path),
    [
      "# Modeless shared-session smoke",
      "",
      `runtime: ${input.runtimeID}`,
      `job: ${input.jobID}`,
      "",
    ].join("\n"),
  )
  await Bun.write(
    input.launch.artifactManifest,
    JSON.stringify({ version: 1, jobID: input.jobID, artifacts: [artifact] }),
  )
  return {
    status: "succeeded",
    manifest: { version: 1, jobID: input.jobID, artifacts: [artifact] },
    sizeByPath: {
      [artifact.path]: (await Bun.file(path.join(input.launch.cwd, artifact.path)).arrayBuffer()).byteLength,
    },
  }
}

if (import.meta.main) {
  const cfg = config()
  console.log(`cloud opencode runtime worker ${cfg.runtimeID} listening on :${cfg.port}`)
  const heartbeatFn = cfg.databaseURL
    ? async (request: { metrics: Metrics }) => {
        await heartbeat({ config: cfg, metrics: request.metrics })
      }
    : undefined
  if (cfg.databaseURL) {
    await bootstrap({ config: cfg })
    await heartbeatIdle({ heartbeat: heartbeatFn! })
    setInterval(() => heartbeatIdle({ heartbeat: heartbeatFn! }).catch(() => undefined), cfg.heartbeatIntervalMS)
  }
  Bun.serve({
    port: cfg.port,
    fetch: create({ runtimeID: cfg.runtimeID, heartbeat: heartbeatFn, modelessSmoke: Bun.env.CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE === "1" }).app.fetch,
  })
}

export * as CloudRuntimeWorkerServer from "./runtime-worker-server"
