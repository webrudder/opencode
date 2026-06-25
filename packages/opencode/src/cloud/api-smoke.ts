import { createServer } from "node:net"
import * as CloudLocalAPI from "./local-api"
import { CloudServer } from "./server"

type Fetch = (input: Request) => Promise<Response>
type Server = Awaited<ReturnType<typeof CloudLocalAPI.serve>>["server"]
type Serve = (input: Parameters<typeof CloudLocalAPI.serve>[0]) => Promise<{ server: Server }>

type Step = {
  name: string
  method: string
  path: string
  status: number
  ok: boolean
  detail: string
}

type RequestResult = {
  status: number
  ok: boolean
  body: unknown
}

function config(input?: {
  env?: Record<string, string | undefined>
}) {
  const env = input?.env ?? Bun.env
  return {
    baseURL: env.CLOUD_RUNTIME_API_SMOKE_BASE_URL,
    apiKey: env.CLOUD_RUNTIME_API_KEY ?? "dev-api-key",
    hostname: env.CLOUD_RUNTIME_API_SMOKE_HOSTNAME ?? "127.0.0.1",
    port: Number(env.CLOUD_RUNTIME_API_SMOKE_PORT ?? 0),
    realServer: env.CLOUD_RUNTIME_API_SMOKE_REAL_SERVER === "1",
    serviceVersion: env.CLOUD_RUNTIME_SERVICE_VERSION ?? "smoke",
  }
}

function url(input: { baseURL: string; path: string }) {
  return new URL(input.path, input.baseURL.endsWith("/") ? input.baseURL : `${input.baseURL}/`)
}

async function body(response: Response) {
  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("application/json")) return response.json()
  return response.text()
}

