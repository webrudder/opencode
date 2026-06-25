import type { QueryClient } from "./postgres-runner"
import type { Client as QueueClient } from "./queue-runner"
import type { Client as ObjectStorageClient } from "./s3-storage-runner"
import { CloudPostgresClient } from "./postgres-client"
import { CloudPostgresQueue } from "./postgres-queue"
import { CloudS3Client } from "./s3-client"

type Check = {
  name: string
  status: "passed" | "failed"
  detail: string
}

type Plan = {
  name: string
  provider: "postgres" | "object_storage" | "queue" | "kubernetes"
  command: string
}

type KubernetesHealthClient = {
  getNamespace(input: { namespace: string }): Promise<{ name: string }>
}

type Env = Record<string, string | undefined>
type ProviderProfile = "production" | "local-docker"

function check(input: { name: string; passed: boolean; detail: string }) {
  return {
    name: input.name,
    status: input.passed ? "passed" as const : "failed" as const,
    detail: input.detail,
  }
}

function queueProvider(input: string | undefined) {
  if (input === "sqs" || input === "bullmq" || input === "postgres") return input
  return "postgres"
}

function providerProfile(input: string | undefined): ProviderProfile {
  if (input === "local-docker") return "local-docker"
  return "production"
}

function envLine(input: { key: string; value: string; comment?: string }) {
  return [
    ...(input.comment ? [`# ${input.comment}`] : []),
    `${input.key}=${input.value}`,
  ].join("\n")
}

export function envTemplate(input?: { profile?: ProviderProfile }) {
  const profile = input?.profile ?? "production"
  if (profile === "local-docker") {
    return [
      "# Cloud Runtime provider env template: local-docker",
      envLine({ key: "CLOUD_RUNTIME_PROVIDER_PROFILE", value: "local-docker" }),
      envLine({ key: "CLOUD_RUNTIME_POSTGRES_PORT", value: "55432" }),
      envLine({ key: "CLOUD_RUNTIME_OBJECT_ENDPOINT", value: "http://localhost:9000" }),
      envLine({ key: "CLOUD_RUNTIME_OBJECT_BUCKET", value: "runtime-artifacts" }),
      envLine({ key: "CLOUD_RUNTIME_OBJECT_REGION", value: "us-east-1" }),
      envLine({ key: "CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID", value: "opencode" }),
      envLine({ key: "CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY", value: "opencode-password" }),
      envLine({ key: "CLOUD_RUNTIME_OBJECT_FORCE_PATH_STYLE", value: "true" }),
      envLine({ key: "CLOUD_RUNTIME_QUEUE_PROVIDER", value: "postgres" }),
      envLine({ key: "CLOUD_RUNTIME_QUEUE", value: "cloud-runtime-jobs" }),
      "",
      "# Then run:",
      "#   bun run cloud:providers:check",
      "#   bun run cloud:providers:check --health",
    ].join("\n")
  }
  return [
    "# Cloud Runtime provider env template: production",
    envLine({
      key: "CLOUD_RUNTIME_DATABASE_URL",
      value: "postgres://opencode:secret@postgres.example.com:5432/cloud_runtime",
      comment: "PostgreSQL control-plane database and durable queue.",
    }),
    envLine({
      key: "CLOUD_RUNTIME_OBJECT_ENDPOINT",
      value: "https://s3.example.com",
      comment: "S3-compatible artifact storage.",
    }),
    envLine({ key: "CLOUD_RUNTIME_OBJECT_BUCKET", value: "runtime-artifacts" }),
    envLine({ key: "CLOUD_RUNTIME_OBJECT_REGION", value: "us-east-1" }),
    envLine({ key: "CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID", value: "replace-me" }),
    envLine({ key: "CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY", value: "replace-me" }),
    envLine({ key: "CLOUD_RUNTIME_OBJECT_FORCE_PATH_STYLE", value: "false" }),
    envLine({
      key: "CLOUD_RUNTIME_QUEUE_PROVIDER",
      value: "postgres",
      comment: "Queue provider. MVP production path uses postgres.",
    }),
    envLine({ key: "CLOUD_RUNTIME_QUEUE", value: "cloud-runtime-jobs" }),
    envLine({
      key: "CLOUD_RUNTIME_K8S_SERVER_URL",
      value: "https://kubernetes.example.com",
      comment: "Kubernetes sandbox namespace.",
    }),
    envLine({ key: "CLOUD_RUNTIME_K8S_TOKEN", value: "replace-me" }),
    envLine({ key: "CLOUD_RUNTIME_NAMESPACE", value: "cloud-runtime" }),
    "",
    "# Then run:",
    "#   bun run cloud:providers:check",
    "#   bun run cloud:providers:check --health",
  ].join("\n")
}

