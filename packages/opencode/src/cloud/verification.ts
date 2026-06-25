import path from "path"
import { CloudLocalOpencodeSmoke } from "./local-opencode-smoke"
import { CloudProviderReadiness } from "./provider-readiness"

type Mode = "safe" | "explicit"
type Step = {
  name: string
  mode: Mode
  command: string
  detail: string
}
type StepResult = {
  step: Step
  ok: boolean
  stdout: string
  stderr: string
}
type AuditItem = {
  name: string
  status: "passed" | "failed"
  detail: string
}
type CheckSection = {
  name: string
  ok: boolean
  output: string
}
type RequirementStatus = "implemented" | "implemented_needs_real_run" | "planned_adapter"
type RunbookStep = {
  name: string
  command: string
  successEvidence: string
  failureTriage: string
}
type Probe = {
  name: string
  command: string
}
type DockerProfile = "opencode" | "shared"
type LocalAcceptance = {
  title: string
  purpose: string
  prerequisites: string[]
  steps: RunbookStep[]
  completionEvidence: string[]
}

function step(input: Step) {
  return input
}

function audit(input: { name: string; passed: boolean; detail: string }): AuditItem {
  return {
    name: input.name,
    status: input.passed ? "passed" : "failed",
    detail: input.detail,
  }
}

function shellArg(input: string) {
  return `'${input.replaceAll("'", "'\\''")}'`
}

function timeout(input: string | undefined) {
  const value = Number(input ?? 900_000)
  if (Number.isFinite(value) && value > 0) return value
  return undefined
}

function credentialName(input: { provider: string }) {
  if (input.provider === "anthropic") return "ANTHROPIC_API_KEY"
  if (input.provider === "openai") return "OPENAI_API_KEY"
  return `${input.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`
}

const providerSampleEnv = [
  "CLOUD_RUNTIME_DATABASE_URL=postgres://opencode:secret@postgres.example.com:5432/cloud_runtime",
  "CLOUD_RUNTIME_OBJECT_ENDPOINT=https://s3.example.com",
  "CLOUD_RUNTIME_OBJECT_BUCKET=runtime-artifacts",
  "CLOUD_RUNTIME_QUEUE=cloud-runtime-jobs",
  "CLOUD_RUNTIME_K8S_SERVER_URL=https://kubernetes.example.com",
  "CLOUD_RUNTIME_K8S_TOKEN=token_abc",
  "CLOUD_RUNTIME_NAMESPACE=cloud-runtime",
].join(" ")

const releaseSampleEnv = [
  "CLOUD_RUNTIME_RELEASE_VERSION=1.15.0",
  "CLOUD_RUNTIME_RELEASE_STAGE=canary",
  "CLOUD_RUNTIME_RELEASE_IMAGE_DIGEST=sha256:canary",
  "CLOUD_RUNTIME_RELEASE_JOBS=100",
  "CLOUD_RUNTIME_RELEASE_FAILURE_RATE=0.01",
  "CLOUD_RUNTIME_RELEASE_P95_DURATION_MS=120000",
  "CLOUD_RUNTIME_RELEASE_SANDBOX_START_P95_MS=10000",
  "CLOUD_RUNTIME_RELEASE_COST_PER_JOB_USD=0.25",
  providerSampleEnv,
].join(" ")

const requirementEvidence: Array<{
  id: string
  status: RequirementStatus
  evidence: string[]
  remainingProof: string[]
}> = [
  {
    id: "low_intrusion_opencode_kernel",
    status: "implemented",
    evidence: ["src/cloud/runtime.ts", "src/cloud/worker.ts", "test/cloud/runtime.test.ts", "test/cloud/worker.test.ts"],
    remainingProof: ["code review before merge"],
  },
  {
    id: "public_cloud_runtime_api",
    status: "implemented",
    evidence: [
      "src/cloud/routes.ts",
      "src/cloud/api.ts",
      "src/cloud/openapi.ts",
      "src/cloud/api-smoke.ts",
      "src/cloud/model-secret-store.ts",
      "src/cloud/model-secret-adapter.ts",
      "src/cloud/model-secret-runner.ts",
      "test/cloud/routes.test.ts",
      "test/cloud/openapi.test.ts",
      "test/cloud/api-smoke.test.ts",
      "test/cloud/model-secret-store.test.ts",
      "test/cloud/model-secret-adapter.test.ts",
      "test/cloud/model-secret-runner.test.ts",
      "cloud:api:smoke covers workspace/session/file/job/events/artifacts/tools, BYOK credentials, external-user scoped job model selection, and admin runtime policy endpoints",
    ],
    remainingProof: ["run cloud:api:smoke against deployed API with CLOUD_RUNTIME_API_SMOKE_BASE_URL"],
  },
  {
    id: "sqlite_local_mvp",
    status: "implemented",
    evidence: ["src/cloud/sqlite-server.ts", "src/cloud/sqlite-worker-loop.ts", "test/cloud/sqlite-server.test.ts", "test/cloud/sqlite-worker-loop.test.ts"],
    remainingProof: ["optional manual local run"],
  },
  {
    id: "real_local_opencode_executor",
    status: "implemented",
    evidence: ["src/cloud/local-executor.ts", "src/cloud/local-worker.ts", "src/cloud/local-opencode-smoke.ts", "test/cloud/local-executor.test.ts", "test/cloud/local-opencode-smoke.test.ts"],
    remainingProof: ["run additional provider/model combinations as needed"],
  },
  {
    id: "local_docker_runtime_topology",
    status: "implemented",
    evidence: [
      "src/cloud/local-docker.ts",
      "test/cloud/local-docker.test.ts",
      "cloud:docker:shared:check",
      "cloud:docker:shared:smoke",
      "CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run",
      "CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run",
    ],
    remainingProof: ["run real model-backed Docker smoke when provider credentials are available"],
  },
  {
    id: "postgres_control_plane_and_queue",
    status: "implemented",
    evidence: ["src/cloud/postgres-server.ts", "src/cloud/postgres-worker-loop.ts", "src/cloud/postgres-queue.ts", "test/cloud/postgres-server.test.ts", "test/cloud/postgres-worker-loop.test.ts"],
    remainingProof: ["run full API/worker load and visibility-timeout tests against target Postgres"],
  },
  {
    id: "s3_compatible_object_storage",
    status: "implemented",
    evidence: ["src/cloud/s3-client.ts", "src/cloud/s3-storage-runner.ts", "src/cloud/storage-service.ts", "test/cloud/s3-storage-runner.test.ts", "test/cloud/storage-service.test.ts"],
    remainingProof: ["run artifact upload/download workload against target S3/R2/GCS bucket"],
  },
  {
    id: "kubernetes_sandbox_executor",
    status: "implemented",
    evidence: [
      "src/cloud/kubernetes.ts",
      "src/cloud/kubernetes-executor.ts",
      "src/cloud/kubernetes-smoke.ts",
      "src/cloud/production-worker.ts",
      "test/cloud/kubernetes-executor.test.ts",
      "test/cloud/kubernetes-smoke.test.ts",
      "test/cloud/production-worker.test.ts",
      "kind local smoke: CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 CLOUD_RUNTIME_K8S_SERVER_URL=http://127.0.0.1:18001 CLOUD_RUNTIME_K8S_ALLOW_LOCAL_PROXY=1 bun run cloud:k8s:smoke:json",
    ],
    remainingProof: ["run against a staging/production Kubernetes namespace"],
  },
  {
    id: "runtime_pool_apply_plan",
    status: "implemented_needs_real_run",
    evidence: ["src/cloud/runtime-pool-apply.ts", "src/cloud/runtime-pool-scaler.ts", "test/cloud/runtime-pool-apply.test.ts", "test/cloud/runtime-pool-scaler.test.ts"],
    remainingProof: ["CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply"],
  },
  {
    id: "mcp_skills_connectors_policy",
    status: "implemented",
    evidence: ["src/cloud/tool-policy.ts", "src/cloud/tool-catalog.ts", "src/cloud/connector.ts", "test/cloud/tool-policy.test.ts", "test/cloud/connector.test.ts"],
    remainingProof: ["connect real managed MCP servers and connector gateway"],
  },
  {
    id: "observability_cost_release",
    status: "implemented",
    evidence: [
      "src/cloud/metrics.ts",
      "src/cloud/alert.ts",
      "src/cloud/usage.ts",
      "src/cloud/release.ts",
      "test/cloud/metrics.test.ts",
      "test/cloud/release.test.ts",
      "CloudRelease.githubActionsWorkflow",
      "CloudRelease.checkGithubActionsWorkflow",
    ],
    remainingProof: ["wire real OTEL collector, dashboards, billing sink, and run CI image promotion against a registry"],
  },
  {
    id: "sdk_and_example_saas",
    status: "implemented",
    evidence: ["src/cloud/sdk.ts", "src/cloud/example-saas.ts", "test/cloud/sdk.test.ts", "test/cloud/example-saas.test.ts"],
    remainingProof: ["publish package and run against deployed API"],
  },
]

