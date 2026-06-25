import { Database } from "bun:sqlite"
import path from "path"
import { runOnce } from "./local-worker"
import { CloudModelCredentialEnv } from "./model-credential-env"
import { CloudModelSecretStore } from "./model-secret-store"
import { CloudSQLiteRepository } from "./sqlite-repository"
import { CloudSQLiteSchema } from "./sqlite-schema"
import { CloudSQLiteService } from "./sqlite-service"

type LocalExecutor = Parameters<typeof runOnce>[0]["localExecutor"]
type Check = {
  name: string
  status: "passed" | "failed"
  detail: string
}

const tenant = {
  id: "tenant_local",
  defaultRuntimeVersion: "1.14.28",
  defaultRuntimeImage: "cloud-runtime-opencode:1.14.28",
  defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
  allowedModels: ["anthropic/claude-sonnet-4-5"],
}

function tenantForEnv(input?: { env?: Record<string, string | undefined> }) {
  const model = {
    provider: input?.env?.CLOUD_RUNTIME_MODEL_PROVIDER ?? tenant.defaultModel.provider,
    model: input?.env?.CLOUD_RUNTIME_MODEL ?? tenant.defaultModel.model,
  }
  return {
    ...tenant,
    defaultModel: model,
    allowedModels: [`${model.provider}/${model.model}`],
  }
}

function prompt(input: { jobID: string }) {
  return [
    "Local opencode smoke runtime check.",
    "Do not call bash, shell, or external tools.",
    "Create local-opencode-smoke-report.md in the current working directory with a short static runtime summary.",
    `Create .opencode-cloud/artifacts.json with JSON: {"version":1,"jobID":"${input.jobID}","artifacts":[{"name":"local-opencode-smoke-report.md","kind":"md","path":"local-opencode-smoke-report.md","mime":"text/markdown"}]}`,
    "Do not include any extra artifacts.",
  ].join("\n")
}

function idFactory() {
  const counts = new Map<string, number>()
  return (prefix: string) => {
    const next = (counts.get(prefix) ?? 0) + 1
    counts.set(prefix, next)
    return `${prefix}_${next}`
  }
}

export type Result = {
  ok: boolean
  workspaceID: string
  sessionID: string
  jobID: string
  jobStatus: string
  model: string
  sqlitePath: string
  sandboxRoot: string
  artifacts: number
  artifactNames: string[]
  events: number
  lastEvents: string[]
  error?: string
}

function config(input?: { env?: Record<string, string | undefined> }) {
  const env = input?.env ?? Bun.env
  return {
    sqlitePath: env.CLOUD_RUNTIME_SQLITE_PATH ?? ":memory:",
    sandboxRoot: env.CLOUD_RUNTIME_SANDBOX_ROOT ?? path.join("/tmp", "cloud-opencode-smoke"),
    executionTimeoutMS: timeout(env.CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS) ?? 900_000,
    modelBaseURL: env.CLOUD_RUNTIME_MODEL_BASE_URL,
  }
}

function check(input: { name: string; passed: boolean; detail: string }): Check {
  return {
    name: input.name,
    status: input.passed ? "passed" : "failed",
    detail: input.detail,
  }
}

function credentialName(input: { env?: Record<string, string | undefined>; provider: string }) {
  if (input.env?.CLOUD_RUNTIME_MODEL_CREDENTIAL_ENV) return input.env.CLOUD_RUNTIME_MODEL_CREDENTIAL_ENV
  return CloudModelCredentialEnv.envName({ provider: input.provider, providerType: input.provider })
}

function timeout(input: string | undefined) {
  const value = Number(input ?? 900_000)
  if (Number.isFinite(value) && value > 0) return value
  return undefined
}

function eventLabel(input: ReturnType<typeof CloudSQLiteRepository.listEvents>[number]) {
  if (input.type === "job.status") return `${input.type}:${input.data.status}`
  if (input.type === "job.artifact") return `${input.type}:${input.data.name}`
  if (input.type === "job.error") return `${input.type}:${input.data.message}`
  if (input.type === "job.message") return `${input.type}:${input.data.role}`
  if (input.type === "job.tool_call") return `${input.type}:${input.data.tool}:${input.data.status}`
  return input.type
}

function confirmed(input: Record<string, string | undefined>) {
  return input.CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE === "1"
}