function localDockerEnv(input: Env): Env {
  return {
    ...input,
    CLOUD_RUNTIME_DATABASE_URL: input.CLOUD_RUNTIME_DATABASE_URL ?? `postgres://opencode:opencode@localhost:${input.CLOUD_RUNTIME_POSTGRES_PORT ?? "55432"}/cloud_runtime`,
    CLOUD_RUNTIME_OBJECT_ENDPOINT: input.CLOUD_RUNTIME_OBJECT_ENDPOINT ?? "http://localhost:9000",
    CLOUD_RUNTIME_OBJECT_BUCKET: input.CLOUD_RUNTIME_OBJECT_BUCKET ?? "runtime-artifacts",
    CLOUD_RUNTIME_OBJECT_REGION: input.CLOUD_RUNTIME_OBJECT_REGION ?? "us-east-1",
    CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID: input.CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID ?? "opencode",
    CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY: input.CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY ?? "opencode-password",
    CLOUD_RUNTIME_OBJECT_FORCE_PATH_STYLE: input.CLOUD_RUNTIME_OBJECT_FORCE_PATH_STYLE ?? "true",
    CLOUD_RUNTIME_QUEUE_PROVIDER: input.CLOUD_RUNTIME_QUEUE_PROVIDER ?? "postgres",
    CLOUD_RUNTIME_QUEUE: input.CLOUD_RUNTIME_QUEUE ?? "cloud-runtime-jobs",
  }
}

function resolvedEnv(input: Env) {
  const profile = providerProfile(input.CLOUD_RUNTIME_PROVIDER_PROFILE)
  return {
    profile,
    env: profile === "local-docker" ? localDockerEnv(input) : input,
  }
}

export function fromEnv(input: Record<string, string | undefined>) {
  const resolved = resolvedEnv(input)
  const env = resolved.env
  const queue = queueProvider(env.CLOUD_RUNTIME_QUEUE_PROVIDER)
  const checks = [
    check({
      name: "postgres-config",
      passed: Boolean(env.CLOUD_RUNTIME_DATABASE_URL),
      detail: env.CLOUD_RUNTIME_DATABASE_URL ? "CLOUD_RUNTIME_DATABASE_URL configured" : "CLOUD_RUNTIME_DATABASE_URL is required",
    }),
    check({
      name: "object-storage-config",
      passed: Boolean(env.CLOUD_RUNTIME_OBJECT_ENDPOINT && env.CLOUD_RUNTIME_OBJECT_BUCKET),
      detail:
        env.CLOUD_RUNTIME_OBJECT_ENDPOINT && env.CLOUD_RUNTIME_OBJECT_BUCKET
          ? `${env.CLOUD_RUNTIME_OBJECT_BUCKET} at ${env.CLOUD_RUNTIME_OBJECT_ENDPOINT}`
          : "CLOUD_RUNTIME_OBJECT_ENDPOINT and CLOUD_RUNTIME_OBJECT_BUCKET are required",
    }),
    check({
      name: "queue-config",
      passed: Boolean(env.CLOUD_RUNTIME_QUEUE),
      detail: env.CLOUD_RUNTIME_QUEUE
        ? `${queue} queue ${env.CLOUD_RUNTIME_QUEUE} configured`
        : `CLOUD_RUNTIME_QUEUE is required for ${queue} queue`,
    }),
    check({
      name: "kubernetes-config",
      passed: resolved.profile === "local-docker" || Boolean(env.CLOUD_RUNTIME_K8S_SERVER_URL && env.CLOUD_RUNTIME_K8S_TOKEN && env.CLOUD_RUNTIME_NAMESPACE),
      detail: resolved.profile === "local-docker"
        ? "skipped for local-docker profile"
        : env.CLOUD_RUNTIME_K8S_SERVER_URL && env.CLOUD_RUNTIME_K8S_TOKEN && env.CLOUD_RUNTIME_NAMESPACE
          ? `${env.CLOUD_RUNTIME_NAMESPACE} at ${env.CLOUD_RUNTIME_K8S_SERVER_URL}`
          : "CLOUD_RUNTIME_K8S_SERVER_URL, CLOUD_RUNTIME_K8S_TOKEN, and CLOUD_RUNTIME_NAMESPACE are required",
    }),
  ]
  const plans: Plan[] = [
    {
      name: "postgres-health",
      provider: "postgres",
      command: "select 1",
    },
    {
      name: "object-storage-health",
      provider: "object_storage",
      command: `head bucket ${env.CLOUD_RUNTIME_OBJECT_BUCKET ?? "<bucket>"}`,
    },
    {
      name: "queue-health",
      provider: "queue",
      command: `lease dry-run ${env.CLOUD_RUNTIME_QUEUE ?? "<queue>"}`,
    },
    ...(resolved.profile === "local-docker" ? [] : [{
      name: "kubernetes-health",
      provider: "kubernetes" as const,
      command: `GET /api/v1/namespaces/${env.CLOUD_RUNTIME_NAMESPACE ?? "<namespace>"}`,
    }]),
  ]
  return {
    ok: checks.every((item) => item.status === "passed"),
    env,
    profile: resolved.profile,
    checks,
    plans,
  }
}