export function plan(input?: {
  dockerDirectory?: string
  kubernetesDirectory?: string
  dockerProfile?: DockerProfile
  allowModelessDockerSmoke?: boolean
}) {
  const dockerProfile = input?.dockerProfile ?? "opencode"
  const dockerDirectory = input?.dockerDirectory ?? (dockerProfile === "shared" ? ".cloud-runtime-shared" : ".cloud-runtime-opencode")
  const kubernetesDirectory = input?.kubernetesDirectory ?? ".cloud-runtime-k8s"
  const dockerGenerateCommand = dockerProfile === "shared"
    ? `CLOUD_RUNTIME_STORAGE_BACKEND=postgres CLOUD_RUNTIME_EXECUTION_MODE=shared-session bun run cloud:docker ${dockerDirectory}`
    : `CLOUD_RUNTIME_EXECUTION_MODE=opencode CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS=900000 bun run cloud:docker ${dockerDirectory}`
  const dockerSmokeCommand = `${input?.allowModelessDockerSmoke ? "CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 " : ""}CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:run ${dockerDirectory}`
  const providerCheckCommand = dockerProfile === "shared"
    ? "CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker bun run cloud:providers:check"
    : `${providerSampleEnv} bun run cloud:providers:check`
  const providerHealthCommand = dockerProfile === "shared"
    ? "CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker bun run cloud:providers:check --health"
    : "bun run cloud:providers:check --health"
  return {
    dockerDirectory,
    dockerProfile,
    kubernetesDirectory,
    steps: [
      step({
        name: "generate-docker",
        mode: "safe",
        command: dockerGenerateCommand,
        detail: "write local API, worker, runtime Dockerfiles, Compose, README, and smoke workflow files",
      }),
      step({
        name: "check-docker",
        mode: "safe",
        command: `bun run cloud:docker:check ${dockerDirectory}`,
        detail: "validate generated Docker topology without starting Docker",
      }),
      step({
        name: "plan-docker-smoke",
        mode: "safe",
        command: `bun run cloud:docker:smoke ${dockerDirectory}`,
        detail: "print the real Docker smoke workflow without executing it",
      }),
      step({
        name: "plan-shared-docker-e2e",
        mode: "safe",
        command: "bun run cloud:docker:e2e",
        detail: "write the shared-session Docker topology and print the modeless/BYOK E2E smoke commands without starting Docker",
      }),
      step({
        name: "plan-local-opencode",
        mode: "safe",
        command: "bun run cloud:opencode:plan",
        detail: "print local opencode smoke requirements without model execution",
      }),
      step({
      name: "smoke-api-server",
      mode: "safe",
      command: "bun run cloud:api:smoke",
      detail: "start a local Cloud Runtime HTTP server and verify the SaaS API, BYOK credential, and admin runtime policy workflow",
      }),
      step({
        name: "check-providers",
        mode: "safe",
        command: providerCheckCommand,
        detail: "validate provider readiness with sample non-network environment and print health plans",
      }),
      step({
        name: "generate-kubernetes",
        mode: "safe",
        command: `bun run cloud:k8s ${kubernetesDirectory}`,
        detail: "render Kubernetes deployment manifests",
      }),
      step({
        name: "check-kubernetes",
        mode: "safe",
        command: `bun run cloud:k8s:check ${kubernetesDirectory}`,
        detail: "validate rendered Kubernetes manifests before apply",
      }),
      step({
        name: "check-release",
        mode: "safe",
        command: `${releaseSampleEnv} bun run cloud:release:check`,
        detail: "combine Kubernetes, Docker, provider, and sample runtime metrics gates for CI",
      }),
      step({
        name: "plan-release-workflow",
        mode: "safe",
        command: `${releaseSampleEnv} bun run cloud:release:github-actions`,
        detail: "render the GitHub Actions runtime image publish workflow without pushing images",
      }),
      step({
        name: "run-real-opencode-smoke",
        mode: "explicit",
        command: "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 bun run cloud:opencode:smoke",
        detail: "runs a real local opencode/model job after explicit confirmation and credentials",
      }),
      step({
        name: "run-real-docker-smoke",
        mode: "explicit",
        command: dockerSmokeCommand,
        detail: "builds images, starts Compose services, verifies API/worker/artifact flow, and cleans up",
      }),
      step({
        name: "run-provider-health",
        mode: "explicit",
        command: providerHealthCommand,
        detail: "connects to real Postgres, S3-compatible storage, queue, and Kubernetes namespace",
      }),
      step({
        name: "run-provider-smoke",
        mode: "explicit",
        command: "CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke",
        detail: "applies Postgres schema, verifies queue enqueue/lease/ack, and object storage put/list/get/sign/delete",
      }),
      step({
        name: "run-kubernetes-smoke",
        mode: "explicit",
        command: "CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 bun run cloud:k8s:smoke",
        detail: "creates a Kubernetes NetworkPolicy and smoke Pod, waits for success, reads logs, and deletes resources",
      }),
      step({
        name: "run-runtime-pool-apply",
        mode: "explicit",
        command: "CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply",
        detail: "calls the deployed admin apply-plan endpoint and applies returned runtime worker scale operations",
      }),
    ],
  }
}