async function request(input: {
  fetch: Fetch
  baseURL: string
  apiKey: string
  method: string
  path: string
  body?: unknown
}): Promise<RequestResult> {
  const response = await input.fetch(
    new Request(url({ baseURL: input.baseURL, path: input.path }), {
      method: input.method,
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        ...(input.body ? { "content-type": "application/json" } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    }),
  )
  return {
    status: response.status,
    ok: response.ok,
    body: await body(response),
  }
}

function step(input: {
  name: string
  method: string
  path: string
  result: RequestResult
  passed: boolean
  detail: string
}): Step {
  return {
    name: input.name,
    method: input.method,
    path: input.path,
    status: input.result.status,
    ok: input.result.ok && input.passed,
    detail: input.detail,
  }
}

function id(input: unknown) {
  if (!input || typeof input !== "object" || !("id" in input)) return undefined
  return typeof input.id === "string" ? input.id : undefined
}

function healthy(input: unknown) {
  if (!input || typeof input !== "object" || !("healthy" in input)) return false
  return input.healthy === true
}

function hasPath(input: unknown, path: string) {
  return JSON.stringify(input).includes(path)
}

function array(input: unknown) {
  return Array.isArray(input)
}

async function freePort(input: { hostname: string }) {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, input.hostname, () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export async function runWorkflow(input: {
  baseURL: string
  apiKey: string
  fetch?: Fetch
}) {
  const fetch = input.fetch ?? globalThis.fetch
  const health = await request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "GET", path: "/health" })
  const openapi = await request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "GET", path: "/openapi.json" })
  const credential = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "POST",
    path: "/v1/llm-credentials",
    body: {
      scope: "external_user",
      ownerKey: "smoke_integrator/smoke_tenant/smoke_user",
      name: "Smoke BYOK",
      providerType: "anthropic",
      provider: "anthropic",
      apiKey: "sk-smoke-redacted",
      allowedModels: ["claude-sonnet-4-5"],
      defaultModel: "claude-sonnet-4-5",
    },
  })
  const credentials = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "GET",
    path: "/v1/llm-credentials",
  })
  const credentialTest = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "POST",
    path: `/v1/llm-credentials/${id(credential.body) ?? "missing_credential"}/test`,
  })
  const runtimePool = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "GET",
    path: "/admin/runtime-pools",
  })
  const runtimePolicy = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "PATCH",
    path: "/admin/integrators/smoke_integrator/runtime-policy",
    body: {
      defaultExecutionMode: "shared_session_pool",
      allowedExecutionModes: ["shared_session_pool", "isolated_job_runtime"],
      maxActiveJobs: 10,
      maxSessions: 100,
      maxConcurrentJobsPerSession: 1,
    },
  })
  const runtimePolicyRead = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "GET",
    path: "/admin/integrators/smoke_integrator/runtime-policy",
  })
  const workspace = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "POST",
    path: "/v1/workspaces",
    body: { name: "Smoke Workspace" },
  })
  const session = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "POST",
    path: "/v1/sessions",
    body: { workspaceID: id(workspace.body) ?? "missing_workspace", userID: "smoke_user", title: "API Smoke" },
  })
  const file = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "POST",
    path: "/v1/files",
    body: {
      workspaceID: id(workspace.body) ?? "missing_workspace",
      sessionID: id(session.body) ?? "missing_session",
      name: "input.csv",
      contentBase64: Buffer.from("name,value\nalpha,1\n").toString("base64"),
    },
  })
  const job = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "POST",
    path: "/v1/jobs",
    body: {
      sessionID: id(session.body) ?? "missing_session",
      prompt: "Summarize the uploaded CSV.",
      inputs: [id(file.body) ?? "missing_file"],
      outputs: ["md", "json"],
      runtime: { profile: "standard" },
      model: {
        credentialID: id(credential.body) ?? "missing_credential",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      },
      integratorID: "smoke_integrator",
      externalTenantID: "smoke_tenant",
      externalUserID: "smoke_user",
      tools: {
        webfetch: { enabled: false, allowDomains: [] },
        websearch: { enabled: false },
        mcp: [],
        skills: [],
      },
    },
  })
  const events = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "GET",
    path: `/v1/jobs/${id(job.body) ?? "missing_job"}/events`,
  })
  const tools = await request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "GET", path: "/v1/tools" })
  const artifacts = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "GET",
    path: `/v1/artifacts?jobID=${id(job.body) ?? "missing_job"}`,
  })
  const cancel = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "POST",
    path: `/v1/jobs/${id(job.body) ?? "missing_job"}/cancel`,
  })
  const credentialUpdate = await request({
    fetch,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    method: "PATCH",
    path: `/v1/llm-credentials/${id(credential.body) ?? "missing_credential"}`,
    body: { enabled: false },
  })
  const steps = [
    step({ name: "health", method: "GET", path: "/health", result: health, passed: healthy(health.body), detail: "health endpoint reports healthy" }),
    step({ name: "openapi", method: "GET", path: "/openapi.json", result: openapi, passed: hasPath(openapi.body, "/v1/jobs") && hasPath(openapi.body, "/v1/llm-credentials") && hasPath(openapi.body, "/admin/runtime-pools"), detail: "OpenAPI document includes public, credential, and admin routes" }),
    step({ name: "create-llm-credential", method: "POST", path: "/v1/llm-credentials", result: credential, passed: Boolean(id(credential.body)) && !JSON.stringify(credential.body).includes("sk-smoke-redacted"), detail: "BYOK credential can be created without leaking the API key" }),
    step({ name: "list-llm-credentials", method: "GET", path: "/v1/llm-credentials", result: credentials, passed: array(credentials.body), detail: "BYOK credentials can be listed" }),
    step({ name: "test-llm-credential", method: "POST", path: `/v1/llm-credentials/${id(credential.body) ?? "missing_credential"}/test`, result: credentialTest, passed: credentialTest.ok && JSON.stringify(credentialTest.body).includes(id(credential.body) ?? "missing_credential"), detail: "BYOK credential test endpoint returns status evidence" }),
    step({ name: "admin-runtime-pool", method: "GET", path: "/admin/runtime-pools", result: runtimePool, passed: runtimePool.ok && JSON.stringify(runtimePool.body).includes("\"runtimes\""), detail: "admin runtime pool summary returned" }),
    step({ name: "admin-runtime-policy", method: "PATCH", path: "/admin/integrators/smoke_integrator/runtime-policy", result: runtimePolicy, passed: runtimePolicy.ok && JSON.stringify(runtimePolicy.body).includes("shared_session_pool"), detail: "admin integrator runtime policy can be updated" }),
    step({ name: "admin-runtime-policy-read", method: "GET", path: "/admin/integrators/smoke_integrator/runtime-policy", result: runtimePolicyRead, passed: runtimePolicyRead.ok && JSON.stringify(runtimePolicyRead.body).includes("smoke_integrator"), detail: "admin integrator runtime policy can be read back" }),
    step({ name: "create-workspace", method: "POST", path: "/v1/workspaces", result: workspace, passed: Boolean(id(workspace.body)), detail: "workspace id returned" }),
    step({ name: "create-session", method: "POST", path: "/v1/sessions", result: session, passed: Boolean(id(session.body)), detail: "session id returned" }),
    step({ name: "upload-file", method: "POST", path: "/v1/files", result: file, passed: Boolean(id(file.body)), detail: "file id returned" }),
    step({ name: "create-job", method: "POST", path: "/v1/jobs", result: job, passed: Boolean(id(job.body)), detail: "job id returned" }),
    step({ name: "list-events", method: "GET", path: `/v1/jobs/${id(job.body) ?? "missing_job"}/events`, result: events, passed: Array.isArray(events.body), detail: "job events listed" }),
    step({ name: "list-tools", method: "GET", path: "/v1/tools", result: tools, passed: Boolean(tools.body), detail: "tool catalog returned" }),
    step({ name: "list-artifacts", method: "GET", path: `/v1/artifacts?jobID=${id(job.body) ?? "missing_job"}`, result: artifacts, passed: Array.isArray(artifacts.body), detail: "artifact list returned" }),
    step({ name: "cancel-job", method: "POST", path: `/v1/jobs/${id(job.body) ?? "missing_job"}/cancel`, result: cancel, passed: id(cancel.body) === id(job.body), detail: "queued job can be canceled" }),
    step({ name: "update-llm-credential", method: "PATCH", path: `/v1/llm-credentials/${id(credential.body) ?? "missing_credential"}`, result: credentialUpdate, passed: credentialUpdate.ok && JSON.stringify(credentialUpdate.body).includes("\"enabled\":false"), detail: "BYOK credential can be disabled for new jobs" }),
  ]
  return {
    schemaVersion: 1,
    status: steps.every((item) => item.ok) ? "passed" as const : "failed" as const,
    baseURL: input.baseURL,
    steps,
    ids: {
      workspaceID: id(workspace.body),
      sessionID: id(session.body),
      fileID: id(file.body),
      jobID: id(job.body),
      credentialID: id(credential.body),
    },
  }
}