export function summary(input: ReturnType<typeof fromEnv>) {
  return [
    `Cloud Runtime provider readiness: ${input.ok ? "passed" : "failed"}`,
    ...input.checks.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
    "Health check plans:",
    ...input.plans.map((item) => `  ${item.name}: ${item.command}`),
  ].join("\n")
}

function message(input: unknown) {
  if (input instanceof Error) return input.message
  return String(input)
}

function requireClient<T>(input: T | undefined, message: string): T {
  if (input) return input
  throw new Error(message)
}

function after(input: string, prefix: string) {
  if (input.startsWith(prefix)) return input.slice(prefix.length)
  return ""
}

export function defaultHealthRunner(input: {
  postgres?: QueryClient
  objectStorage?: ObjectStorageClient
  queue?: QueueClient
  kubernetes?: KubernetesHealthClient
}) {
  return async (plan: Plan) => {
    if (plan.provider === "postgres") {
      await requireClient(input.postgres, "Postgres health client is not configured").query("select 1", [])
      return { ok: true, detail: "postgres query succeeded" }
    }
    if (plan.provider === "object_storage") {
      const bucket = after(plan.command, "head bucket ")
      const client = requireClient(input.objectStorage, "Object storage health client is not configured")
      if (!client.listObjects) throw new Error("Object storage health client listObjects is not configured")
      await client.listObjects({ bucket, prefix: "", notBefore: 0 })
      return { ok: true, detail: `object storage bucket ${bucket} reachable` }
    }
    if (plan.provider === "queue") {
      const queue = after(plan.command, "lease dry-run ")
      const client = requireClient(input.queue, "Queue health client is not configured")
      if (!client.lease) throw new Error("Queue health client lease is not configured")
      await client.lease({
        queue,
        tenantID: "healthcheck",
        jobID: "healthcheck",
        workerID: "healthcheck",
        leaseTTLMS: 1000,
      })
      return { ok: true, detail: `queue ${queue} reachable` }
    }
    const namespace = after(plan.command, "GET /api/v1/namespaces/")
    await requireClient(input.kubernetes, "Kubernetes health client is not configured").getNamespace({ namespace })
    return { ok: true, detail: `kubernetes namespace ${namespace} reachable` }
  }
}

export async function runHealthChecks(input: {
  plans: Plan[]
  run: (plan: Plan) => Promise<{ ok: boolean; detail: string }>
}) {
  const checks = await Promise.all(
    input.plans.map(async (plan) => {
      const result = await input.run(plan).then(
        (result) => result,
        (error) => ({ ok: false, detail: message(error) }),
      )
      return check({
        name: plan.name,
        passed: result.ok,
        detail: result.detail,
      })
    }),
  )
  return {
    ok: checks.every((item) => item.status === "passed"),
    checks,
  }
}

export function healthSummary(input: Awaited<ReturnType<typeof runHealthChecks>>) {
  return [
    `Cloud Runtime provider health checks: ${input.ok ? "passed" : "failed"}`,
    ...input.checks.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
  ].join("\n")
}