export function realEnvironmentAudit(input?: {
  env?: Record<string, string | undefined>
  dockerDirectory?: string
}) {
  const env = input?.env ?? Bun.env
  const dockerDirectory = input?.dockerDirectory ?? ".cloud-runtime-opencode"
  const model = {
    provider: env.CLOUD_RUNTIME_MODEL_PROVIDER ?? "anthropic",
    model: env.CLOUD_RUNTIME_MODEL ?? "claude-sonnet-4-5",
  }
  const modelKey = credentialName({ provider: model.provider })
  const executionTimeout = timeout(env.CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS)
  const checks = [
    audit({
      name: "real-opencode-confirmation",
      passed: env.CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE === "1",
      detail: env.CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE === "1"
        ? "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1"
        : "set CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 before running real local opencode smoke",
    }),
    audit({
      name: "real-opencode-model",
      passed: Boolean(model.provider && model.model),
      detail: `${model.provider}/${model.model}`,
    }),
    audit({
      name: "real-opencode-credentials",
      passed: Boolean(env[modelKey]),
      detail: env[modelKey] ? `${modelKey} is configured` : `${modelKey} is required for ${model.provider}/${model.model}`,
    }),
    audit({
      name: "real-opencode-timeout",
      passed: Boolean(executionTimeout),
      detail: executionTimeout ? `${executionTimeout}ms` : "CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS must be greater than 0",
    }),
    audit({
      name: "real-docker-confirmation",
      passed: env.CLOUD_RUNTIME_CONFIRM_REAL_DOCKER === "1",
      detail: env.CLOUD_RUNTIME_CONFIRM_REAL_DOCKER === "1"
        ? "CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1"
        : "set CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 before building images and starting Compose",
    }),
    audit({
      name: "real-docker-directory",
      passed: Boolean(dockerDirectory),
      detail: dockerDirectory,
    }),
    audit({
      name: "provider-postgres-env",
      passed: Boolean(env.CLOUD_RUNTIME_DATABASE_URL),
      detail: env.CLOUD_RUNTIME_DATABASE_URL ? "CLOUD_RUNTIME_DATABASE_URL configured" : "CLOUD_RUNTIME_DATABASE_URL is required",
    }),
    audit({
      name: "provider-object-storage-env",
      passed: Boolean(
        env.CLOUD_RUNTIME_OBJECT_ENDPOINT &&
          env.CLOUD_RUNTIME_OBJECT_BUCKET &&
          env.CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID &&
          env.CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY,
      ),
      detail:
        env.CLOUD_RUNTIME_OBJECT_ENDPOINT &&
        env.CLOUD_RUNTIME_OBJECT_BUCKET &&
        env.CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID &&
        env.CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY
          ? `${env.CLOUD_RUNTIME_OBJECT_BUCKET} at ${env.CLOUD_RUNTIME_OBJECT_ENDPOINT}`
          : "CLOUD_RUNTIME_OBJECT_ENDPOINT, CLOUD_RUNTIME_OBJECT_BUCKET, CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID, and CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY are required",
    }),
    audit({
      name: "provider-queue-env",
      passed: Boolean(env.CLOUD_RUNTIME_QUEUE),
      detail: env.CLOUD_RUNTIME_QUEUE ? `queue ${env.CLOUD_RUNTIME_QUEUE} configured` : "CLOUD_RUNTIME_QUEUE is required",
    }),
    audit({
      name: "provider-kubernetes-env",
      passed: Boolean(env.CLOUD_RUNTIME_K8S_SERVER_URL && env.CLOUD_RUNTIME_K8S_TOKEN && env.CLOUD_RUNTIME_NAMESPACE),
      detail:
        env.CLOUD_RUNTIME_K8S_SERVER_URL && env.CLOUD_RUNTIME_K8S_TOKEN && env.CLOUD_RUNTIME_NAMESPACE
          ? `${env.CLOUD_RUNTIME_NAMESPACE} at ${env.CLOUD_RUNTIME_K8S_SERVER_URL}`
          : "CLOUD_RUNTIME_K8S_SERVER_URL, CLOUD_RUNTIME_K8S_TOKEN, and CLOUD_RUNTIME_NAMESPACE are required",
    }),
    audit({
      name: "provider-smoke-confirmation",
      passed: env.CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE === "1",
      detail: env.CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE === "1"
        ? "CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1"
        : "set CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 before writing smoke records to real providers",
    }),
    audit({
      name: "kubernetes-smoke-confirmation",
      passed: env.CLOUD_RUNTIME_CONFIRM_K8S_SMOKE === "1",
      detail: env.CLOUD_RUNTIME_CONFIRM_K8S_SMOKE === "1"
        ? "CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1"
        : "set CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 before creating Kubernetes smoke pods",
    }),
    audit({
      name: "runtime-pool-apply-confirmation",
      passed: env.CLOUD_RUNTIME_CONFIRM_APPLY_PLAN === "1",
      detail: env.CLOUD_RUNTIME_CONFIRM_APPLY_PLAN === "1"
        ? "CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1"
        : "set CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 before applying runtime pool scale plans",
    }),
    audit({
      name: "runtime-pool-api-env",
      passed: Boolean(env.CLOUD_RUNTIME_API_BASE_URL ?? env.CLOUD_RUNTIME_API_SMOKE_BASE_URL),
      detail: env.CLOUD_RUNTIME_API_BASE_URL ?? env.CLOUD_RUNTIME_API_SMOKE_BASE_URL
        ? `API ${env.CLOUD_RUNTIME_API_BASE_URL ?? env.CLOUD_RUNTIME_API_SMOKE_BASE_URL}`
        : "CLOUD_RUNTIME_API_BASE_URL or CLOUD_RUNTIME_API_SMOKE_BASE_URL is required",
    }),
  ]
  return {
    ok: checks.every((item) => item.status === "passed"),
    checks,
    commands: [
      "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 bun run cloud:opencode:smoke",
      `CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:run ${dockerDirectory}`,
      "bun run cloud:providers:check --health",
      "CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke",
      "CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 bun run cloud:k8s:smoke",
      "CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply",
    ],
  }
}

