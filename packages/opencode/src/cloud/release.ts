import { CloudDeployment } from "./deployment"
import { CloudLocalDocker } from "./local-docker"
import { CloudProviderReadiness } from "./provider-readiness"
import path from "path"

type Stage = "staging" | "canary" | "production"
type Decision = "promote" | "hold" | "rollback"
type Env = Record<string, string | undefined>

type Metrics = {
  jobs: number
  failureRate: number
  p95DurationMS: number
  sandboxStartP95MS: number
  costPerJobUSD: number
}

type Thresholds = {
  minJobs: number
  maxFailureRate: number
  maxP95DurationMS: number
  maxSandboxStartP95MS: number
  maxCostPerJobUSD: number
}

export const DefaultThresholds: Thresholds = {
  minJobs: 50,
  maxFailureRate: 0.03,
  maxP95DurationMS: 600_000,
  maxSandboxStartP95MS: 60_000,
  maxCostPerJobUSD: 1,
}

function violations(input: { metrics: Metrics; thresholds: Thresholds }) {
  return [
    input.metrics.jobs < input.thresholds.minJobs
      ? `jobs ${input.metrics.jobs} below ${input.thresholds.minJobs}`
      : undefined,
    input.metrics.failureRate > input.thresholds.maxFailureRate
      ? `failure rate ${input.metrics.failureRate} above ${input.thresholds.maxFailureRate}`
      : undefined,
    input.metrics.p95DurationMS > input.thresholds.maxP95DurationMS
      ? `job p95 ${input.metrics.p95DurationMS}ms above ${input.thresholds.maxP95DurationMS}ms`
      : undefined,
    input.metrics.sandboxStartP95MS > input.thresholds.maxSandboxStartP95MS
      ? `sandbox start p95 ${input.metrics.sandboxStartP95MS}ms above ${input.thresholds.maxSandboxStartP95MS}ms`
      : undefined,
    input.metrics.costPerJobUSD > input.thresholds.maxCostPerJobUSD
      ? `cost per job ${input.metrics.costPerJobUSD} above ${input.thresholds.maxCostPerJobUSD}`
      : undefined,
  ].filter((item): item is string => Boolean(item))
}

function nextStage(input: Stage) {
  if (input === "staging") return "canary" as const
  if (input === "canary") return "production" as const
  return "production" as const
}

export function gate(input: {
  version: string
  imageDigest: string
  stage: Stage
  metrics: Metrics
  thresholds?: Partial<Thresholds>
}) {
  const thresholds = { ...DefaultThresholds, ...input.thresholds }
  const failed = violations({ metrics: input.metrics, thresholds })
  const decision: Decision = failed.some((item) => !item.startsWith("jobs ")) ? "rollback" : failed.length ? "hold" : "promote"

  return {
    version: input.version,
    imageDigest: input.imageDigest,
    stage: input.stage,
    decision,
    nextStage: decision === "promote" ? nextStage(input.stage) : input.stage,
    violations: failed,
  }
}

export function rolloutPlan(input: {
  version: string
  image: string
  imageDigest: string
  stableVersion: string
  canaryPercent: number
  decision: ReturnType<typeof gate>
}) {
  if (input.decision.decision === "rollback") {
    return {
      action: "rollback" as const,
      version: input.stableVersion,
      reason: input.decision.violations,
      canary: { enabled: false, percent: 0 },
    }
  }
  if (input.decision.decision === "hold") {
    return {
      action: "hold" as const,
      version: input.version,
      reason: input.decision.violations,
      canary: { enabled: input.decision.stage === "canary", percent: input.canaryPercent },
    }
  }
  return {
    action: input.decision.nextStage === "production" ? ("promote_production" as const) : ("promote_canary" as const),
    version: input.version,
    image: input.image,
    imageDigest: input.imageDigest,
    canary: {
      enabled: input.decision.nextStage === "canary",
      percent: input.decision.nextStage === "canary" ? input.canaryPercent : 100,
    },
  }
}

function image(input: { registry: string; imageName: string; version: string }) {
  return `${input.registry.replace(/\/+$/, "")}/${input.imageName}:${input.version}`
}