export function evidence(input: {
  readiness: ReturnType<typeof fromEnv>
  health?: Awaited<ReturnType<typeof runHealthChecks>>
}) {
  return {
    schemaVersion: 1,
    status: input.health ? "provider_health_evidence" : "provider_readiness_evidence",
    profile: input.readiness.profile,
    readiness: {
      ok: input.readiness.ok,
      checks: input.readiness.checks,
    },
    healthPlans: input.readiness.plans,
    ...(input.health
      ? {
          health: {
            ok: input.health.ok,
            checks: input.health.checks,
          },
        }
      : {}),
  }
}

export function evidenceSummary(input: ReturnType<typeof evidence>) {
  return `${JSON.stringify(input, undefined, 2)}\n`
}

function kubernetesClient(input: {
  serverURL: string | undefined
  token: string | undefined
  fetch?: typeof fetch
}): KubernetesHealthClient {
  if (!input.serverURL) throw new Error("CLOUD_RUNTIME_K8S_SERVER_URL is required for Kubernetes health checks")
  const fetcher = input.fetch ?? fetch
  return {
    async getNamespace(request) {
      const result = await fetcher(`${input.serverURL!.replace(/\/+$/, "")}/api/v1/namespaces/${encodeURIComponent(request.namespace)}`, {
        headers: input.token ? { authorization: `Bearer ${input.token}` } : {},
      })
      if (result.ok) return { name: request.namespace }
      throw new Error(`Kubernetes namespace ${request.namespace} health check failed: ${result.status} ${await result.text()}`)
    },
  }
}

function realHealthRunner(input: { env: Env }) {
  const resolved = resolvedEnv(input.env)
  const env = resolved.env
  const postgres = CloudPostgresClient.create({ url: env.CLOUD_RUNTIME_DATABASE_URL })
  return defaultHealthRunner({
    postgres,
    objectStorage: CloudS3Client.create({
      endpoint: env.CLOUD_RUNTIME_OBJECT_ENDPOINT,
      region: env.CLOUD_RUNTIME_OBJECT_REGION,
      accessKeyID: env.CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID,
      secretAccessKey: env.CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY,
      forcePathStyle: env.CLOUD_RUNTIME_OBJECT_FORCE_PATH_STYLE !== "false",
    }),
    queue: CloudPostgresQueue.client({ client: postgres, now: Date.now }),
    ...(resolved.profile === "local-docker"
      ? {}
      : {
          kubernetes: kubernetesClient({
            serverURL: env.CLOUD_RUNTIME_K8S_SERVER_URL,
            token: env.CLOUD_RUNTIME_K8S_TOKEN,
          }),
        }),
  })
}

export function cliConfig(input?: { argv?: string[]; env?: Env }) {
  const args = input?.argv?.slice(2) ?? []
  return {
    envTemplate: args.includes("--env-template"),
    evidence: args.includes("--evidence"),
    health: args.includes("--health"),
    env: input?.env ?? Bun.env,
  }
}

export async function runCLI(input: {
  env: Env
  envTemplate?: boolean
  evidence?: boolean
  health?: boolean
  run?: (plan: Plan) => Promise<{ ok: boolean; detail: string }>
}) {
  if (input.envTemplate) {
    return {
      exitCode: 0,
      output: envTemplate({ profile: providerProfile(input.env.CLOUD_RUNTIME_PROVIDER_PROFILE) }),
    }
  }
  const readiness = fromEnv(input.env)
  if (input.evidence && (!readiness.ok || !input.health)) {
    return {
      exitCode: readiness.ok ? 0 : 1,
      output: evidenceSummary(evidence({ readiness })),
    }
  }
  if (!readiness.ok || !input.health) {
    return {
      exitCode: readiness.ok ? 0 : 1,
      output: summary(readiness),
    }
  }
  const health = await runHealthChecks({
    plans: readiness.plans,
    run: input.run ?? realHealthRunner({ env: input.env }),
  })
  if (input.evidence) {
    return {
      exitCode: health.ok ? 0 : 1,
      output: evidenceSummary(evidence({ readiness, health })),
    }
  }
  return {
    exitCode: health.ok ? 0 : 1,
    output: [summary(readiness), healthSummary(health)].join("\n"),
  }
}

if (import.meta.main) {
  const result = await runCLI(cliConfig({ argv: Bun.argv, env: Bun.env }))
  console.log(result.output)
  process.exit(result.exitCode)
}

export * as CloudProviderReadiness from "./provider-readiness"