function probe(input: Probe) {
  return input
}

function smokeConfig(input: { env: Record<string, string | undefined> }) {
  return {
    sqlitePath: input.env.CLOUD_RUNTIME_SQLITE_PATH ?? ":memory:",
    sandboxRoot: input.env.CLOUD_RUNTIME_SANDBOX_ROOT ?? path.join("/tmp", "cloud-opencode-smoke"),
  }
}

function realEnvironmentProbes(input: {
  env: Record<string, string | undefined>
  dockerDirectory: string
}) {
  const smoke = smokeConfig({ env: input.env })
  const sqliteParent = smoke.sqlitePath === ":memory:" ? "/tmp" : path.dirname(smoke.sqlitePath)
  return [
    probe({ name: "opencode-executable", command: "command -v opencode" }),
    probe({ name: "sqlite-path-writable", command: `mkdir -p ${shellArg(sqliteParent)} && test -w ${shellArg(sqliteParent)}` }),
    probe({ name: "sandbox-root-writable", command: `mkdir -p ${shellArg(smoke.sandboxRoot)} && test -w ${shellArg(smoke.sandboxRoot)}` }),
    probe({ name: "docker-daemon", command: "docker info" }),
    probe({ name: "docker-compose", command: "docker compose version" }),
    probe({ name: "api-port-free", command: "sh -lc '! lsof -iTCP:8787 -sTCP:LISTEN'" }),
  ]
}

async function defaultProbe(input: Probe) {
  const proc = Bun.spawn(["sh", "-lc", input.command], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {
    ok: exitCode === 0,
    detail: exitCode === 0 ? `${input.command} succeeded` : snippet(stderr) || snippet(stdout) || `${input.command} failed`,
  }
}

export async function realEnvironmentPreflight(input?: {
  env?: Record<string, string | undefined>
  dockerDirectory?: string
  probe?: (probe: Probe) => Promise<{ ok: boolean; detail: string }>
}) {
  const env = input?.env ?? Bun.env
  const dockerDirectory = input?.dockerDirectory ?? ".cloud-runtime-opencode"
  const audit = realEnvironmentAudit({ env, dockerDirectory })
  const probes = await Promise.all(
    realEnvironmentProbes({ env, dockerDirectory }).map(async (current) => {
      const result = await (input?.probe ?? defaultProbe)(current).then(
        (result) => result,
        (error) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }),
      )
      return {
        name: current.name,
        status: result.ok ? "passed" as const : "failed" as const,
        detail: result.detail,
      }
    }),
  )
  const checks = [...audit.checks, ...probes]
  return {
    ok: checks.every((item) => item.status === "passed"),
    checks,
  }
}

function countStatus(input: RequirementStatus) {
  return requirementEvidence.filter((item) => item.status === input).length
}

export function evidence(input?: {
  dockerDirectory?: string
  kubernetesDirectory?: string
}) {
  const current = plan(input)
  return {
    schemaVersion: 1,
    status: "implementation_audit",
    summary: {
      requirements: requirementEvidence.length,
      implemented: countStatus("implemented"),
      implementedNeedsRealRun: countStatus("implemented_needs_real_run"),
      plannedAdapter: countStatus("planned_adapter"),
    },
    requirements: requirementEvidence,
    scripts: {
      docker: "cloud:docker",
      dockerCheck: "cloud:docker:check",
      dockerSmokePlan: "cloud:docker:smoke",
      dockerSmokeRun: "cloud:docker:smoke:run",
      dockerSmokeEvidence: "cloud:docker:smoke:evidence",
      dockerE2E: "cloud:docker:e2e",
      dockerE2EEvidence: "cloud:docker:e2e:evidence",
      dockerKubernetesE2E: "cloud:docker:k8s:e2e",
      dockerKubernetesE2EEvidence: "cloud:docker:k8s:e2e:evidence",
      apiSmoke: "cloud:api:smoke",
      apiSmokeJSON: "cloud:api:smoke:json",
      apiSmokeServer: "cloud:api:smoke:server",
      opencodePlan: "cloud:opencode:plan",
      opencodePreflight: "cloud:opencode:preflight",
      opencodeEvidence: "cloud:opencode:evidence",
      opencodeSmoke: "cloud:opencode:smoke",
      providersEnv: "cloud:providers:env",
      providersCheck: "cloud:providers:check",
      providersEvidence: "cloud:providers:evidence",
      providersSmoke: "cloud:providers:smoke",
      providersSmokeJSON: "cloud:providers:smoke:json",
      kubernetesSmoke: "cloud:k8s:smoke",
      kubernetesSmokeJSON: "cloud:k8s:smoke:json",
      releaseCheck: "cloud:release:check",
      releaseGithubActionsWrite: "cloud:release:github-actions:write",
      verify: "cloud:verify",
      localAcceptance: "cloud:local:acceptance",
      localAcceptanceJSON: "cloud:local:acceptance:json",
      verifyPreflight: "cloud:verify --preflight",
      verifyRunbook: "cloud:verify --runbook",
      realRunbookCheck: "cloud:real-runbook:check",
      runtimePoolApply: "cloud:runtime-pool:apply",
      runtimePoolApplyJSON: "cloud:runtime-pool:apply:json",
      kubernetes: "cloud:k8s",
      kubernetesCheck: "cloud:k8s:check",
    },
    verificationCommands: {
      safe: [
        "bun test test/cloud",
        "bun typecheck",
        "bun run cloud:verify --check",
        "bun run cloud:api:smoke",
        "bun run cloud:docker:e2e",
        `${releaseSampleEnv} bun run cloud:release:github-actions`,
        "bun run cloud:release:github-actions:write",
      ],
      audit: ["bun run cloud:verify --audit"],
      preflight: ["bun run cloud:verify --preflight"],
      dockerEvidence: ["bun run cloud:docker:smoke:evidence", "CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:evidence"],
      opencodeEvidence: ["bun run cloud:opencode:evidence", "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 bun run cloud:opencode:evidence"],
      providerEvidence: [
        "bun run cloud:providers:evidence",
        "bun run cloud:providers:evidence --health",
        "CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke",
        "CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke:json",
      ],
      kubernetesEvidence: [
        "CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 bun run cloud:k8s:smoke",
        "CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 bun run cloud:k8s:smoke:json",
      ],
      runtimePoolEvidence: [
        "CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply",
        "CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply:json",
      ],
      real: current.steps.filter((item) => item.mode === "explicit").map((item) => item.command),
      realVerified: [
        "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 CLOUD_RUNTIME_OPENCODE_COMMAND=/Users/simontu/.opencode/bin/opencode CLOUD_RUNTIME_MODEL_PROVIDER=anthropic CLOUD_RUNTIME_MODEL=glm-5.1 CLOUD_RUNTIME_MODEL_CREDENTIAL_ENV=ANTHROPIC_API_KEY CLOUD_RUNTIME_MODEL_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic/v1 bun run cloud:opencode:smoke",
        "CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e",
        "CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_SMOKE_BYOK_SECRET=$ANTHROPIC_API_KEY CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e",
        "CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run",
        "CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run",
        "CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 CLOUD_RUNTIME_K8S_SERVER_URL=http://127.0.0.1:18001 CLOUD_RUNTIME_K8S_ALLOW_LOCAL_PROXY=1 CLOUD_RUNTIME_NAMESPACE=cloud-runtime CLOUD_RUNTIME_K8S_SMOKE_IMAGE=cloud-runtime-opencode:1.14.28 bun run cloud:k8s:smoke:json",
        "CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker bun run cloud:providers:check --health",
        "CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke",
      ],
    },
    generatedDirectories: {
      docker: current.dockerDirectory,
      kubernetes: current.kubernetesDirectory,
    },
    dockerProfile: current.dockerProfile,
    note: "This evidence proves implemented code paths and safe verification coverage, not production operation. Real-run commands still require credentials and infrastructure.",
  }
}

