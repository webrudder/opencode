import { describe, expect, test } from "bun:test"
import { CloudDeployment } from "../../src/cloud/deployment"
import { CloudLocalDocker } from "../../src/cloud/local-docker"
import { CloudProviderReadiness } from "../../src/cloud/provider-readiness"
import { CloudRelease } from "../../src/cloud/release"
import path from "path"

const healthy = {
  jobs: 100,
  failureRate: 0.01,
  p95DurationMS: 120_000,
  sandboxStartP95MS: 10_000,
  costPerJobUSD: 0.25,
}

describe("CloudRelease", () => {
  test("promotes a healthy staging runtime image to canary", () => {
    const decision = CloudRelease.gate({
      version: "1.15.0",
      imageDigest: "sha256:canary",
      stage: "staging",
      metrics: healthy,
    })

    expect(decision).toEqual({
      version: "1.15.0",
      imageDigest: "sha256:canary",
      stage: "staging",
      decision: "promote",
      nextStage: "canary",
      violations: [],
    })
    expect(
      CloudRelease.rolloutPlan({
        version: "1.15.0",
        image: "registry.example.com/cloud-runtime-opencode:1.15.0",
        imageDigest: "sha256:canary",
        stableVersion: "1.14.28",
        canaryPercent: 5,
        decision,
      }),
    ).toMatchObject({
      action: "promote_canary",
      canary: { enabled: true, percent: 5 },
    })
  })

  test("holds release when there is not enough canary evidence yet", () => {
    const decision = CloudRelease.gate({
      version: "1.15.0",
      imageDigest: "sha256:canary",
      stage: "canary",
      metrics: { ...healthy, jobs: 10 },
    })

    expect(decision).toMatchObject({
      decision: "hold",
      nextStage: "canary",
      violations: ["jobs 10 below 50"],
    })
  })

  test("rolls back when runtime health violates safety thresholds", () => {
    const decision = CloudRelease.gate({
      version: "1.15.0",
      imageDigest: "sha256:canary",
      stage: "canary",
      metrics: { ...healthy, failureRate: 0.2 },
    })

    expect(
      CloudRelease.rolloutPlan({
        version: "1.15.0",
        image: "registry.example.com/cloud-runtime-opencode:1.15.0",
        imageDigest: "sha256:canary",
        stableVersion: "1.14.28",
        canaryPercent: 5,
        decision,
      }),
    ).toEqual({
      action: "rollback",
      version: "1.14.28",
      reason: ["failure rate 0.2 above 0.03"],
      canary: { enabled: false, percent: 0 },
    })
  })

  test("builds an executable runtime image upgrade workflow", () => {
    const workflow = CloudRelease.upgradeWorkflow({
      registry: "registry.example.com",
      imageName: "cloud-runtime-opencode",
      version: "1.15.0",
      context: "../../..",
      dockerfile: "Dockerfile.cloud-opencode-runtime",
      namespace: "cloud-runtime",
      deployment: "cloud-runtime-worker",
      stableVersion: "1.14.28",
      canaryPercent: 5,
      gate: CloudRelease.gate({
        version: "1.15.0",
        imageDigest: "sha256:canary",
        stage: "staging",
        metrics: healthy,
      }),
    })

    expect(workflow.image).toBe("registry.example.com/cloud-runtime-opencode:1.15.0")
    expect(workflow.steps.map((item) => [item.name, item.command])).toEqual([
      [
        "build-runtime-image",
        "docker build -f Dockerfile.cloud-opencode-runtime -t registry.example.com/cloud-runtime-opencode:1.15.0 ../../..",
      ],
      ["push-runtime-image", "docker push registry.example.com/cloud-runtime-opencode:1.15.0"],
      [
        "verify-staging-runtime",
        "kubectl -n cloud-runtime set image deployment/cloud-runtime-worker opencode=registry.example.com/cloud-runtime-opencode:1.15.0@sha256:canary",
      ],
      [
        "promote-canary-runtime",
        "kubectl -n cloud-runtime annotate deployment/cloud-runtime-worker cloud.opencode.ai/canary-version=1.15.0 cloud.opencode.ai/canary-percent=5 --overwrite",
      ],
    ])
    expect(workflow.rollback.command).toBe(
      "kubectl -n cloud-runtime annotate deployment/cloud-runtime-worker cloud.opencode.ai/rollback-version=1.14.28 cloud.opencode.ai/canary-percent=0 --overwrite",
    )
  })

  test("builds a rollback workflow when release gates fail", () => {
    const workflow = CloudRelease.upgradeWorkflow({
      registry: "registry.example.com",
      imageName: "cloud-runtime-opencode",
      version: "1.15.0",
      context: "../../..",
      dockerfile: "Dockerfile.cloud-opencode-runtime",
      namespace: "cloud-runtime",
      deployment: "cloud-runtime-worker",
      stableVersion: "1.14.28",
      canaryPercent: 5,
      gate: CloudRelease.gate({
        version: "1.15.0",
        imageDigest: "sha256:canary",
        stage: "canary",
        metrics: { ...healthy, failureRate: 0.2 },
      }),
    })

    expect(workflow.steps.map((item) => item.name)).toEqual(["rollback-runtime"])
    expect(workflow.steps[0]).toMatchObject({
      command:
        "kubectl -n cloud-runtime annotate deployment/cloud-runtime-worker cloud.opencode.ai/rollback-version=1.14.28 cloud.opencode.ai/canary-percent=0 --overwrite",
      reason: ["failure rate 0.2 above 0.03"],
    })
  })

  test("builds a production promotion workflow after healthy canary metrics", () => {
    const workflow = CloudRelease.upgradeWorkflow({
      registry: "registry.example.com",
      imageName: "cloud-runtime-opencode",
      version: "1.15.0",
      context: "../../..",
      dockerfile: "Dockerfile.cloud-opencode-runtime",
      namespace: "cloud-runtime",
      deployment: "cloud-runtime-worker",
      stableVersion: "1.14.28",
      canaryPercent: 5,
      gate: CloudRelease.gate({
        version: "1.15.0",
        imageDigest: "sha256:canary",
        stage: "canary",
        metrics: healthy,
      }),
    })

    expect(workflow.steps.at(-1)).toEqual({
      name: "promote-production-runtime",
      command:
        "kubectl -n cloud-runtime annotate deployment/cloud-runtime-worker cloud.opencode.ai/default-version=1.15.0 cloud.opencode.ai/canary-percent=100 --overwrite",
    })
  })

  test("renders a GitHub Actions runtime image publish workflow", () => {
    const workflow = CloudRelease.githubActionsWorkflow({
      workflowName: "Cloud Runtime Release",
      registry: "registry.example.com",
      imageName: "cloud-runtime-opencode",
      version: "1.15.0",
      context: "../../..",
      dockerfile: "Dockerfile.cloud-opencode-runtime",
      namespace: "cloud-runtime",
      deployment: "cloud-runtime-worker",
      stableVersion: "1.14.28",
      canaryPercent: 5,
    })

    expect(workflow).toContain("name: Cloud Runtime Release")
    expect(workflow).toContain("CLOUD_RUNTIME_RELEASE_VERSION: 1.15.0")
    expect(workflow).toContain("docker/build-push-action@v6")
    expect(workflow).toContain("tags: registry.example.com/cloud-runtime-opencode:1.15.0")
    expect(workflow).toContain("outputs.digest")
    expect(workflow).toContain("bun run cloud:release:check")
    expect(workflow).toContain("kubectl -n cloud-runtime set image deployment/cloud-runtime-worker opencode=registry.example.com/cloud-runtime-opencode:1.15.0@${{ steps.build.outputs.digest }}")
    expect(workflow).toContain("cloud.opencode.ai/canary-version=1.15.0")
    expect(workflow).toContain("cloud.opencode.ai/rollback-version=1.14.28")
  })

  test("checks rendered GitHub Actions runtime release workflow safety gates", () => {
    const result = CloudRelease.checkGithubActionsWorkflow(
      CloudRelease.githubActionsWorkflow({
        workflowName: "Cloud Runtime Release",
        registry: "registry.example.com",
        imageName: "cloud-runtime-opencode",
        version: "1.15.0",
        context: "../../..",
        dockerfile: "Dockerfile.cloud-opencode-runtime",
        namespace: "cloud-runtime",
        deployment: "cloud-runtime-worker",
        stableVersion: "1.14.28",
        canaryPercent: 5,
      }),
    )

    expect(result).toEqual({
      ok: true,
      checks: [
        { name: "pinned-runtime-version", status: "passed", detail: "release version env configured" },
        { name: "docker-build-push", status: "passed", detail: "docker/build-push-action@v6 publishes runtime image" },
        { name: "digest-promotion", status: "passed", detail: "deployment uses build output digest" },
        { name: "release-gate", status: "passed", detail: "cloud:release:check runs before promotion" },
        { name: "canary-command", status: "passed", detail: "workflow can annotate canary version" },
        { name: "rollback-command", status: "passed", detail: "workflow includes rollback annotation" },
      ],
    })
  })

  test("summarizes release readiness from Kubernetes, Docker, and runtime gates", () => {
    const deployment = CloudDeployment.plan({
      environment: "production",
      namespace: "cloud-runtime",
      image: "registry.example.com/cloud-runtime-api:1.0.0",
      runtimeDefaultVersion: "1.14.28",
      authMode: "api_key",
      databaseURLSecretRef: "cloud-runtime-db",
      objectStorageBucket: "runtime-artifacts",
      queueName: "cloud-runtime-jobs",
      autoscale: { minWorkers: 2, maxWorkers: 20, jobsPerWorker: 5 },
    })
    const result = CloudRelease.readiness({
      kubernetes: CloudDeployment.checkKubernetesYAML(CloudDeployment.kubernetesYAML(deployment)),
      docker: CloudLocalDocker.smokePlan({
        files: CloudLocalDocker.files({ workerExecutionMode: "opencode" }),
        commands: CloudLocalDocker.commands(),
      }),
      release: CloudRelease.gate({
        version: "1.15.0",
        imageDigest: "sha256:canary",
        stage: "canary",
        metrics: healthy,
      }),
    })

    expect(result).toMatchObject({
      status: "ready",
      releaseDecision: "promote",
      nextStage: "production",
    })
    expect(result.checks).toEqual([
      { name: "kubernetes-preflight", status: "passed", detail: "9/9 checks passed" },
      { name: "docker-smoke-plan", status: "passed", detail: "19/19 checks passed" },
      { name: "runtime-release-gate", status: "passed", detail: "promote to production" },
    ])
    expect(CloudRelease.readinessSummary(result)).toContain("Cloud Runtime release readiness: ready")
    expect(CloudRelease.readinessSummary(result)).toContain("Before real smoke/provider health checks: bun run cloud:verify --audit")
  })

  test("blocks release readiness when deployment or runtime gates fail", () => {
    const result = CloudRelease.readiness({
      kubernetes: CloudDeployment.checkKubernetesYAML("kind: Deployment\nmetadata:\n  name: cloud-runtime-api\n"),
      docker: {
        ok: false,
        checks: [
          { name: "build-api-image", status: "passed", detail: "ok" },
          { name: "compose-runtime-image", status: "failed", detail: "worker runtime image missing" },
        ],
      },
      release: CloudRelease.gate({
        version: "1.15.0",
        imageDigest: "sha256:canary",
        stage: "canary",
        metrics: { ...healthy, failureRate: 0.2 },
      }),
    })

    expect(result.status).toBe("blocked")
    expect(result.checks).toEqual([
      { name: "kubernetes-preflight", status: "failed", detail: "7 failed checks: worker-deployment, database-secret-ref, object-storage-env, queue-env, worker-autoupdate-disabled, worker-hpa, api-service" },
      { name: "docker-smoke-plan", status: "failed", detail: "1 failed checks: compose-runtime-image" },
      { name: "runtime-release-gate", status: "failed", detail: "rollback: failure rate 0.2 above 0.03" },
    ])
    expect(CloudRelease.readinessSummary(result)).toContain("[failed] runtime-release-gate: rollback: failure rate 0.2 above 0.03")
  })

  test("includes provider readiness in the release gate summary", () => {
    const result = CloudRelease.readiness({
      kubernetes: CloudDeployment.checkKubernetesYAML("kind: Deployment\nmetadata:\n  name: cloud-runtime-api\n"),
      docker: {
        ok: true,
        checks: [{ name: "build-api-image", status: "passed", detail: "ok" }],
      },
      providers: CloudProviderReadiness.fromEnv({
        CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
        CLOUD_RUNTIME_QUEUE_PROVIDER: "postgres",
      }),
      release: CloudRelease.gate({
        version: "1.15.0",
        imageDigest: "sha256:canary",
        stage: "staging",
        metrics: healthy,
      }),
    })

    expect(result.status).toBe("blocked")
    expect(result.checks.map((item) => item.name)).toEqual([
      "kubernetes-preflight",
      "docker-smoke-plan",
      "provider-readiness",
      "runtime-release-gate",
    ])
    expect(result.checks.find((item) => item.name === "provider-readiness")).toEqual({
      name: "provider-readiness",
      status: "failed",
      detail: "4 failed checks: postgres-config, object-storage-config, queue-config, kubernetes-config",
    })
  })

  test("includes provider health checks in the release gate summary", async () => {
    const providers = CloudProviderReadiness.fromEnv({
      CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:secret@postgres.example.com:5432/cloud_runtime",
      CLOUD_RUNTIME_OBJECT_ENDPOINT: "https://s3.example.com",
      CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
      CLOUD_RUNTIME_QUEUE_PROVIDER: "postgres",
      CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
      CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
      CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
      CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
    })
    const result = CloudRelease.readiness({
      kubernetes: { ok: true, checks: [{ name: "manifest-file", status: "passed", detail: "ok" }] },
      docker: { ok: true, checks: [{ name: "build-api-image", status: "passed", detail: "ok" }] },
      providers,
      providerHealth: await CloudProviderReadiness.runHealthChecks({
        plans: providers.plans,
        run: async (plan) => ({
          ok: plan.provider !== "kubernetes",
          detail: plan.provider === "kubernetes" ? "namespace unreachable" : `${plan.provider} ok`,
        }),
      }),
      release: CloudRelease.gate({
        version: "1.15.0",
        imageDigest: "sha256:canary",
        stage: "staging",
        metrics: healthy,
      }),
    })

    expect(result.status).toBe("blocked")
    expect(result.checks.map((item) => item.name)).toEqual([
      "kubernetes-preflight",
      "docker-smoke-plan",
      "provider-readiness",
      "provider-health",
      "runtime-release-gate",
    ])
    expect(result.checks.find((item) => item.name === "provider-health")).toEqual({
      name: "provider-health",
      status: "failed",
      detail: "1 failed checks: kubernetes-health",
    })
  })

  test("builds release readiness CLI config from environment", () => {
    expect(
      CloudRelease.cliConfig({
        argv: ["bun", "release.ts"],
        env: {
          CLOUD_RUNTIME_RELEASE_VERSION: "1.15.0",
          CLOUD_RUNTIME_RELEASE_STAGE: "canary",
          CLOUD_RUNTIME_RELEASE_IMAGE_DIGEST: "sha256:canary",
          CLOUD_RUNTIME_RELEASE_JOBS: "100",
          CLOUD_RUNTIME_RELEASE_FAILURE_RATE: "0.01",
          CLOUD_RUNTIME_RELEASE_P95_DURATION_MS: "120000",
          CLOUD_RUNTIME_RELEASE_SANDBOX_START_P95_MS: "10000",
          CLOUD_RUNTIME_RELEASE_COST_PER_JOB_USD: "0.25",
        },
      }),
    ).toMatchObject({
      version: "1.15.0",
      imageDigest: "sha256:canary",
      stage: "canary",
      metrics: healthy,
    })
  })

  test("runs release readiness CLI as a ready CI gate", async () => {
    const result = await CloudRelease.runCLI({
      env: {
        CLOUD_RUNTIME_RELEASE_VERSION: "1.15.0",
        CLOUD_RUNTIME_RELEASE_STAGE: "canary",
        CLOUD_RUNTIME_RELEASE_IMAGE_DIGEST: "sha256:canary",
        CLOUD_RUNTIME_RELEASE_JOBS: "100",
        CLOUD_RUNTIME_RELEASE_FAILURE_RATE: "0.01",
        CLOUD_RUNTIME_RELEASE_P95_DURATION_MS: "120000",
        CLOUD_RUNTIME_RELEASE_SANDBOX_START_P95_MS: "10000",
        CLOUD_RUNTIME_RELEASE_COST_PER_JOB_USD: "0.25",
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:secret@postgres.example.com:5432/cloud_runtime",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "https://s3.example.com",
        CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
        CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
        CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
        CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime release readiness: ready")
    expect(result.output).toContain("[passed] provider-readiness")
    expect(result.output).toContain("Before real smoke/provider health checks: bun run cloud:verify --audit")
  })

  test("runs release readiness CLI as a blocked CI gate", async () => {
    const result = await CloudRelease.runCLI({
      env: {
        CLOUD_RUNTIME_RELEASE_VERSION: "1.15.0",
        CLOUD_RUNTIME_RELEASE_STAGE: "canary",
        CLOUD_RUNTIME_RELEASE_IMAGE_DIGEST: "sha256:canary",
        CLOUD_RUNTIME_RELEASE_JOBS: "10",
        CLOUD_RUNTIME_RELEASE_FAILURE_RATE: "0.2",
        CLOUD_RUNTIME_RELEASE_P95_DURATION_MS: "120000",
        CLOUD_RUNTIME_RELEASE_SANDBOX_START_P95_MS: "10000",
        CLOUD_RUNTIME_RELEASE_COST_PER_JOB_USD: "0.25",
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Cloud Runtime release readiness: blocked")
    expect(result.output).toContain("[failed] provider-readiness")
    expect(result.output).toContain("[failed] runtime-release-gate")
  })

  test("renders GitHub Actions workflow from the release CLI", async () => {
    const result = await CloudRelease.runCLI({
      argv: ["bun", "release.ts", "--github-actions"],
      env: {
        CLOUD_RUNTIME_RELEASE_WORKFLOW_NAME: "Cloud Runtime Release",
        CLOUD_RUNTIME_RELEASE_REGISTRY: "registry.example.com",
        CLOUD_RUNTIME_RELEASE_IMAGE_NAME: "cloud-runtime-opencode",
        CLOUD_RUNTIME_RELEASE_VERSION: "1.15.0",
        CLOUD_RUNTIME_RELEASE_CONTEXT: "../../..",
        CLOUD_RUNTIME_RELEASE_DOCKERFILE: "Dockerfile.cloud-opencode-runtime",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
        CLOUD_RUNTIME_RELEASE_DEPLOYMENT: "cloud-runtime-worker",
        CLOUD_RUNTIME_STABLE_VERSION: "1.14.28",
        CLOUD_RUNTIME_CANARY_PERCENT: "5",
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("name: Cloud Runtime Release")
    expect(result.output).toContain("tags: registry.example.com/cloud-runtime-opencode:1.15.0")
    expect(CloudRelease.checkGithubActionsWorkflow(result.output).ok).toBe(true)
  })

  test("writes the GitHub Actions workflow to a deployment directory", async () => {
    const result = await CloudRelease.writeGithubActionsWorkflow({
      directory: path.join("/tmp", `cloud-runtime-release-${crypto.randomUUID()}`),
      workflowName: "Cloud Runtime Release",
      registry: "registry.example.com",
      imageName: "cloud-runtime-opencode",
      version: "1.15.0",
      context: "../../..",
      dockerfile: "Dockerfile.cloud-opencode-runtime",
      namespace: "cloud-runtime",
      deployment: "cloud-runtime-worker",
      stableVersion: "1.14.28",
      canaryPercent: 5,
    })

    expect(result.files).toEqual([path.join(result.directory, ".github", "workflows", "cloud-runtime-release.yml")])
    expect(result.summary).toContain("Wrote Cloud Runtime GitHub Actions workflow")
    expect(result.summary).toContain(path.join(result.directory, ".github", "workflows", "cloud-runtime-release.yml"))
    expect(CloudRelease.checkGithubActionsWorkflow(await Bun.file(result.files[0]).text()).ok).toBe(true)
  })

  test("writes GitHub Actions workflow from the release CLI", async () => {
    const directory = path.join("/tmp", `cloud-runtime-release-cli-${crypto.randomUUID()}`)
    const result = await CloudRelease.runCLI({
      argv: ["bun", "release.ts", "--write-github-actions", directory],
      env: {
        CLOUD_RUNTIME_RELEASE_WORKFLOW_NAME: "Cloud Runtime Release",
        CLOUD_RUNTIME_RELEASE_REGISTRY: "registry.example.com",
        CLOUD_RUNTIME_RELEASE_IMAGE_NAME: "cloud-runtime-opencode",
        CLOUD_RUNTIME_RELEASE_VERSION: "1.15.0",
        CLOUD_RUNTIME_RELEASE_CONTEXT: "../../..",
        CLOUD_RUNTIME_RELEASE_DOCKERFILE: "Dockerfile.cloud-opencode-runtime",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
        CLOUD_RUNTIME_RELEASE_DEPLOYMENT: "cloud-runtime-worker",
        CLOUD_RUNTIME_STABLE_VERSION: "1.14.28",
        CLOUD_RUNTIME_CANARY_PERCENT: "5",
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Wrote Cloud Runtime GitHub Actions workflow")
    expect(CloudRelease.checkGithubActionsWorkflow(await Bun.file(path.join(directory, ".github", "workflows", "cloud-runtime-release.yml")).text()).ok).toBe(true)
  })

  test("exposes a package script for release readiness checks", async () => {
    expect((await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts["cloud:release:check"]).toBe(
      "bun run ./src/cloud/release.ts",
    )
    expect((await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts["cloud:release:github-actions"]).toBe(
      "bun run ./src/cloud/release.ts --github-actions",
    )
    expect((await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts["cloud:release:github-actions:write"]).toBe(
      "bun run ./src/cloud/release.ts --write-github-actions",
    )
  })
})