async function commandExists(input: string) {
  const proc = Bun.spawn(["sh", "-lc", `command -v ${input}`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return await proc.exited === 0
}

async function pathWritable(input: string) {
  const proc = Bun.spawn(["sh", "-lc", `mkdir -p ${JSON.stringify(input)} && test -w ${JSON.stringify(input)}`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return await proc.exited === 0
}

export async function preflight(input?: {
  env?: Record<string, string | undefined>
  commandExists?: (command: string) => Promise<boolean>
  pathWritable?: (path: string) => Promise<boolean>
}) {
  const env = input?.env ?? Bun.env
  const activeTenant = tenantForEnv({ env })
  const cfg = config({ env })
  const key = credentialName({ env, provider: activeTenant.defaultModel.provider })
  const hasOpencode = await (input?.commandExists ?? commandExists)("opencode")
  const executionTimeout = timeout(env.CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS)
  const sqliteParent = cfg.sqlitePath === ":memory:" ? ":memory:" : path.dirname(cfg.sqlitePath)
  const writable = input?.pathWritable ?? pathWritable
  const sqliteWritable = cfg.sqlitePath === ":memory:" || await writable(sqliteParent)
  const sandboxWritable = await writable(cfg.sandboxRoot)
  const result = [
    check({
      name: "opencode-executable",
      passed: hasOpencode,
      detail: hasOpencode ? "opencode is available" : "opencode executable not found in PATH",
    }),
    check({
      name: "model-credentials",
      passed: Boolean(env[key]),
      detail: env[key]
        ? `${key} is configured`
        : `${key} is required for ${activeTenant.defaultModel.provider}/${activeTenant.defaultModel.model}`,
    }),
    check({
      name: "execution-timeout",
      passed: Boolean(executionTimeout),
      detail: executionTimeout
        ? `${executionTimeout}ms`
        : "CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS must be greater than 0",
    }),
    check({
      name: "sqlite-path",
      passed: sqliteWritable,
      detail: cfg.sqlitePath === ":memory:"
        ? "in-memory SQLite database"
        : sqliteWritable
          ? `${cfg.sqlitePath} parent ${sqliteParent} is writable`
          : `${cfg.sqlitePath} parent ${sqliteParent} is not writable`,
    }),
    check({
      name: "sandbox-root",
      passed: sandboxWritable,
      detail: sandboxWritable ? `${cfg.sandboxRoot} is writable` : `${cfg.sandboxRoot} is not writable`,
    }),
  ]
  return {
    ok: result.every((item) => item.status === "passed"),
    checks: result,
  }
}

export function plan(input?: {
  env?: Record<string, string | undefined>
}) {
  const cfg = config(input)
  const activeTenant = tenantForEnv(input)
  return {
    sqlitePath: cfg.sqlitePath,
    sandboxRoot: cfg.sandboxRoot,
    tenantID: activeTenant.id,
    model: `${activeTenant.defaultModel.provider}/${activeTenant.defaultModel.model}`,
    executionMode: "opencode",
    executionTimeoutMS: cfg.executionTimeoutMS,
    requiredEnv: [credentialName({ env: input?.env, provider: activeTenant.defaultModel.provider }), "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1"],
    ...(cfg.modelBaseURL ? { modelBaseURL: cfg.modelBaseURL } : {}),
    outputs: ["md"],
    artifactManifest: ".opencode-cloud/artifacts.json",
    reportName: "local-opencode-smoke-report.md",
  }
}

export function planSummary(input: ReturnType<typeof plan>) {
  return [
    "local opencode smoke plan",
    `SQLite:        ${input.sqlitePath}`,
    `Sandbox root:  ${input.sandboxRoot}`,
    `Tenant:        ${input.tenantID}`,
    `Model:         ${input.model}`,
    `Execution:     ${input.executionMode}`,
    `Timeout:       ${input.executionTimeoutMS}ms`,
    `Required env:  ${input.requiredEnv.join(", ")}`,
    ...(input.modelBaseURL ? [`Base URL:      ${input.modelBaseURL}`] : []),
    `Outputs:       ${input.outputs.join(", ")}`,
    `Artifact:      ${input.artifactManifest}`,
    `Report:        ${input.reportName}`,
  ].join("\n")
}

export async function run(input?: {
  db?: Database
  now?: () => number
  id?: (prefix: string) => string
  env?: Record<string, string | undefined>
  sqlitePath?: string
  sandboxRoot?: string
  localExecutor?: LocalExecutor
}) {
  const activeTenant = tenantForEnv({ env: input?.env })
  const sqlitePath = input?.sqlitePath ?? ":memory:"
  const sandboxRoot = input?.sandboxRoot ?? path.join("/tmp", "cloud-opencode-smoke")
  const db = input?.db ?? new Database(sqlitePath)
  CloudSQLiteSchema.apply({ db })
  const now = input?.now ?? Date.now
  const modelSecretStore = CloudModelSecretStore.memory()
  const service = CloudSQLiteService.create({
    db,
    tenant: activeTenant,
    tools: { mcp: {}, skills: {} },
    now,
    id: input?.id ?? idFactory(),
    modelSecretStore,
  })
  const workspace = service.createWorkspace({ name: "Local OpenCode Smoke" })
  const session = service.createSession({ workspaceID: workspace.id, userID: "local_opencode_smoke" })
  const cfg = config({ env: input?.env })
  const key = credentialName({ env: input?.env, provider: activeTenant.defaultModel.provider })
  const credential = cfg.modelBaseURL && input?.env?.[key]
    ? service.createLLMCredential({
        scope: "workspace",
        ownerKey: workspace.id,
        name: "local-opencode-smoke",
        providerType: activeTenant.defaultModel.provider,
        provider: activeTenant.defaultModel.provider,
        baseURL: cfg.modelBaseURL,
        apiKey: input.env[key]!,
        allowedModels: [activeTenant.defaultModel.model],
        defaultModel: activeTenant.defaultModel.model,
        enabled: true,
      })
    : undefined
  const job = service.createJob({
    sessionID: session.id,
    prompt: "Local opencode smoke placeholder",
    inputs: [],
    outputs: ["md"],
    runtime: { profile: "standard" },
    ...(credential
      ? {
          model: {
            provider: activeTenant.defaultModel.provider,
            model: activeTenant.defaultModel.model,
            credentialID: credential.id,
          },
        }
      : {}),
    tools: {
      webfetch: { enabled: false, allowDomains: [] },
      websearch: { enabled: false },
      mcp: [],
      skills: [],
    },
  })
  db
    .query("update cloud_message set content = ?, time_updated = ? where tenant_id = ? and job_id = ? and role = 'user'")
    .run(prompt({ jobID: job.id }), now(), activeTenant.id, job.id)
  await runOnce({
    db,
    now,
    baseEnv: input?.env ?? Bun.env,
    workerID: "local-opencode-smoke-worker",
    tenantID: activeTenant.id,
    leaseTTLMS: 30_000,
    sandboxRoot,
    bucket: "runtime-artifacts",
    namespace: "cloud-runtime",
    executionMode: "opencode",
    localExecutor: input?.localExecutor,
    modelSecretResolver: CloudModelSecretStore.resolver({ store: modelSecretStore, tenantID: activeTenant.id }),
    executionTimeoutMS: 900_000,
  })
  const found = CloudSQLiteRepository.getJob({ db, tenantID: activeTenant.id, id: job.id })
  const artifacts = service.listArtifacts({ jobID: job.id })
  const events = service.listJobEvents({ jobID: job.id })
  return {
    ok: found?.status === "succeeded" && artifacts.length > 0,
    workspaceID: workspace.id,
    sessionID: session.id,
    jobID: job.id,
    jobStatus: found?.status ?? "missing",
    model: `${activeTenant.defaultModel.provider}/${activeTenant.defaultModel.model}`,
    sqlitePath,
    sandboxRoot,
    artifacts: artifacts.length,
    artifactNames: artifacts.map((item) => item.name),
    events: events.length,
    lastEvents: events.slice(-5).map(eventLabel),
    ...(found?.error ? { error: found.error } : {}),
  } satisfies Result
}

export function summary(input: Result) {
  return [
    `local opencode smoke: ${input.ok ? "passed" : "failed"}`,
    `evidence: workspace=${input.workspaceID} session=${input.sessionID} job=${input.jobID} status=${input.jobStatus} artifacts=${input.artifacts} events=${input.events}`,
    `model: ${input.model}`,
    `paths: sqlite=${input.sqlitePath} sandbox=${input.sandboxRoot}`,
    `artifacts: ${input.artifactNames?.length ? input.artifactNames.join(", ") : "none"}`,
    `last events: ${input.lastEvents?.length ? input.lastEvents.join(" | ") : "none"}`,
    ...(input.error ? [`error: ${input.error}`] : []),
  ].join("\n")
}

export function preflightSummary(input: Awaited<ReturnType<typeof preflight>>) {
  const failed = input.checks.filter((item) => item.status === "failed")
  return [
    `local opencode smoke preflight: ${input.ok ? "passed" : "failed"}`,
    ...input.checks.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
    ...(failed.length ? ["Remediation:", ...failed.map((item) => `  - ${item.name}: ${preflightRemediation(item)}`)] : []),
  ].join("\n")
}

export function evidence(input: {
  plan: ReturnType<typeof plan>
  preflight?: Awaited<ReturnType<typeof preflight>>
  result?: Result
  confirmed: boolean
}) {
  return {
    schemaVersion: 1,
    status: input.result ? "local_opencode_smoke_evidence" : "local_opencode_preflight_evidence",
    confirmed: input.confirmed,
    plan: input.plan,
    ...(input.preflight
      ? {
          preflight: {
            ok: input.preflight.ok,
            checks: input.preflight.checks,
          },
        }
      : {}),
    ...(input.result
      ? {
          smoke: input.result,
        }
      : {}),
  }
}

export function evidenceSummary(input: ReturnType<typeof evidence>) {
  return `${JSON.stringify(input, undefined, 2)}\n`
}

function confirmationSummary() {
  return [
    "local opencode smoke confirmation: failed",
    "[failed] real-opencode-confirmation: set CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 to run real opencode smoke",
  ].join("\n")
}

function preflightRemediation(input: Check) {
  const suggestions: Record<string, string> = {
    "opencode-executable": "install opencode or add it to PATH, then rerun bun run cloud:opencode:preflight",
    "model-credentials": "export the provider API key shown above, or set CLOUD_RUNTIME_MODEL_PROVIDER/CLOUD_RUNTIME_MODEL for another configured provider",
    "execution-timeout": "set CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS to a positive millisecond value such as 900000",
    "sqlite-path": "set CLOUD_RUNTIME_SQLITE_PATH to :memory: or a file under a writable directory",
    "sandbox-root": "set CLOUD_RUNTIME_SANDBOX_ROOT to a writable directory for local workdirs and artifacts",
  }
  return suggestions[input.name] ?? `inspect ${input.name} and rerun bun run cloud:opencode:preflight`
}

export async function runCLI(input?: {
  mode?: "evidence" | "plan" | "preflight" | "run"
  env?: Record<string, string | undefined>
  preflight?: () => Promise<Awaited<ReturnType<typeof preflight>>>
  runSmoke?: () => Promise<Result>
}) {
  if (input?.mode === "plan") {
    return {
      exitCode: 0,
      output: planSummary(plan({ env: input.env })),
    }
  }
  if (input?.mode === "preflight") {
    const ready = await (input?.preflight ?? (() => preflight({ env: input?.env })))()
    return {
      exitCode: ready.ok ? 0 : 1,
      output: preflightSummary(ready),
    }
  }
  if (input?.mode === "evidence") {
    const env = input.env ?? Bun.env
    const ready = await (input.preflight ?? (() => preflight({ env })))()
    if (!confirmed(env) || !ready.ok) {
      return {
        exitCode: ready.ok ? 0 : 1,
        output: evidenceSummary(evidence({
          plan: plan({ env }),
          preflight: ready,
          confirmed: confirmed(env),
        })),
      }
    }
    const result = await (input.runSmoke ?? run)()
    return {
      exitCode: result.ok ? 0 : 1,
      output: evidenceSummary(evidence({
        plan: plan({ env }),
        preflight: ready,
        result,
        confirmed: true,
      })),
    }
  }
  if (!confirmed(input?.env ?? Bun.env)) {
    return {
      exitCode: 1,
      output: confirmationSummary(),
    }
  }
  const ready = await (input?.preflight ?? (() => preflight({ env: input?.env })))()
  if (!ready.ok) {
    return {
      exitCode: 1,
      output: preflightSummary(ready),
    }
  }
  const result = await (input?.runSmoke ?? run)()
  return {
    exitCode: result.ok ? 0 : 1,
    output: [preflightSummary(ready), summary(result)].join("\n"),
  }
}

if (import.meta.main) {
  const result = await runCLI({
    mode: Bun.argv.includes("--evidence") ? "evidence" : Bun.argv.includes("--plan") ? "plan" : Bun.argv.includes("--preflight") ? "preflight" : "run",
    env: Bun.env,
    runSmoke: () => run({ env: Bun.env, sqlitePath: Bun.env.CLOUD_RUNTIME_SQLITE_PATH, sandboxRoot: Bun.env.CLOUD_RUNTIME_SANDBOX_ROOT }),
  })
  console.log(result.output)
  process.exit(result.exitCode)
}

export * as CloudLocalOpencodeSmoke from "./local-opencode-smoke"