export function evidenceSummary(input: ReturnType<typeof evidence>) {
  return `${JSON.stringify(input, undefined, 2)}\n`
}

function requirementLines(input: ReturnType<typeof evidence>, status: RequirementStatus) {
  return input.requirements
    .filter((item) => item.status === status)
    .map((item) => `  - ${item.id}: ${item.remainingProof.join("; ")}`)
}

export function realRunbook(input: ReturnType<typeof evidence>) {
  const realCommands = input.verificationCommands.real
  const steps: RunbookStep[] = [
    {
      name: "preflight-audit",
      command: "bun run cloud:verify --audit",
      successEvidence: "Cloud Runtime real-environment audit: passed",
      failureTriage: "set the missing confirmation flags, model key, Postgres, object storage, queue, and Kubernetes env reported by the audit",
    },
    {
      name: "local-system-preflight",
      command: "bun run cloud:verify --preflight",
      successEvidence: "Cloud Runtime real-environment preflight: passed",
      failureTriage: "fix the failed opencode, writable path, Docker daemon, Docker Compose, API port, or provider env check before running real smoke jobs",
    },
    {
      name: "local-opencode-smoke",
      command: realCommands[0] ?? "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 bun run cloud:opencode:smoke",
      successEvidence: "local opencode smoke succeeds and records at least one artifact from .opencode-cloud/artifacts.json",
      failureTriage: "run bun run cloud:opencode:plan and bun run cloud:opencode:preflight, verify model credentials and timeout, then inspect local executor stdout/stderr",
    },
    {
      name: "docker-runtime-smoke",
      command: realCommands[1] ?? `CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:run ${input.generatedDirectories.docker}`,
      successEvidence: "Docker smoke workflow creates workspace, session, job, terminal events, and downloadable artifact metadata",
      failureTriage: "run bun run cloud:docker:check and bun run cloud:docker:smoke, then inspect the step-specific failure suggestion",
    },
    {
      name: "provider-smoke",
      command: "CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke",
      successEvidence: "Postgres schema/query, queue enqueue/lease/ack, and object storage put/list/get/sign/delete pass",
      failureTriage: "run bun run cloud:providers:check --health first, then fix the failed provider write/read/delete operation",
    },
    {
      name: "kubernetes-smoke",
      command: "CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 bun run cloud:k8s:smoke",
      successEvidence: "Kubernetes NetworkPolicy and Pod are created, the smoke pod succeeds, logs are collected, and resources are deleted",
      failureTriage: "check namespace RBAC, runtime image pullability, NetworkPolicy support, pod security, and pod logs",
    },
    {
      name: "runtime-pool-apply",
      command: "CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply",
      successEvidence: "Admin apply-plan returns a desired runtime count and Kubernetes deployment scale operations apply successfully",
      failureTriage: "verify CLOUD_RUNTIME_API_BASE_URL, CLOUD_RUNTIME_API_KEY, Kubernetes server/token/namespace, worker deployment name, and current runtime count",
    },
    {
      name: "release-gate",
      command: "bun run cloud:release:check",
      successEvidence: "Cloud Runtime release readiness: ready",
      failureTriage: "inspect blocked Kubernetes, Docker smoke-plan, provider readiness, provider health, or runtime metric gate output",
    },
  ]
  return {
    title: "Cloud Runtime real-run operator runbook",
    generatedDirectories: input.generatedDirectories,
    prerequisites: [
      "Run from packages/opencode.",
      "Run bun test test/cloud, bun typecheck, and bun run cloud:verify --check before touching real infrastructure.",
      "Run bun run cloud:real-runbook:check to aggregate audit, local opencode preflight, and provider readiness without real model/provider calls.",
      "Run bun run cloud:opencode:preflight to check local opencode prerequisites without invoking a model-backed job.",
      "Run bun run cloud:providers:env to generate a production provider env template, or set CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker for local Docker defaults.",
      "Set model provider credentials such as ANTHROPIC_API_KEY or OPENAI_API_KEY.",
      "Set CLOUD_RUNTIME_DATABASE_URL, object storage endpoint/bucket/credentials, CLOUD_RUNTIME_QUEUE, and Kubernetes server/token/namespace.",
      "Set CLOUD_RUNTIME_API_BASE_URL and CLOUD_RUNTIME_API_KEY before applying runtime pool scale plans.",
      "Use explicit confirmation flags before commands that run real opencode or Docker.",
    ],
    steps,
    completionEvidence: [
      "cloud:verify --audit passes before real execution.",
      "cloud:verify --preflight passes on the local operator machine.",
      "cloud:api:smoke passes locally and against the deployed API base URL, including BYOK credential and admin runtime policy checks.",
      "cloud:opencode:smoke succeeds with a real model key.",
      "cloud:docker:smoke:run succeeds against the generated Docker topology.",
      "cloud:providers:check --health reaches Postgres, object storage, queue, and Kubernetes.",
      "cloud:runtime-pool:apply reaches the deployed admin API and applies returned scale operations.",
      "cloud:release:check reports ready with target runtime metrics.",
    ],
  }
}