function step(input: { name: string; command: string; reason?: string[] }) {
  return {
    name: input.name,
    command: input.command,
    ...(input.reason?.length ? { reason: input.reason } : {}),
  }
}

function rollbackStep(input: { namespace: string; deployment: string; stableVersion: string; reason?: string[] }) {
  return step({
    name: "rollback-runtime",
    command:
      `kubectl -n ${input.namespace} annotate deployment/${input.deployment} cloud.opencode.ai/rollback-version=${input.stableVersion} cloud.opencode.ai/canary-percent=0 --overwrite`,
    reason: input.reason,
  })
}

export function upgradeWorkflow(input: {
  registry: string
  imageName: string
  version: string
  context: string
  dockerfile: string
  namespace: string
  deployment: string
  stableVersion: string
  canaryPercent: number
  gate: ReturnType<typeof gate>
}) {
  const runtimeImage = image(input)
  const rollback = rollbackStep({
    namespace: input.namespace,
    deployment: input.deployment,
    stableVersion: input.stableVersion,
  })
  if (input.gate.decision === "rollback") {
    return {
      version: input.version,
      image: runtimeImage,
      decision: input.gate,
      steps: [
        rollbackStep({
          namespace: input.namespace,
          deployment: input.deployment,
          stableVersion: input.stableVersion,
          reason: input.gate.violations,
        }),
      ],
      rollback,
    }
  }
  const build = [
    step({
      name: "build-runtime-image",
      command: `docker build -f ${input.dockerfile} -t ${runtimeImage} ${input.context}`,
    }),
    step({
      name: "push-runtime-image",
      command: `docker push ${runtimeImage}`,
    }),
    step({
      name: "verify-staging-runtime",
      command: `kubectl -n ${input.namespace} set image deployment/${input.deployment} opencode=${runtimeImage}@${input.gate.imageDigest}`,
    }),
  ]
  if (input.gate.decision === "hold") {
    return {
      version: input.version,
      image: runtimeImage,
      decision: input.gate,
      steps: build,
      rollback,
    }
  }
  return {
    version: input.version,
    image: runtimeImage,
    decision: input.gate,
    steps: [
      ...build,
      input.gate.nextStage === "production"
        ? step({
            name: "promote-production-runtime",
            command:
              `kubectl -n ${input.namespace} annotate deployment/${input.deployment} cloud.opencode.ai/default-version=${input.version} cloud.opencode.ai/canary-percent=100 --overwrite`,
          })
        : step({
            name: "promote-canary-runtime",
            command:
              `kubectl -n ${input.namespace} annotate deployment/${input.deployment} cloud.opencode.ai/canary-version=${input.version} cloud.opencode.ai/canary-percent=${input.canaryPercent} --overwrite`,
          }),
    ],
    rollback,
  }
}

type Check = {
  name: string
  status: "passed" | "failed"
  detail: string
}

function checkSummary(input: { checks: Check[] }) {
  const failed = input.checks.filter((item) => item.status === "failed")
  if (!failed.length) return `${input.checks.length}/${input.checks.length} checks passed`
  return `${failed.length} failed checks: ${failed.map((item) => item.name).join(", ")}`
}

function workflowCheck(input: { name: string; passed: boolean; detail: string }): Check {
  return {
    name: input.name,
    status: input.passed ? "passed" : "failed",
    detail: input.detail,
  }
}

