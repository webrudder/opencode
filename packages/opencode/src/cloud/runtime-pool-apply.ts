import { CloudAPI } from "./api"
import { CloudKubernetesExecutor } from "./kubernetes-executor"

type Env = Record<string, string | undefined>
type Fetcher = (request: Request) => Promise<Response>
type Client = CloudKubernetesExecutor.Client
type Step = {
  name: string
  status: "passed" | "failed"
  detail: string
}

function step(input: { name: string; passed: boolean; detail: string }): Step {
  return {
    name: input.name,
    status: input.passed ? "passed" : "failed",
    detail: input.detail,
  }
}

function number(input: string | undefined) {
  const value = Number(input)
  if (Number.isFinite(value) && value >= 0) return value
  return undefined
}

function config(input: { env: Env }) {
  return {
    confirmed: input.env.CLOUD_RUNTIME_CONFIRM_APPLY_PLAN === "1",
    baseURL: input.env.CLOUD_RUNTIME_API_BASE_URL ?? input.env.CLOUD_RUNTIME_API_SMOKE_BASE_URL,
    apiKey: input.env.CLOUD_RUNTIME_API_KEY ?? "dev-api-key",
    target: input.env.CLOUD_RUNTIME_POOL_SCALE_TARGET === "local" ? "local" as const : "kubernetes" as const,
    currentRuntimes: number(input.env.CLOUD_RUNTIME_CURRENT_RUNTIMES),
    namespace: input.env.CLOUD_RUNTIME_NAMESPACE ?? "cloud-runtime",
    deploymentName: input.env.CLOUD_RUNTIME_WORKER_DEPLOYMENT_NAME ?? "cloud-runtime-worker",
    serverURL: input.env.CLOUD_RUNTIME_K8S_SERVER_URL,
    token: input.env.CLOUD_RUNTIME_K8S_TOKEN,
  }
}

function readiness(input: ReturnType<typeof config>, hasClient: boolean) {
  return [
    step({
      name: "api-base-url",
      passed: Boolean(input.baseURL),
      detail: input.baseURL ? `API ${input.baseURL}` : "CLOUD_RUNTIME_API_BASE_URL is required",
    }),
    step({
      name: "confirmation",
      passed: input.confirmed || hasClient,
      detail: input.confirmed || hasClient ? "apply-plan execution confirmed" : "set CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 before scaling runtimes",
    }),
    step({
      name: "kubernetes-server",
      passed: input.target !== "kubernetes" || Boolean(input.serverURL) || hasClient,
      detail: input.target !== "kubernetes" ? "not required for local target" : input.serverURL ? `server ${input.serverURL}` : "CLOUD_RUNTIME_K8S_SERVER_URL is required",
    }),
    step({
      name: "kubernetes-token",
      passed: input.target !== "kubernetes" || Boolean(input.token) || hasClient,
      detail: input.target !== "kubernetes" ? "not required for local target" : input.token ? "CLOUD_RUNTIME_K8S_TOKEN configured" : "CLOUD_RUNTIME_K8S_TOKEN is required",
    }),
  ]
}

function url(input: { baseURL: string; path: string }) {
  return new URL(input.path, input.baseURL.endsWith("/") ? input.baseURL : `${input.baseURL}/`)
}

async function applyPlan(input: {
  fetch: Fetcher
  baseURL: string
  apiKey: string
  body: {
    target: "local" | "kubernetes"
    currentRuntimes?: number
    namespace?: string
    deploymentName?: string
  }
}) {
  const response = await input.fetch(
    new Request(url({ baseURL: input.baseURL, path: "/admin/runtime-pools/apply-plan" }), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
    }),
  )
  if (!response.ok) throw new Error(`Cloud Runtime apply-plan failed: ${response.status} ${await response.text()}`)
  return CloudAPI.decodeRuntimePoolApplyPlanResponse(await response.json())
}

function kubernetesScaleOperations(input: CloudAPI.RuntimePoolApplyPlanResponse) {
  return input.scaleOperations
    .filter((operation) => operation.action === "scale" && operation.target === "kubernetes" && operation.desiredRuntimes !== undefined)
    .map((operation) =>
      CloudKubernetesExecutor.scaleDeployment({
        namespace: operation.namespace ?? "cloud-runtime",
        name: operation.deploymentName ?? "cloud-runtime-worker",
        replicas: operation.desiredRuntimes!,
      }),
    )
}

export async function run(input?: {
  env?: Env
  fetch?: Fetcher
  kubernetes?: Client
}) {
  const cfg = config({ env: input?.env ?? Bun.env })
  const checks = readiness(cfg, Boolean(input?.kubernetes))
  if (checks.some((item) => item.status === "failed")) {
    return {
      schemaVersion: 1,
      status: "failed" as const,
      readiness: checks,
      applyPlan: undefined,
      kubernetes: [],
    }
  }
  const applyPlanResult = await applyPlan({
    fetch: input?.fetch ?? ((request) => fetch(request)),
    baseURL: cfg.baseURL!,
    apiKey: cfg.apiKey,
    body: {
      target: cfg.target,
      ...(cfg.currentRuntimes !== undefined ? { currentRuntimes: cfg.currentRuntimes } : {}),
      namespace: cfg.namespace,
      deploymentName: cfg.deploymentName,
    },
  })
  const operations = cfg.target === "kubernetes" ? kubernetesScaleOperations(applyPlanResult) : []
  const client = input?.kubernetes ?? (cfg.target === "kubernetes"
    ? CloudKubernetesExecutor.fetchClient({ serverURL: cfg.serverURL!, token: cfg.token })
    : undefined)
  const kubernetes = client && operations.length
    ? await CloudKubernetesExecutor.run({ client, operations })
    : []
  return {
    schemaVersion: 1,
    status: "passed" as const,
    readiness: checks,
    applyPlan: applyPlanResult,
    kubernetes,
  }
}

export function summary(input: Awaited<ReturnType<typeof run>>) {
  return [
    `Cloud Runtime apply-plan: ${input.status}`,
    ...input.readiness.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
    ...(input.applyPlan
      ? [
          `Action: ${input.applyPlan.action}`,
          `Desired runtimes: ${input.applyPlan.desiredRuntimes}`,
          `Drained runtimes: ${input.applyPlan.drainedRuntimeIDs.join(",") || "none"}`,
          `Released sessions: ${input.applyPlan.releasedSessionIDs.join(",") || "none"}`,
          `Kubernetes operations: ${input.kubernetes.length}`,
        ]
      : []),
  ].join("\n")
}

export function evidence(input: Awaited<ReturnType<typeof run>>) {
  return `${JSON.stringify(input, undefined, 2)}\n`
}

export async function runCLI(input?: {
  env?: Env
  fetch?: Fetcher
  kubernetes?: Client
  json?: boolean
}) {
  const result = await run(input)
  return {
    exitCode: result.status === "passed" ? 0 : 1,
    output: input?.json ? evidence(result) : `${summary(result)}\n`,
  }
}

if (import.meta.main) {
  const result = await runCLI({ json: Bun.argv.includes("--json") })
  console.log(result.output)
  process.exit(result.exitCode)
}

export * as CloudRuntimePoolApply from "./runtime-pool-apply"