export function runbookSummary(input: ReturnType<typeof realRunbook>) {
  return [
    input.title,
    `Docker dir:     ${input.generatedDirectories.docker}`,
    `Kubernetes dir: ${input.generatedDirectories.kubernetes}`,
    "Prerequisites:",
    ...input.prerequisites.map((item) => `  - ${item}`),
    "Steps:",
    ...input.steps.flatMap((item, index) => [
      `${index + 1}. ${item.name}`,
      `  command: ${item.command}`,
      `  success: ${item.successEvidence}`,
      `  triage: ${item.failureTriage}`,
    ]),
    "Completion evidence:",
    ...input.completionEvidence.map((item) => `  - ${item}`),
  ].join("\n")
}

export function localAcceptance(input?: {
  dockerDirectory?: string
  kubernetesServerURL?: string
  namespace?: string
  image?: string
}) {
  const dockerDirectory = input?.dockerDirectory ?? ".cloud-runtime-shared"
  const kubernetesServerURL = input?.kubernetesServerURL ?? "http://127.0.0.1:18001"
  const namespace = input?.namespace ?? "cloud-runtime"
  const image = input?.image ?? "cloud-runtime-opencode:1.14.28"
  return {
    title: "Cloud Runtime local acceptance plan",
    purpose: "Prove the local development machine can run the SaaS API, shared session pool, local providers, and Kubernetes sandbox smoke without requiring production cloud dependencies.",
    prerequisites: [
      "Run from packages/opencode.",
      "Docker Desktop is running and port 8787 is free before Docker smoke.",
      "For Kubernetes smoke, a local kind cluster is selected and kubectl proxy is listening on the configured local server URL.",
      "The runtime image has been loaded into kind before Kubernetes smoke.",
      "Use modeless smoke for the default acceptance path; run model-backed smoke separately when provider credentials are intentionally configured.",
    ],
    steps: [
      {
        name: "safe-code-verification",
        command: "bun test test/cloud && bun typecheck && bun run cloud:verify --check",
        successEvidence: "cloud tests, typecheck, and static verification pass",
        failureTriage: "fix the first failing test, typecheck error, or generated Docker/Kubernetes static check before running real local services",
      },
      {
        name: "shared-session-docker-e2e",
        command: "CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e",
        successEvidence: "Docker builds API/worker/runtime images, starts Postgres/MinIO/API/worker/runtime-worker, completes a job and same-session follow-up job, then cleans up Compose volumes",
        failureTriage: `run bun run cloud:docker:shared:check and bun run cloud:docker:shared:smoke, then inspect ${dockerDirectory}/README.md and Docker logs`,
      },
      {
        name: "start-local-provider-stack",
        command: `bun run cloud:docker:shared && cd ${dockerDirectory} && docker compose --env-file api.env --env-file worker.env up -d postgres minio minio-init redis`,
        successEvidence: "local Postgres, MinIO, bucket init, and Redis containers are running for provider health and smoke checks",
        failureTriage: "verify Docker Desktop is running, generated Compose files exist, and ports 55432, 9000, 9001, and 6379 are free",
      },
      {
        name: "local-provider-smoke",
        command: "CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke",
        successEvidence: "Postgres schema applies, queue enqueue/lease/ack works, and MinIO object put/list/get/sign/delete works",
        failureTriage: "run start-local-provider-stack first, then inspect the failed provider operation and local Docker service logs",
      },
      {
        name: "local-provider-health",
        command: "CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker bun run cloud:providers:check --health",
        successEvidence: "local Postgres select, MinIO bucket access, and local queue health checks pass after schema bootstrap",
        failureTriage: "run local-provider-smoke first so the Postgres queue schema exists, then verify Postgres/MinIO ports and credentials",
      },
      {
        name: "stop-local-provider-stack",
        command: `cd ${dockerDirectory} && docker compose down -v`,
        successEvidence: "local provider containers, network, and volumes are removed after provider smoke",
        failureTriage: "inspect docker compose ps/logs in the generated directory, then rerun docker compose down -v",
      },
      {
        name: "kind-kubernetes-smoke",
        command: `CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 CLOUD_RUNTIME_K8S_SERVER_URL=${kubernetesServerURL} CLOUD_RUNTIME_K8S_ALLOW_LOCAL_PROXY=1 CLOUD_RUNTIME_NAMESPACE=${namespace} CLOUD_RUNTIME_K8S_SMOKE_IMAGE=${image} bun run cloud:k8s:smoke:json`,
        successEvidence: "Kubernetes NetworkPolicy and smoke Pod are created in kind, pod exits successfully, logs are collected, and resources are cleaned up",
        failureTriage: "check kind context, kubectl proxy, namespace, image load, pod security, NetworkPolicy support, and smoke pod logs",
      },
      {
        name: "kubernetes-worker-docker-e2e",
        command: "CLOUD_RUNTIME_K8S_SERVER_URL=http://host.docker.internal:18001 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:k8s:e2e",
        successEvidence: "Postgres-backed API and worker run in Docker while the worker dispatches the job to a kind Kubernetes sandbox and writes artifacts back to MinIO",
        failureTriage: "run kind-kubernetes-smoke first, confirm kubectl proxy is reachable from Docker as host.docker.internal:18001, and inspect API/worker plus Kubernetes pod logs",
      },
    ],
    completionEvidence: [
      "Docker shared-session E2E returns succeeded jobs with artifacts and events.",
      "Local provider health and smoke prove Postgres queue plus MinIO object storage wiring.",
      "kind Kubernetes smoke proves the sandbox executor can create, watch, log, and clean up a real Pod locally.",
      "Kubernetes worker Docker E2E is the local production-composition route for Postgres, queue, MinIO, Docker API/worker, and kind sandbox execution.",
      "Model-backed local opencode smoke remains a separate optional proof because it depends on intentionally supplied customer/provider credentials.",
    ],
  } satisfies LocalAcceptance
}

export function localAcceptanceSummary(input: LocalAcceptance) {
  return [
    input.title,
    input.purpose,
    "Prerequisites:",
    ...input.prerequisites.map((item) => `  - ${item}`),
    "Steps:",
    ...input.steps.flatMap((item, index) => [
      `${index + 1}. ${item.name}`,
      `  command: ${item.command}`,
      `  success: ${item.successEvidence}`,
      `  triage: ${item.failureTriage}`,
    ]),
    "Completion evidence:",
    ...input.completionEvidence.map((item) => `  - ${item}`),
  ].join("\n")
}