export function githubActionsWorkflow(input: {
  workflowName: string
  registry: string
  imageName: string
  version: string
  context: string
  dockerfile: string
  namespace: string
  deployment: string
  stableVersion: string
  canaryPercent: number
}) {
  const runtimeImage = image(input)
  return [
    `name: ${input.workflowName}`,
    "",
    "on:",
    "  workflow_dispatch:",
    "",
    "permissions:",
    "  contents: read",
    "  packages: write",
    "  id-token: write",
    "",
    "env:",
    `  CLOUD_RUNTIME_RELEASE_VERSION: ${input.version}`,
    `  CLOUD_RUNTIME_RELEASE_STAGE: \${{ vars.CLOUD_RUNTIME_RELEASE_STAGE || 'staging' }}`,
    `  CLOUD_RUNTIME_RELEASE_IMAGE: ${runtimeImage}`,
    `  CLOUD_RUNTIME_RELEASE_IMAGE_DIGEST: \${{ steps.build.outputs.digest }}`,
    `  CLOUD_RUNTIME_STABLE_VERSION: ${input.stableVersion}`,
    `  CLOUD_RUNTIME_CANARY_PERCENT: ${input.canaryPercent}`,
    "",
    "jobs:",
    "  release-runtime:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: docker/setup-buildx-action@v3",
    "      - uses: docker/login-action@v3",
    "        with:",
    `          registry: ${input.registry}`,
    "          username: ${{ secrets.CLOUD_RUNTIME_REGISTRY_USERNAME }}",
    "          password: ${{ secrets.CLOUD_RUNTIME_REGISTRY_PASSWORD }}",
    "      - uses: docker/build-push-action@v6",
    "        id: build",
    "        with:",
    `          context: ${input.context}`,
    `          file: ${input.dockerfile}`,
    "          push: true",
    `          tags: ${runtimeImage}`,
    "      - uses: oven-sh/setup-bun@v2",
    "      - run: bun install --frozen-lockfile",
    "      - run: bun test test/cloud",
    "      - run: bun typecheck",
    "      - run: bun run cloud:release:check",
    "      - name: verify-staging-runtime",
    "        run: |",
    `          kubectl -n ${input.namespace} set image deployment/${input.deployment} opencode=${runtimeImage}@\${{ steps.build.outputs.digest }}`,
    "      - name: promote-canary-runtime",
    "        if: env.CLOUD_RUNTIME_RELEASE_STAGE == 'staging'",
    "        run: |",
    `          kubectl -n ${input.namespace} annotate deployment/${input.deployment} cloud.opencode.ai/canary-version=${input.version} cloud.opencode.ai/canary-percent=${input.canaryPercent} --overwrite`,
    "      - name: promote-production-runtime",
    "        if: env.CLOUD_RUNTIME_RELEASE_STAGE == 'canary'",
    "        run: |",
    `          kubectl -n ${input.namespace} annotate deployment/${input.deployment} cloud.opencode.ai/default-version=${input.version} cloud.opencode.ai/canary-percent=100 --overwrite`,
    "      - name: rollback-runtime",
    "        if: failure()",
    "        run: |",
    `          kubectl -n ${input.namespace} annotate deployment/${input.deployment} cloud.opencode.ai/rollback-version=${input.stableVersion} cloud.opencode.ai/canary-percent=0 --overwrite`,
    "",
  ].join("\n")
}

export function checkGithubActionsWorkflow(input: string) {
  const checks = [
    workflowCheck({
      name: "pinned-runtime-version",
      passed: input.includes("CLOUD_RUNTIME_RELEASE_VERSION:"),
      detail: "release version env configured",
    }),
    workflowCheck({
      name: "docker-build-push",
      passed: input.includes("docker/build-push-action@v6") && input.includes("push: true"),
      detail: "docker/build-push-action@v6 publishes runtime image",
    }),
    workflowCheck({
      name: "digest-promotion",
      passed: input.includes("steps.build.outputs.digest") && input.includes("kubectl -n") && input.includes("set image"),
      detail: "deployment uses build output digest",
    }),
    workflowCheck({
      name: "release-gate",
      passed: input.includes("bun run cloud:release:check") &&
        input.indexOf("bun run cloud:release:check") < input.indexOf("promote-canary-runtime"),
      detail: "cloud:release:check runs before promotion",
    }),
    workflowCheck({
      name: "canary-command",
      passed: input.includes("cloud.opencode.ai/canary-version="),
      detail: "workflow can annotate canary version",
    }),
    workflowCheck({
      name: "rollback-command",
      passed: input.includes("cloud.opencode.ai/rollback-version="),
      detail: "workflow includes rollback annotation",
    }),
  ]
  return {
    ok: checks.every((item) => item.status === "passed"),
    checks,
  }
}

