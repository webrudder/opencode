import { CloudKubernetesExecutor } from "./kubernetes-executor"
import { CloudRuntime } from "./runtime"
import { CloudWorker } from "./worker"

type Env = Record<string, string | undefined>
export type Client = CloudKubernetesExecutor.Client
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

function message(input: unknown) {
  if (input instanceof Error) return input.message
  return String(input)
}

function config(input: { env: Env }) {
  return {
    confirmed: input.env.CLOUD_RUNTIME_CONFIRM_K8S_SMOKE === "1",
    serverURL: input.env.CLOUD_RUNTIME_K8S_SERVER_URL,
    token: input.env.CLOUD_RUNTIME_K8S_TOKEN,
    allowLocalProxy: input.env.CLOUD_RUNTIME_K8S_ALLOW_LOCAL_PROXY === "1",
    namespace: input.env.CLOUD_RUNTIME_NAMESPACE ?? "cloud-runtime",
    image: input.env.CLOUD_RUNTIME_K8S_SMOKE_IMAGE ?? input.env.CLOUD_RUNTIME_RUNTIME_IMAGE ?? "cloud-runtime-opencode:1.14.28",
    serviceAccountName: input.env.CLOUD_RUNTIME_K8S_SERVICE_ACCOUNT,
    pollIntervalMS: Number(input.env.CLOUD_RUNTIME_K8S_SMOKE_POLL_MS ?? 1000),
    maxPolls: Number(input.env.CLOUD_RUNTIME_K8S_SMOKE_MAX_POLLS ?? 120),
    jobID: input.env.CLOUD_RUNTIME_K8S_SMOKE_JOB_ID ?? `k8s_smoke_${Date.now()}`,
  }
}

function launch(input: ReturnType<typeof config>) {
  const spec = CloudRuntime.decodeJobSpec({
    id: input.jobID,
    tenantID: "tenant_k8s_smoke",
    workspaceID: "workspace_k8s_smoke",
    sessionID: "session_k8s_smoke",
    runtime: {
      engine: "opencode",
      version: "1.14.28",
      image: input.image,
      profile: "small",
    },
    model: { provider: "smoke", model: "none" },
    tools: {
      webfetch: { enabled: false, allowDomains: [] },
      websearch: { enabled: false },
      mcp: {},
      skills: [],
    },
    permissions: {
      filesystem: "workspace_only",
      shell: "restricted",
      network: [],
    },
    inputs: [],
    outputs: ["json"],
  })
  return {
    ...CloudWorker.launchPlan(spec, { workdir: "/tmp", prompt: "kubernetes smoke" }),
    command: "/bin/sh",
    args: ["-lc", "echo cloud-runtime-k8s-smoke"],
    env: {
      CLOUD_RUNTIME_K8S_SMOKE: "1",
    },
  }
}

function readiness(input: ReturnType<typeof config>) {
  return [
    step({
      name: "confirmation",
      passed: input.confirmed,
      detail: input.confirmed ? "CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1" : "set CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 before creating Kubernetes smoke pods",
    }),
    step({
      name: "server-url",
      passed: Boolean(input.serverURL),
      detail: input.serverURL ? `server ${input.serverURL}` : "CLOUD_RUNTIME_K8S_SERVER_URL is required",
    }),
    step({
      name: "token",
      passed: Boolean(input.token) || input.allowLocalProxy,
      detail: input.token
        ? "CLOUD_RUNTIME_K8S_TOKEN configured"
        : input.allowLocalProxy
          ? "tokenless local kubectl proxy allowed"
          : "CLOUD_RUNTIME_K8S_TOKEN is required",
    }),
    step({
      name: "namespace",
      passed: Boolean(input.namespace),
      detail: `namespace ${input.namespace}`,
    }),
    step({
      name: "image",
      passed: Boolean(input.image),
      detail: `image ${input.image}`,
    }),
  ]
}

export async function run(input?: {
  env?: Env
  client?: Client
  now?: () => number
  confirmed?: boolean
}) {
  const cfg = config({ env: input?.env ?? Bun.env })
  const resolved = {
    ...cfg,
    confirmed: input?.confirmed ?? (input?.client !== undefined || cfg.confirmed),
    jobID: input?.env?.CLOUD_RUNTIME_K8S_SMOKE_JOB_ID ?? `k8s_smoke_${input?.now?.() ?? Date.now()}`,
  }
  const checks = readiness(resolved)
  if (checks.some((item) => item.status === "failed")) {
    return {
      schemaVersion: 1,
      status: "failed" as const,
      readiness: checks,
      result: undefined,
    }
  }
  const client = input?.client ?? CloudKubernetesExecutor.fetchClient({
    serverURL: resolved.serverURL!,
    token: resolved.token,
    pollIntervalMS: resolved.pollIntervalMS,
    maxPolls: resolved.maxPolls,
  })
  const launchPlan = launch(resolved)
  const result = await CloudKubernetesExecutor.runSandbox({
    namespace: resolved.namespace,
    launch: launchPlan,
    client,
    serviceAccountName: resolved.serviceAccountName,
    labels: {
      "cloud.opencode.ai/smoke": "kubernetes",
    },
  }).then(
    (result) => result,
    (error) => ({
      jobID: launchPlan.sandbox.jobID,
      podName: `opencode-${launchPlan.sandbox.jobID.replaceAll("_", "-")}`,
      status: "failed" as const,
      logs: message(error),
      podStatus: {},
    }),
  )
  return {
    schemaVersion: 1,
    status: result.status === "succeeded" ? "passed" as const : "failed" as const,
    readiness: checks,
    target: {
      namespace: resolved.namespace,
      image: resolved.image,
      jobID: resolved.jobID,
    },
    result,
  }
}

export function summary(input: Awaited<ReturnType<typeof run>>) {
  return [
    `Cloud Runtime Kubernetes smoke: ${input.status}`,
    ...input.readiness.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
    ...(input.result
      ? [
          `Result: ${input.result.status}`,
          `Pod: ${input.result.podName}`,
          `Logs: ${input.result.logs.slice(0, 240)}`,
        ]
      : []),
  ].join("\n")
}

export function evidence(input: Awaited<ReturnType<typeof run>>) {
  return `${JSON.stringify(input, undefined, 2)}\n`
}

export async function runCLI(input?: {
  env?: Env
  client?: Client
  now?: () => number
  confirmed?: boolean
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

export * as CloudKubernetesSmoke from "./kubernetes-smoke"