export function reportSummary(input: ReturnType<typeof evidence>) {
  return [
    "Cloud Runtime implementation report",
    `Requirements: ${input.summary.requirements}`,
    `Implemented: ${input.summary.implemented}`,
    `Needs real run: ${input.summary.implementedNeedsRealRun}`,
    `Planned adapter: ${input.summary.plannedAdapter}`,
    "Implemented:",
    ...requirementLines(input, "implemented"),
    "Needs real run:",
    ...requirementLines(input, "implemented_needs_real_run"),
    "Planned adapter:",
    ...requirementLines(input, "planned_adapter"),
    "Safe verification:",
    ...input.verificationCommands.safe.map((item) => `  ${item}`),
    "Safe verification coverage:",
    "  cloud:api:smoke covers workspace/session/file/job/events/artifacts/tools, BYOK credentials, external-user scoped job model selection, and admin runtime policy endpoints",
    "Real-environment audit:",
    ...input.verificationCommands.audit.map((item) => `  ${item}`),
    "Real-environment preflight:",
    "  bun run cloud:verify --preflight",
    "Real-run proof:",
    ...input.verificationCommands.real.map((item) => `  ${item}`),
    "Docker evidence:",
    ...input.verificationCommands.dockerEvidence.map((item) => `  ${item}`),
    "OpenCode evidence:",
    ...input.verificationCommands.opencodeEvidence.map((item) => `  ${item}`),
    "Provider evidence:",
    ...input.verificationCommands.providerEvidence.map((item) => `  ${item}`),
    "Kubernetes evidence:",
    ...input.verificationCommands.kubernetesEvidence.map((item) => `  ${item}`),
    "Runtime pool evidence:",
    ...input.verificationCommands.runtimePoolEvidence.map((item) => `  ${item}`),
    "Verified real runs:",
    ...input.verificationCommands.realVerified.map((item) => `  ${item}`),
    "Machine-readable evidence:",
    "  bun run cloud:verify --evidence",
    "Local acceptance:",
    "  bun run cloud:local:acceptance",
    "Operator runbook:",
    "  bun run cloud:verify --runbook",
    `Note: ${input.note}`,
  ].join("\n")
}

export function auditSummary(input: ReturnType<typeof realEnvironmentAudit>) {
  const failed = input.checks.filter((item) => item.status === "failed")
  return [
    `Cloud Runtime real-environment audit: ${input.ok ? "passed" : "failed"}`,
    ...input.checks.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
    ...(failed.length ? ["Remediation:", ...failed.map((item) => `  - ${item.name}: ${remediation(item)}`)] : []),
    "Explicit commands after audit passes:",
    ...input.commands.map((item) => `  ${item}`),
  ].join("\n")
}

function remediation(input: AuditItem) {
  const suggestions: Record<string, string> = {
    "real-opencode-confirmation": "set CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 only when you are ready to run a real model-backed opencode smoke",
    "real-opencode-credentials": `set the required model provider API key shown in the failed check, for example ${credentialName({ provider: "anthropic" })}`,
    "real-opencode-timeout": "set CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS to a positive millisecond value such as 900000",
    "real-docker-confirmation": "set CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 only when you are ready to build images and start Compose services",
    "provider-postgres-env": "configure CLOUD_RUNTIME_DATABASE_URL for the target PostgreSQL control-plane database",
    "provider-object-storage-env": "configure CLOUD_RUNTIME_OBJECT_ENDPOINT, CLOUD_RUNTIME_OBJECT_BUCKET, CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID, and CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY",
    "provider-queue-env": "configure CLOUD_RUNTIME_QUEUE and CLOUD_RUNTIME_QUEUE_PROVIDER when not using the default PostgreSQL queue",
    "provider-kubernetes-env": "configure CLOUD_RUNTIME_K8S_SERVER_URL, CLOUD_RUNTIME_K8S_TOKEN, and CLOUD_RUNTIME_NAMESPACE",
    "provider-smoke-confirmation": "set CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 only when you are ready to apply schema and run queue/object-storage write smoke checks",
    "kubernetes-smoke-confirmation": "set CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 only when you are ready to create and delete a Kubernetes smoke pod",
    "runtime-pool-apply-confirmation": "set CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 only when you are ready to scale shared runtime workers",
    "runtime-pool-api-env": "configure CLOUD_RUNTIME_API_BASE_URL for the deployed Cloud Runtime API and CLOUD_RUNTIME_API_KEY for the admin request",
    "opencode-executable": "install opencode or add it to PATH before running the local opencode smoke",
    "sqlite-path-writable": "choose a writable CLOUD_RUNTIME_SQLITE_PATH parent directory or use :memory: for local smoke",
    "sandbox-root-writable": "choose a writable CLOUD_RUNTIME_SANDBOX_ROOT directory for local workdirs and artifacts",
    "docker-daemon": "start Docker Desktop or the local Docker daemon, then rerun bun run cloud:verify --preflight",
    "docker-compose": "install Docker Compose v2 or make docker compose available in PATH",
    "api-port-free": "stop the process listening on port 8787 or change the generated local API port before Docker smoke",
  }
  return suggestions[input.name] ?? `inspect ${input.name} and rerun bun run cloud:verify --preflight`
}

export function preflightSummary(input: Awaited<ReturnType<typeof realEnvironmentPreflight>>) {
  const failed = input.checks.filter((item) => item.status === "failed")
  return [
    `Cloud Runtime real-environment preflight: ${input.ok ? "passed" : "failed"}`,
    ...input.checks.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
    ...(failed.length ? ["Remediation:", ...failed.map((item) => `  - ${item.name}: ${remediation(item)}`)] : []),
  ].join("\n")
}

export async function realRunbookCheck(input?: {
  env?: Record<string, string | undefined>
  dockerDirectory?: string
  opencodePreflight?: () => Promise<Awaited<ReturnType<typeof CloudLocalOpencodeSmoke.preflight>>>
}) {
  const env = input?.env ?? Bun.env
  const audit = realEnvironmentAudit({
    env,
    dockerDirectory: input?.dockerDirectory ?? ".cloud-runtime-opencode",
  })
  const opencode = await (input?.opencodePreflight ?? (() => CloudLocalOpencodeSmoke.preflight({ env })))()
  const providers = CloudProviderReadiness.fromEnv(env)
  const sections: CheckSection[] = [
    {
      name: "real-environment-audit",
      ok: audit.ok,
      output: auditSummary(audit),
    },
    {
      name: "local-opencode-preflight",
      ok: opencode.ok,
      output: CloudLocalOpencodeSmoke.preflightSummary(opencode),
    },
    {
      name: "provider-readiness",
      ok: providers.ok,
      output: CloudProviderReadiness.summary(providers),
    },
  ]
  return {
    ok: sections.every((item) => item.ok),
    sections,
  }
}

export function realRunbookCheckSummary(input: Awaited<ReturnType<typeof realRunbookCheck>>) {
  return [
    `Cloud Runtime real-runbook check: ${input.ok ? "passed" : "failed"}`,
    ...input.sections.flatMap((item) => [
      `[${item.ok ? "passed" : "failed"}] ${item.name}`,
      ...item.output.split("\n").map((line) => `  ${line}`),
    ]),
    "Next real-run commands after this check passes:",
    "  CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 bun run cloud:opencode:smoke",
    "  CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:run .cloud-runtime-opencode",
    "  bun run cloud:providers:check --health",
    "  CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply",
  ].join("\n")
}