export function summary(input: Awaited<ReturnType<typeof runWorkflow>>) {
  return [
    `Cloud Runtime API smoke: ${input.status}`,
    `Base URL: ${input.baseURL}`,
    ...input.steps.map((item) => `[${item.ok ? "passed" : "failed"}] ${item.name}: ${item.method} ${item.path} -> ${item.status} (${item.detail})`),
  ].join("\n")
}

export async function runCLI(input?: {
  env?: Record<string, string | undefined>
  serve?: Serve
  fetch?: Fetch
  json?: boolean
}) {
  const cfg = config(input)
  const port = !cfg.baseURL && cfg.realServer && cfg.port === 0 ? await freePort({ hostname: cfg.hostname }) : cfg.port
  const local = cfg.baseURL || !cfg.realServer
    ? undefined
    : await (input?.serve ?? CloudLocalAPI.serve)({
        env: {
          ...(input?.env ?? Bun.env),
          CLOUD_RUNTIME_STORAGE: "memory",
          CLOUD_RUNTIME_HTTP_HOSTNAME: cfg.hostname,
          CLOUD_RUNTIME_HTTP_PORT: String(port),
          CLOUD_RUNTIME_SERVICE_VERSION: cfg.serviceVersion,
        },
      })
  const app = cfg.baseURL || cfg.realServer ? undefined : CloudServer.create({ serviceVersion: cfg.serviceVersion }).app
  try {
    const result = await runWorkflow({
      baseURL: cfg.baseURL ?? (cfg.realServer ? `http://${local?.server.hostname ?? cfg.hostname}:${local?.server.port ?? port}` : "http://cloud-runtime.local"),
      apiKey: cfg.apiKey,
      fetch: input?.fetch ?? (app ? async (request) => app.fetch(request) : undefined),
    })
    return {
      exitCode: result.status === "passed" ? 0 : 1,
      output: input?.json ? `${JSON.stringify(result, undefined, 2)}\n` : `${summary(result)}\n`,
    }
  } finally {
    local?.server.stop(true)
  }
}

if (import.meta.main) {
  const result = await runCLI({ json: Bun.argv.includes("--json") })
  console.log(result.output)
  process.exit(result.exitCode)
}

export * as CloudAPISmoke from "./api-smoke"