export async function writeGithubActionsWorkflow(input: Parameters<typeof githubActionsWorkflow>[0] & {
  directory: string
}) {
  const file = path.join(input.directory, ".github", "workflows", "cloud-runtime-release.yml")
  await Bun.write(file, githubActionsWorkflow(input))
  return {
    directory: input.directory,
    files: [file],
    summary: [
      `Wrote Cloud Runtime GitHub Actions workflow to ${file}`,
      "Check: bun run cloud:release:github-actions",
      "Run release gate: bun run cloud:release:check",
    ].join("\n"),
  }
}

export function readiness(input: {
  kubernetes: { ok: boolean; checks: Check[] }
  docker: { ok: boolean; checks: Check[] }
  providers?: { ok: boolean; checks: Check[] }
  providerHealth?: { ok: boolean; checks: Check[] }
  release: ReturnType<typeof gate>
}) {
  const checks = [
    {
      name: "kubernetes-preflight",
      status: input.kubernetes.ok ? "passed" as const : "failed" as const,
      detail: checkSummary(input.kubernetes),
    },
    {
      name: "docker-smoke-plan",
      status: input.docker.ok ? "passed" as const : "failed" as const,
      detail: checkSummary(input.docker),
    },
    ...(input.providers
      ? [
          {
            name: "provider-readiness",
            status: input.providers.ok ? "passed" as const : "failed" as const,
            detail: checkSummary(input.providers),
          },
        ]
      : []),
    ...(input.providerHealth
      ? [
          {
            name: "provider-health",
            status: input.providerHealth.ok ? "passed" as const : "failed" as const,
            detail: checkSummary(input.providerHealth),
          },
        ]
      : []),
    {
      name: "runtime-release-gate",
      status: input.release.decision === "promote" ? "passed" as const : "failed" as const,
      detail: input.release.decision === "promote"
        ? `promote to ${input.release.nextStage}`
        : `${input.release.decision}: ${input.release.violations.join(", ")}`,
    },
  ]
  return {
    status: checks.every((item) => item.status === "passed") ? "ready" as const : "blocked" as const,
    releaseDecision: input.release.decision,
    nextStage: input.release.nextStage,
    checks,
  }
}

export function readinessSummary(input: ReturnType<typeof readiness>) {
  return [
    `Cloud Runtime release readiness: ${input.status}`,
    `Release decision: ${input.releaseDecision}`,
    `Next stage: ${input.nextStage}`,
    ...input.checks.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
    "Before real smoke/provider health checks: bun run cloud:verify --audit",
  ].join("\n")
}

function stage(input: string | undefined): Stage {
  if (input === "staging" || input === "canary" || input === "production") return input
  return "staging"
}

function number(input: string | undefined, fallback: number) {
  const parsed = Number(input)
  if (Number.isFinite(parsed)) return parsed
  return fallback
}

export function cliConfig(input?: { argv?: string[]; env?: Env }) {
  const env = input?.env ?? Bun.env
  const args = input?.argv?.slice(2) ?? []
  return {
    githubActions: args.includes("--github-actions"),
    writeGithubActions: args.includes("--write-github-actions"),
    directory: args.find((item) => !item.startsWith("--")) ?? env.CLOUD_RUNTIME_RELEASE_WORKFLOW_DIR ?? ".",
    version: env.CLOUD_RUNTIME_RELEASE_VERSION ?? env.CLOUD_RUNTIME_DEFAULT_VERSION ?? "1.14.28",
    imageDigest: env.CLOUD_RUNTIME_RELEASE_IMAGE_DIGEST ?? "sha256:unknown",
    stage: stage(env.CLOUD_RUNTIME_RELEASE_STAGE),
    metrics: {
      jobs: number(env.CLOUD_RUNTIME_RELEASE_JOBS, 0),
      failureRate: number(env.CLOUD_RUNTIME_RELEASE_FAILURE_RATE, 1),
      p95DurationMS: number(env.CLOUD_RUNTIME_RELEASE_P95_DURATION_MS, Number.POSITIVE_INFINITY),
      sandboxStartP95MS: number(env.CLOUD_RUNTIME_RELEASE_SANDBOX_START_P95_MS, Number.POSITIVE_INFINITY),
      costPerJobUSD: number(env.CLOUD_RUNTIME_RELEASE_COST_PER_JOB_USD, Number.POSITIVE_INFINITY),
    },
    workflow: {
      workflowName: env.CLOUD_RUNTIME_RELEASE_WORKFLOW_NAME ?? "Cloud Runtime Release",
      registry: env.CLOUD_RUNTIME_RELEASE_REGISTRY ?? "registry.example.com",
      imageName: env.CLOUD_RUNTIME_RELEASE_IMAGE_NAME ?? "cloud-runtime-opencode",
      context: env.CLOUD_RUNTIME_RELEASE_CONTEXT ?? "../../..",
      dockerfile: env.CLOUD_RUNTIME_RELEASE_DOCKERFILE ?? "Dockerfile.cloud-opencode-runtime",
      namespace: env.CLOUD_RUNTIME_NAMESPACE ?? "cloud-runtime",
      deployment: env.CLOUD_RUNTIME_RELEASE_DEPLOYMENT ?? "cloud-runtime-worker",
      stableVersion: env.CLOUD_RUNTIME_STABLE_VERSION ?? env.CLOUD_RUNTIME_DEFAULT_VERSION ?? "1.14.28",
      canaryPercent: number(env.CLOUD_RUNTIME_CANARY_PERCENT, 5),
    },
    env,
  }
}