export function summary(input: ReturnType<typeof plan>) {
  return [
    "Cloud Runtime verification plan",
    `Docker dir:     ${input.dockerDirectory}`,
    `Docker profile: ${input.dockerProfile}`,
    `Kubernetes dir: ${input.kubernetesDirectory}`,
    "Safe checks:",
    ...input.steps
      .filter((item) => item.mode === "safe")
      .map((item) => `[${item.mode}] ${item.name}: ${item.command}\n  ${item.detail}`),
    "Explicit real-environment checks:",
    ...input.steps
      .filter((item) => item.mode === "explicit")
      .map((item) => `[${item.mode}] ${item.name}: ${item.command}\n  ${item.detail}`),
  ].join("\n")
}

function snippet(input: string) {
  return input.trim().split("\n").slice(0, 8).join("\n")
}

export function checkSummary(input: { results: StepResult[] }) {
  const ok = input.results.every((item) => item.ok)
  return [
    `Cloud Runtime verification check: ${ok ? "passed" : "failed"}`,
    ...input.results.flatMap((item) => [
      `[${item.ok ? "passed" : "failed"}] ${item.step.name}: ${item.step.command}`,
      ...(snippet(item.stdout) ? [`  stdout: ${snippet(item.stdout)}`] : []),
      ...(snippet(item.stderr) ? [`  stderr: ${snippet(item.stderr)}`] : []),
    ]),
  ].join("\n")
}

async function defaultRun(input: Step) {
  const proc = Bun.spawn(["sh", "-lc", input.command], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {
    ok: exitCode === 0,
    stdout,
    stderr,
  }
}

export async function runSafeChecks(input: {
  plan: ReturnType<typeof plan>
  run?: (step: Step) => Promise<{ ok: boolean; stdout: string; stderr: string }>
}) {
  const results: StepResult[] = []
  const run = input.run ?? defaultRun
  for (const current of input.plan.steps.filter((item) => item.mode === "safe")) {
    const result = await run(current)
    results.push({ step: current, ...result })
    if (!result.ok) return { ok: false, results }
  }
  return {
    ok: true,
    results,
  }
}

export function cliConfig(input?: {
  argv?: string[]
  env?: Record<string, string | undefined>
}) {
  const env = input?.env ?? Bun.env
  const args = input?.argv?.slice(2) ?? []
  const dockerProfile: DockerProfile = env.CLOUD_RUNTIME_DOCKER_PROFILE === "shared" ? "shared" : "opencode"
  return {
    audit: args.includes("--audit"),
    check: args.includes("--check"),
    evidence: args.includes("--evidence"),
    localAcceptance: args.includes("--local-acceptance"),
    localAcceptanceJSON: args.includes("--local-acceptance-json"),
    preflight: args.includes("--preflight"),
    realRunbookCheck: args.includes("--real-runbook-check"),
    report: args.includes("--report"),
    runbook: args.includes("--runbook"),
    dockerDirectory: env.CLOUD_RUNTIME_DOCKER_DIR ?? (dockerProfile === "shared" ? ".cloud-runtime-shared" : ".cloud-runtime-opencode"),
    dockerProfile,
    allowModelessDockerSmoke: env.CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE === "1",
    kubernetesDirectory: env.CLOUD_RUNTIME_K8S_DIR ?? ".cloud-runtime-k8s",
    localKubernetesServerURL: env.CLOUD_RUNTIME_K8S_SERVER_URL ?? "http://127.0.0.1:18001",
    localKubernetesNamespace: env.CLOUD_RUNTIME_NAMESPACE ?? "cloud-runtime",
    localKubernetesImage: env.CLOUD_RUNTIME_K8S_SMOKE_IMAGE ?? "cloud-runtime-opencode:1.14.28",
  }
}

export async function runCLI(input?: {
  argv?: string[]
  env?: Record<string, string | undefined>
  run?: (step: Step) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  probe?: (probe: Probe) => Promise<{ ok: boolean; detail: string }>
  opencodePreflight?: () => Promise<Awaited<ReturnType<typeof CloudLocalOpencodeSmoke.preflight>>>
}) {
  const config = cliConfig(input)
  const current = plan(config)
  if (config.localAcceptanceJSON) {
    return {
      exitCode: 0,
      output: `${JSON.stringify(localAcceptance({
        dockerDirectory: config.dockerDirectory,
        kubernetesServerURL: config.localKubernetesServerURL,
        namespace: config.localKubernetesNamespace,
        image: config.localKubernetesImage,
      }), undefined, 2)}\n`,
    }
  }
  if (config.localAcceptance) {
    return {
      exitCode: 0,
      output: localAcceptanceSummary(localAcceptance({
        dockerDirectory: config.dockerDirectory,
        kubernetesServerURL: config.localKubernetesServerURL,
        namespace: config.localKubernetesNamespace,
        image: config.localKubernetesImage,
      })),
    }
  }
  if (config.evidence) {
    return {
      exitCode: 0,
      output: evidenceSummary(evidence(config)),
    }
  }
  if (config.report) {
    return {
      exitCode: 0,
      output: reportSummary(evidence(config)),
    }
  }
  if (config.runbook) {
    return {
      exitCode: 0,
      output: runbookSummary(realRunbook(evidence(config))),
    }
  }
  if (config.realRunbookCheck) {
    const result = await realRunbookCheck({
      env: input?.env,
      dockerDirectory: config.dockerDirectory,
      opencodePreflight: input?.opencodePreflight,
    })
    return {
      exitCode: result.ok ? 0 : 1,
      output: realRunbookCheckSummary(result),
    }
  }
  if (config.preflight) {
    const result = await realEnvironmentPreflight({
      env: input?.env,
      dockerDirectory: config.dockerDirectory,
      probe: input?.probe,
    })
    return {
      exitCode: result.ok ? 0 : 1,
      output: preflightSummary(result),
    }
  }
  if (config.audit) {
    const result = realEnvironmentAudit({
      env: input?.env,
      dockerDirectory: config.dockerDirectory,
    })
    return {
      exitCode: result.ok ? 0 : 1,
      output: auditSummary(result),
    }
  }
  if (config.check) {
    const result = await runSafeChecks({
      plan: current,
      run: input?.run,
    })
    return {
      exitCode: result.ok ? 0 : 1,
      output: checkSummary(result),
    }
  }
  return {
    exitCode: 0,
    output: summary(current),
  }
}

if (import.meta.main) {
  const result = await runCLI({ argv: Bun.argv, env: Bun.env })
  console.log(result.output)
  process.exit(result.exitCode)
}

export * as CloudVerification from "./verification"