export async function runCLI(input: { argv?: string[]; env: Env }) {
  const config = cliConfig({ argv: input.argv, env: input.env })
  if (config.githubActions) {
    return {
      exitCode: 0,
      output: githubActionsWorkflow({
        ...config.workflow,
        version: config.version,
      }),
    }
  }
  if (config.writeGithubActions) {
    const result = await writeGithubActionsWorkflow({
      ...config.workflow,
      version: config.version,
      directory: config.directory,
    })
    return {
      exitCode: 0,
      output: result.summary,
    }
  }
  const deployment = CloudDeployment.plan({
    environment: "production",
    namespace: input.env.CLOUD_RUNTIME_NAMESPACE ?? "cloud-runtime",
    image: input.env.CLOUD_RUNTIME_IMAGE ?? "cloud-runtime-api:dev",
    ...(input.env.CLOUD_RUNTIME_IMAGE_DIGEST ? { imageDigest: input.env.CLOUD_RUNTIME_IMAGE_DIGEST } : {}),
    runtimeDefaultVersion: input.env.CLOUD_RUNTIME_DEFAULT_VERSION ?? "1.14.28",
    authMode: input.env.CLOUD_RUNTIME_AUTH_MODE === "none"
      ? "none"
      : input.env.CLOUD_RUNTIME_AUTH_MODE === "internal_jwt"
        ? "internal_jwt"
        : "api_key",
    databaseURLSecretRef: input.env.CLOUD_RUNTIME_DATABASE_URL_SECRET ?? "cloud-runtime-db",
    objectStorageBucket: input.env.CLOUD_RUNTIME_OBJECT_BUCKET ?? "runtime-artifacts",
    queueName: input.env.CLOUD_RUNTIME_QUEUE ?? "cloud-runtime-jobs",
    autoscale: {
      minWorkers: number(input.env.CLOUD_RUNTIME_AUTOSCALE_MIN_WORKERS, 2),
      maxWorkers: number(input.env.CLOUD_RUNTIME_AUTOSCALE_MAX_WORKERS, 20),
      jobsPerWorker: number(input.env.CLOUD_RUNTIME_AUTOSCALE_JOBS_PER_WORKER, 5),
    },
  })
  const result = readiness({
    kubernetes: CloudDeployment.checkKubernetesYAML(CloudDeployment.kubernetesYAML(deployment)),
    docker: CloudLocalDocker.smokePlan({
      files: CloudLocalDocker.files({ workerExecutionMode: "opencode" }),
      commands: CloudLocalDocker.commands(),
    }),
    providers: CloudProviderReadiness.fromEnv(input.env),
    release: gate({
      version: config.version,
      imageDigest: config.imageDigest,
      stage: config.stage,
      metrics: config.metrics,
    }),
  })
  return {
    exitCode: result.status === "ready" ? 0 : 1,
    output: readinessSummary(result),
  }
}

if (import.meta.main) {
  const result = await runCLI({ env: Bun.env })
  console.log(result.output)
  process.exit(result.exitCode)
}

export * as CloudRelease from "./release"
