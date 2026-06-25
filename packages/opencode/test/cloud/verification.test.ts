import { describe, expect, test } from "bun:test"
import { CloudVerification } from "../../src/cloud/verification"

describe("CloudVerification", () => {
  test("builds an ordered safe local and CI verification plan", () => {
    const result = CloudVerification.plan({
      dockerDirectory: ".cloud-runtime-opencode",
      kubernetesDirectory: ".cloud-runtime-k8s",
    })

    expect(result.steps.map((item) => [item.name, item.mode, item.command])).toEqual([
      ["generate-docker", "safe", "CLOUD_RUNTIME_EXECUTION_MODE=opencode CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS=900000 bun run cloud:docker .cloud-runtime-opencode"],
      ["check-docker", "safe", "bun run cloud:docker:check .cloud-runtime-opencode"],
      ["plan-docker-smoke", "safe", "bun run cloud:docker:smoke .cloud-runtime-opencode"],
      ["plan-shared-docker-e2e", "safe", "bun run cloud:docker:e2e"],
      ["plan-local-opencode", "safe", "bun run cloud:opencode:plan"],
      ["smoke-api-server", "safe", "bun run cloud:api:smoke"],
      [
        "check-providers",
        "safe",
        "CLOUD_RUNTIME_DATABASE_URL=postgres://opencode:secret@postgres.example.com:5432/cloud_runtime CLOUD_RUNTIME_OBJECT_ENDPOINT=https://s3.example.com CLOUD_RUNTIME_OBJECT_BUCKET=runtime-artifacts CLOUD_RUNTIME_QUEUE=cloud-runtime-jobs CLOUD_RUNTIME_K8S_SERVER_URL=https://kubernetes.example.com CLOUD_RUNTIME_K8S_TOKEN=token_abc CLOUD_RUNTIME_NAMESPACE=cloud-runtime bun run cloud:providers:check",
      ],
      ["generate-kubernetes", "safe", "bun run cloud:k8s .cloud-runtime-k8s"],
      ["check-kubernetes", "safe", "bun run cloud:k8s:check .cloud-runtime-k8s"],
      [
        "check-release",
        "safe",
        "CLOUD_RUNTIME_RELEASE_VERSION=1.15.0 CLOUD_RUNTIME_RELEASE_STAGE=canary CLOUD_RUNTIME_RELEASE_IMAGE_DIGEST=sha256:canary CLOUD_RUNTIME_RELEASE_JOBS=100 CLOUD_RUNTIME_RELEASE_FAILURE_RATE=0.01 CLOUD_RUNTIME_RELEASE_P95_DURATION_MS=120000 CLOUD_RUNTIME_RELEASE_SANDBOX_START_P95_MS=10000 CLOUD_RUNTIME_RELEASE_COST_PER_JOB_USD=0.25 CLOUD_RUNTIME_DATABASE_URL=postgres://opencode:secret@postgres.example.com:5432/cloud_runtime CLOUD_RUNTIME_OBJECT_ENDPOINT=https://s3.example.com CLOUD_RUNTIME_OBJECT_BUCKET=runtime-artifacts CLOUD_RUNTIME_QUEUE=cloud-runtime-jobs CLOUD_RUNTIME_K8S_SERVER_URL=https://kubernetes.example.com CLOUD_RUNTIME_K8S_TOKEN=token_abc CLOUD_RUNTIME_NAMESPACE=cloud-runtime bun run cloud:release:check",
      ],
      [
        "plan-release-workflow",
        "safe",
        "CLOUD_RUNTIME_RELEASE_VERSION=1.15.0 CLOUD_RUNTIME_RELEASE_STAGE=canary CLOUD_RUNTIME_RELEASE_IMAGE_DIGEST=sha256:canary CLOUD_RUNTIME_RELEASE_JOBS=100 CLOUD_RUNTIME_RELEASE_FAILURE_RATE=0.01 CLOUD_RUNTIME_RELEASE_P95_DURATION_MS=120000 CLOUD_RUNTIME_RELEASE_SANDBOX_START_P95_MS=10000 CLOUD_RUNTIME_RELEASE_COST_PER_JOB_USD=0.25 CLOUD_RUNTIME_DATABASE_URL=postgres://opencode:secret@postgres.example.com:5432/cloud_runtime CLOUD_RUNTIME_OBJECT_ENDPOINT=https://s3.example.com CLOUD_RUNTIME_OBJECT_BUCKET=runtime-artifacts CLOUD_RUNTIME_QUEUE=cloud-runtime-jobs CLOUD_RUNTIME_K8S_SERVER_URL=https://kubernetes.example.com CLOUD_RUNTIME_K8S_TOKEN=token_abc CLOUD_RUNTIME_NAMESPACE=cloud-runtime bun run cloud:release:github-actions",
      ],
      ["run-real-opencode-smoke", "explicit", "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 bun run cloud:opencode:smoke"],
      ["run-real-docker-smoke", "explicit", "CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:run .cloud-runtime-opencode"],
      ["run-provider-health", "explicit", "bun run cloud:providers:check --health"],
      ["run-provider-smoke", "explicit", "CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke"],
      ["run-kubernetes-smoke", "explicit", "CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 bun run cloud:k8s:smoke"],
      ["run-runtime-pool-apply", "explicit", "CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply"],
    ])
  })

  test("builds a shared-session Docker verification plan", () => {
    const result = CloudVerification.plan({
      dockerDirectory: ".cloud-runtime-shared",
      kubernetesDirectory: ".cloud-runtime-k8s",
      dockerProfile: "shared",
      allowModelessDockerSmoke: true,
    })

    expect(result.steps.map((item) => [item.name, item.mode, item.command])).toContainEqual([
      "generate-docker",
      "safe",
      "CLOUD_RUNTIME_STORAGE_BACKEND=postgres CLOUD_RUNTIME_EXECUTION_MODE=shared-session bun run cloud:docker .cloud-runtime-shared",
    ])
    expect(result.steps.map((item) => [item.name, item.mode, item.command])).toContainEqual([
      "run-real-docker-smoke",
      "explicit",
      "CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:run .cloud-runtime-shared",
    ])
    expect(result.steps.map((item) => [item.name, item.mode, item.command])).toContainEqual([
      "check-providers",
      "safe",
      "CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker bun run cloud:providers:check",
    ])
    expect(result.steps.map((item) => [item.name, item.mode, item.command])).toContainEqual([
      "run-provider-health",
      "explicit",
      "CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker bun run cloud:providers:check --health",
    ])
  })

  test("renders a verification summary with safe and explicit phases", () => {
    const summary = CloudVerification.summary(CloudVerification.plan())

    expect(summary).toContain("Cloud Runtime verification plan")
    expect(summary).toContain("[safe] generate-docker")
    expect(summary).toContain("[explicit] run-real-opencode-smoke")
    expect(summary).toContain("CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1")
  })

  test("runs the verification CLI in plan mode without side effects", async () => {
    const result = await CloudVerification.runCLI({
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-opencode",
        CLOUD_RUNTIME_K8S_DIR: ".cloud-runtime-k8s",
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime verification plan")
    expect(result.output).toContain("bun run cloud:docker:check .cloud-runtime-opencode")
    expect(result.output).toContain("bun run cloud:k8s:check .cloud-runtime-k8s")
    expect(result.output).toContain("bun run cloud:release:github-actions")
  })

  test("runs the verification CLI for shared-session Docker profile", async () => {
    const result = await CloudVerification.runCLI({
      env: {
        CLOUD_RUNTIME_DOCKER_PROFILE: "shared",
        CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE: "1",
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Docker profile: shared")
    expect(result.output).toContain("CLOUD_RUNTIME_STORAGE_BACKEND=postgres CLOUD_RUNTIME_EXECUTION_MODE=shared-session bun run cloud:docker .cloud-runtime-shared")
    expect(result.output).toContain("CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker bun run cloud:providers:check")
    expect(result.output).toContain("CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:run .cloud-runtime-shared")
  })

  test("audits real-environment prerequisites without running real commands", async () => {
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--audit"],
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-opencode",
        CLOUD_RUNTIME_MODEL_PROVIDER: "openai",
        CLOUD_RUNTIME_MODEL: "gpt-5",
        CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "0",
      },
      run: async () => {
        throw new Error("should not execute commands")
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Cloud Runtime real-environment audit: failed")
    expect(result.output).toContain("[failed] real-opencode-confirmation")
    expect(result.output).toContain("[passed] real-opencode-model: openai/gpt-5")
    expect(result.output).toContain("[failed] real-opencode-credentials: OPENAI_API_KEY is required for openai/gpt-5")
    expect(result.output).toContain("[failed] real-opencode-timeout")
    expect(result.output).toContain("[failed] real-docker-confirmation")
    expect(result.output).toContain("[failed] provider-object-storage-env")
    expect(result.output).toContain("[failed] provider-smoke-confirmation")
    expect(result.output).toContain("[failed] kubernetes-smoke-confirmation")
    expect(result.output).toContain("[failed] runtime-pool-apply-confirmation")
    expect(result.output).toContain("[failed] runtime-pool-api-env")
    expect(result.output).toContain("Remediation:")
    expect(result.output).toContain("set the required model provider API key shown in the failed check")
    expect(result.output).toContain("configure CLOUD_RUNTIME_OBJECT_ENDPOINT, CLOUD_RUNTIME_OBJECT_BUCKET")
    expect(result.output).toContain("CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:run .cloud-runtime-opencode")
  })

  test("passes real-environment audit when explicit confirmations and provider env are configured", async () => {
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--audit"],
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-opencode",
        CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE: "1",
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
        CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE: "1",
        CLOUD_RUNTIME_CONFIRM_K8S_SMOKE: "1",
        CLOUD_RUNTIME_CONFIRM_APPLY_PLAN: "1",
        CLOUD_RUNTIME_API_BASE_URL: "https://runtime.example.com",
        CLOUD_RUNTIME_API_KEY: "key_abc",
        CLOUD_RUNTIME_MODEL_PROVIDER: "openai",
        CLOUD_RUNTIME_MODEL: "gpt-5",
        OPENAI_API_KEY: "sk-openai",
        CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "600000",
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:secret@localhost:5432/cloud_runtime",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://localhost:9000",
        CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
        CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID: "opencode",
        CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY: "opencode-password",
        CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
        CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
        CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime real-environment audit: passed")
    expect(result.output).toContain("[passed] real-opencode-credentials: OPENAI_API_KEY is configured")
    expect(result.output).toContain("[passed] provider-kubernetes-env: cloud-runtime at https://kubernetes.example.com")
    expect(result.output).toContain("[passed] provider-smoke-confirmation: CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1")
    expect(result.output).toContain("[passed] kubernetes-smoke-confirmation: CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1")
    expect(result.output).toContain("[passed] runtime-pool-apply-confirmation: CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1")
    expect(result.output).toContain("[passed] runtime-pool-api-env: API https://runtime.example.com")
    expect(result.output).toContain("bun run cloud:providers:check --health")
    expect(result.output).toContain("CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke")
    expect(result.output).toContain("CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply")
  })

  test("renders machine-readable implementation evidence without running commands", async () => {
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--evidence"],
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-opencode",
        CLOUD_RUNTIME_K8S_DIR: ".cloud-runtime-k8s",
      },
      run: async () => {
        throw new Error("should not execute commands")
      },
    })
    const evidence = JSON.parse(result.output) as {
      schemaVersion: number
      summary: {
        requirements: number
        implemented: number
        implementedNeedsRealRun: number
        plannedAdapter: number
      }
      requirements: Array<{ id: string; status: string; evidence: string[]; remainingProof: string[] }>
      scripts: Record<string, string>
      verificationCommands: {
        safe: string[]
        audit: string[]
        preflight: string[]
        dockerEvidence: string[]
        opencodeEvidence: string[]
        providerEvidence: string[]
        kubernetesEvidence: string[]
        runtimePoolEvidence: string[]
        real: string[]
        realVerified: string[]
      }
      generatedDirectories: { docker: string; kubernetes: string }
      note: string
    }

    expect(result.exitCode).toBe(0)
    expect(evidence.schemaVersion).toBe(1)
    expect(evidence.summary.requirements).toBe(evidence.requirements.length)
    expect(evidence.summary.implemented).toBeGreaterThan(0)
    expect(evidence.summary.implementedNeedsRealRun).toBeGreaterThan(0)
    expect(evidence.generatedDirectories).toEqual({
      docker: ".cloud-runtime-opencode",
      kubernetes: ".cloud-runtime-k8s",
    })
    expect(evidence.requirements.find((item) => item.id === "real_local_opencode_executor")).toMatchObject({
      status: "implemented",
      remainingProof: ["run additional provider/model combinations as needed"],
    })
    expect(evidence.requirements.find((item) => item.id === "local_docker_runtime_topology")).toMatchObject({
      status: "implemented",
      remainingProof: ["run real model-backed Docker smoke when provider credentials are available"],
    })
    expect(evidence.requirements.find((item) => item.id === "runtime_pool_apply_plan")).toMatchObject({
      status: "implemented_needs_real_run",
      remainingProof: ["CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply"],
    })
    expect(evidence.requirements.find((item) => item.id === "observability_cost_release")).toMatchObject({
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
    })
    expect(evidence.requirements.find((item) => item.id === "public_cloud_runtime_api")?.evidence).toContain("src/cloud/routes.ts")
    expect(evidence.requirements.find((item) => item.id === "public_cloud_runtime_api")?.evidence).toContain("src/cloud/model-secret-store.ts")
    expect(evidence.requirements.find((item) => item.id === "public_cloud_runtime_api")?.evidence).toContain("src/cloud/model-secret-runner.ts")
    expect(evidence.requirements.find((item) => item.id === "public_cloud_runtime_api")?.evidence).toContain(
      "cloud:api:smoke covers workspace/session/file/job/events/artifacts/tools, BYOK credentials, external-user scoped job model selection, and admin runtime policy endpoints",
    )
    expect(evidence.scripts.verifyPreflight).toBe("cloud:verify --preflight")
    expect(evidence.scripts.verifyRunbook).toBe("cloud:verify --runbook")
    expect(evidence.scripts.localAcceptance).toBe("cloud:local:acceptance")
    expect(evidence.scripts.localAcceptanceJSON).toBe("cloud:local:acceptance:json")
    expect(evidence.scripts.releaseGithubActionsWrite).toBe("cloud:release:github-actions:write")
    expect(evidence.scripts.opencodePreflight).toBe("cloud:opencode:preflight")
    expect(evidence.scripts.opencodeEvidence).toBe("cloud:opencode:evidence")
    expect(evidence.scripts.dockerSmokeEvidence).toBe("cloud:docker:smoke:evidence")
    expect(evidence.scripts.dockerE2E).toBe("cloud:docker:e2e")
    expect(evidence.scripts.dockerE2EEvidence).toBe("cloud:docker:e2e:evidence")
    expect(evidence.scripts.dockerKubernetesE2E).toBe("cloud:docker:k8s:e2e")
    expect(evidence.scripts.dockerKubernetesE2EEvidence).toBe("cloud:docker:k8s:e2e:evidence")
    expect(evidence.scripts.apiSmoke).toBe("cloud:api:smoke")
    expect(evidence.scripts.apiSmokeJSON).toBe("cloud:api:smoke:json")
    expect(evidence.scripts.apiSmokeServer).toBe("cloud:api:smoke:server")
    expect(evidence.scripts.providersEnv).toBe("cloud:providers:env")
    expect(evidence.scripts.providersSmoke).toBe("cloud:providers:smoke")
    expect(evidence.scripts.providersSmokeJSON).toBe("cloud:providers:smoke:json")
    expect(evidence.scripts.kubernetesSmoke).toBe("cloud:k8s:smoke")
    expect(evidence.scripts.kubernetesSmokeJSON).toBe("cloud:k8s:smoke:json")
    expect(evidence.scripts.realRunbookCheck).toBe("cloud:real-runbook:check")
    expect(evidence.scripts.runtimePoolApply).toBe("cloud:runtime-pool:apply")
    expect(evidence.scripts.runtimePoolApplyJSON).toBe("cloud:runtime-pool:apply:json")
    expect(evidence.verificationCommands.safe).toContain("bun test test/cloud")
    expect(evidence.verificationCommands.safe).toContain("bun run cloud:docker:e2e")
    expect(evidence.verificationCommands.safe.some((item) => item.includes("bun run cloud:release:github-actions"))).toBe(true)
    expect(evidence.verificationCommands.audit).toEqual(["bun run cloud:verify --audit"])
    expect(evidence.verificationCommands.preflight).toEqual(["bun run cloud:verify --preflight"])
    expect(evidence.verificationCommands.opencodeEvidence).toEqual(["bun run cloud:opencode:evidence", "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 bun run cloud:opencode:evidence"])
    expect(evidence.verificationCommands.dockerEvidence).toEqual([
      "bun run cloud:docker:smoke:evidence",
      "CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:evidence",
    ])
    expect(evidence.verificationCommands.providerEvidence).toEqual([
      "bun run cloud:providers:evidence",
      "bun run cloud:providers:evidence --health",
      "CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke",
      "CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke:json",
    ])
    expect(evidence.verificationCommands.kubernetesEvidence).toEqual([
      "CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 bun run cloud:k8s:smoke",
      "CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 bun run cloud:k8s:smoke:json",
    ])
    expect(evidence.verificationCommands.runtimePoolEvidence).toEqual([
      "CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply",
      "CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply:json",
    ])
    expect(evidence.verificationCommands.real).toContain("bun run cloud:providers:check --health")
    expect(evidence.verificationCommands.real).toContain("CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply")
    expect(evidence.verificationCommands.realVerified).toContain(
      "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 CLOUD_RUNTIME_OPENCODE_COMMAND=/Users/simontu/.opencode/bin/opencode CLOUD_RUNTIME_MODEL_PROVIDER=anthropic CLOUD_RUNTIME_MODEL=glm-5.1 CLOUD_RUNTIME_MODEL_CREDENTIAL_ENV=ANTHROPIC_API_KEY CLOUD_RUNTIME_MODEL_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic/v1 bun run cloud:opencode:smoke",
    )
    expect(evidence.verificationCommands.realVerified).toContain(
      "CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e",
    )
    expect(evidence.verificationCommands.realVerified).toContain(
      "CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_SMOKE_BYOK_SECRET=$ANTHROPIC_API_KEY CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e",
    )
    expect(evidence.verificationCommands.realVerified).toContain(
      "CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run",
    )
    expect(evidence.note).toContain("not production operation")
  })

  test("renders a human-readable implementation report without running commands", async () => {
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--report"],
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-opencode",
        CLOUD_RUNTIME_K8S_DIR: ".cloud-runtime-k8s",
      },
      run: async () => {
        throw new Error("should not execute commands")
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime implementation report")
    expect(result.output).toContain("Requirements: 12")
    expect(result.output).toContain("Implemented: 11")
    expect(result.output).toContain("Needs real run: 1")
    expect(result.output).toContain("real_local_opencode_executor")
    expect(result.output).toContain("runtime_pool_apply_plan")
    expect(result.output).toContain("CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 bun run cloud:opencode:smoke")
    expect(result.output).toContain("Verified real runs:")
    expect(result.output).toContain("CLOUD_RUNTIME_MODEL=glm-5.1")
    expect(result.output).toContain("OpenCode evidence:")
    expect(result.output).toContain("CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 bun run cloud:opencode:evidence")
    expect(result.output).toContain("Docker evidence:")
    expect(result.output).toContain("CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:evidence")
    expect(result.output).toContain("bun run cloud:docker:e2e")
    expect(result.output).toContain("Provider evidence:")
    expect(result.output).toContain("bun run cloud:providers:evidence --health")
    expect(result.output).toContain("CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke")
    expect(result.output).toContain("CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker bun run cloud:providers:check --health")
    expect(result.output).toContain("CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke")
    expect(result.output).toContain("Kubernetes evidence:")
    expect(result.output).toContain("CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 bun run cloud:k8s:smoke")
    expect(result.output).toContain("Runtime pool evidence:")
    expect(result.output).toContain("CLOUD_RUNTIME_CONFIRM_APPLY_PLAN=1 bun run cloud:runtime-pool:apply")
    expect(result.output).toContain("bun run cloud:api:smoke")
    expect(result.output).toContain("BYOK credentials")
    expect(result.output).toContain("admin runtime policy endpoints")
    expect(result.output).toContain("CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run")
    expect(result.output).toContain("bun run cloud:verify --preflight")
    expect(result.output).toContain("bun run cloud:verify --evidence")
    expect(result.output).toContain("bun run cloud:local:acceptance")
    expect(result.output).toContain("bun run cloud:verify --runbook")
    expect(result.output).toContain("bun run cloud:release:github-actions")
    expect(result.output).toContain("bun run cloud:release:github-actions:write")
    expect(result.output).toContain("not production operation")
  })

  test("renders a real-run operator runbook without running commands", async () => {
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--runbook"],
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-opencode",
        CLOUD_RUNTIME_K8S_DIR: ".cloud-runtime-k8s",
      },
      run: async () => {
        throw new Error("should not execute commands")
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime real-run operator runbook")
    expect(result.output).toContain("Run from packages/opencode.")
    expect(result.output).toContain("Run bun run cloud:real-runbook:check to aggregate audit, local opencode preflight, and provider readiness without real model/provider calls.")
    expect(result.output).toContain("Run bun run cloud:opencode:preflight to check local opencode prerequisites without invoking a model-backed job.")
    expect(result.output).toContain("Run bun run cloud:providers:env to generate a production provider env template")
    expect(result.output).toContain("Set CLOUD_RUNTIME_API_BASE_URL and CLOUD_RUNTIME_API_KEY before applying runtime pool scale plans.")
    expect(result.output).toContain("1. preflight-audit")
    expect(result.output).toContain("command: bun run cloud:verify --audit")
    expect(result.output).toContain("2. local-system-preflight")
    expect(result.output).toContain("command: bun run cloud:verify --preflight")
    expect(result.output).toContain("3. local-opencode-smoke")
    expect(result.output).toContain("command: CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 bun run cloud:opencode:smoke")
    expect(result.output).toContain("run bun run cloud:opencode:plan and bun run cloud:opencode:preflight")
    expect(result.output).toContain("4. docker-runtime-smoke")
    expect(result.output).toContain("command: CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:run .cloud-runtime-opencode")
    expect(result.output).toContain("5. provider-smoke")
    expect(result.output).toContain("Postgres schema/query, queue enqueue/lease/ack, and object storage put/list/get/sign/delete pass")
    expect(result.output).toContain("6. kubernetes-smoke")
    expect(result.output).toContain("Kubernetes NetworkPolicy and Pod are created")
    expect(result.output).toContain("7. runtime-pool-apply")
    expect(result.output).toContain("Admin apply-plan returns a desired runtime count")
    expect(result.output).toContain("8. release-gate")
    expect(result.output).toContain("Completion evidence:")
    expect(result.output).toContain("cloud:api:smoke passes locally and against the deployed API base URL")
    expect(result.output).toContain("cloud:runtime-pool:apply reaches the deployed admin API")
  })

  test("runs a real-runbook check without invoking real model or provider health calls", async () => {
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--real-runbook-check"],
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-opencode",
        CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE: "1",
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
        CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE: "1",
        CLOUD_RUNTIME_CONFIRM_K8S_SMOKE: "1",
        CLOUD_RUNTIME_CONFIRM_APPLY_PLAN: "1",
        CLOUD_RUNTIME_API_BASE_URL: "https://runtime.example.com",
        CLOUD_RUNTIME_API_KEY: "key_abc",
        CLOUD_RUNTIME_MODEL_PROVIDER: "openai",
        CLOUD_RUNTIME_MODEL: "gpt-5",
        OPENAI_API_KEY: "sk-openai",
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:secret@localhost:5432/cloud_runtime",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://localhost:9000",
        CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
        CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID: "opencode",
        CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY: "opencode-password",
        CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
        CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
        CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
      },
      opencodePreflight: async () => ({
        ok: true,
        checks: [
          { name: "opencode-executable", status: "passed", detail: "opencode is available" },
          { name: "model-credentials", status: "passed", detail: "OPENAI_API_KEY is configured" },
          { name: "execution-timeout", status: "passed", detail: "900000ms" },
          { name: "sqlite-path", status: "passed", detail: "in-memory SQLite database" },
          { name: "sandbox-root", status: "passed", detail: "/tmp/cloud-opencode-smoke is writable" },
        ],
      }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime real-runbook check: passed")
    expect(result.output).toContain("[passed] real-environment-audit")
    expect(result.output).toContain("[passed] local-opencode-preflight")
    expect(result.output).toContain("[passed] provider-readiness")
    expect(result.output).toContain("Next real-run commands after this check passes:")
  })

  test("reports real-runbook check failures with section diagnostics", async () => {
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--real-runbook-check"],
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-opencode",
        CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "0",
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Cloud Runtime real-runbook check: failed")
    expect(result.output).toContain("[failed] real-environment-audit")
    expect(result.output).toContain("[failed] local-opencode-preflight")
    expect(result.output).toContain("[failed] provider-readiness")
    expect(result.output).toContain("ANTHROPIC_API_KEY is required")
    expect(result.output).toContain("CLOUD_RUNTIME_DATABASE_URL is required")
  })

  test("runs real-environment preflight probes without starting real smoke jobs", async () => {
    const probes: string[] = []
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--preflight"],
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-opencode",
        CLOUD_RUNTIME_K8S_DIR: ".cloud-runtime-k8s",
        CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE: "1",
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
        CLOUD_RUNTIME_CONFIRM_K8S_SMOKE: "1",
        CLOUD_RUNTIME_CONFIRM_APPLY_PLAN: "1",
        CLOUD_RUNTIME_API_BASE_URL: "https://runtime.example.com",
        CLOUD_RUNTIME_API_KEY: "key_abc",
        CLOUD_RUNTIME_MODEL_PROVIDER: "openai",
        CLOUD_RUNTIME_MODEL: "gpt-5",
        OPENAI_API_KEY: "sk-openai",
        CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "600000",
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:secret@localhost:5432/cloud_runtime",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://localhost:9000",
        CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
        CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID: "opencode",
        CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY: "opencode-password",
        CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
        CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
        CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
        CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE: "1",
        CLOUD_RUNTIME_SQLITE_PATH: "/tmp/cloud-runtime-smoke.sqlite",
        CLOUD_RUNTIME_SANDBOX_ROOT: "/tmp/cloud-opencode-smoke",
      },
      probe: async (probe) => {
        probes.push(probe.name)
        return { ok: true, detail: `${probe.name} ok` }
      },
    })

    expect(result.exitCode).toBe(0)
    expect(probes).toEqual(["opencode-executable", "sqlite-path-writable", "sandbox-root-writable", "docker-daemon", "docker-compose", "api-port-free"])
    expect(result.output).toContain("Cloud Runtime real-environment preflight: passed")
    expect(result.output).toContain("[passed] real-opencode-credentials: OPENAI_API_KEY is configured")
    expect(result.output).toContain("[passed] provider-kubernetes-env: cloud-runtime at https://kubernetes.example.com")
    expect(result.output).toContain("[passed] docker-daemon: docker-daemon ok")
    expect(result.output).toContain("[passed] api-port-free: api-port-free ok")
  })

  test("reports failed real-environment preflight probes before real execution", async () => {
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--preflight"],
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-opencode",
        CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "0",
        CLOUD_RUNTIME_SQLITE_PATH: "/locked/cloud-runtime-smoke.sqlite",
        CLOUD_RUNTIME_SANDBOX_ROOT: "/locked/cloud-opencode-smoke",
      },
      probe: async (probe) => ({
        ok: false,
        detail: `${probe.command} failed`,
      }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Cloud Runtime real-environment preflight: failed")
    expect(result.output).toContain("[failed] real-opencode-confirmation")
    expect(result.output).toContain("[failed] real-opencode-timeout")
    expect(result.output).toContain("[failed] provider-object-storage-env")
    expect(result.output).toContain("[failed] opencode-executable: command -v opencode failed")
    expect(result.output).toContain("[failed] docker-daemon: docker info failed")
    expect(result.output).toContain("Remediation:")
    expect(result.output).toContain("set CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 only when you are ready to run a real model-backed opencode smoke")
    expect(result.output).toContain("start Docker Desktop or the local Docker daemon, then rerun bun run cloud:verify --preflight")
    expect(result.output).toContain("configure CLOUD_RUNTIME_OBJECT_ENDPOINT, CLOUD_RUNTIME_OBJECT_BUCKET, CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID, and CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY")
  })

  test("runs only safe verification steps in check mode", async () => {
    const calls: string[] = []
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--check"],
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-opencode",
        CLOUD_RUNTIME_K8S_DIR: ".cloud-runtime-k8s",
      },
      run: async (step) => {
        calls.push(step.name)
        return { ok: true, stdout: `${step.name} ok`, stderr: "" }
      },
    })

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([
      "generate-docker",
      "check-docker",
      "plan-docker-smoke",
      "plan-shared-docker-e2e",
      "plan-local-opencode",
      "smoke-api-server",
      "check-providers",
      "generate-kubernetes",
      "check-kubernetes",
      "check-release",
      "plan-release-workflow",
    ])
    expect(result.output).toContain("Cloud Runtime verification check: passed")
    expect(result.output).toContain("[passed] plan-release-workflow")
    expect(result.output).not.toContain("run-real-docker-smoke")
  })

  test("renders a local acceptance plan for developer machine validation", async () => {
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--local-acceptance"],
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-shared",
        CLOUD_RUNTIME_K8S_SERVER_URL: "http://127.0.0.1:18001",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
        CLOUD_RUNTIME_K8S_SMOKE_IMAGE: "cloud-runtime-opencode:1.14.28",
      },
      run: async () => {
        throw new Error("should not execute commands")
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime local acceptance plan")
    expect(result.output).toContain("shared-session-docker-e2e")
    expect(result.output).toContain("start-local-provider-stack")
    expect(result.output).toContain("CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e")
    expect(result.output).toContain("bun run cloud:docker:shared && cd .cloud-runtime-shared && docker compose --env-file api.env --env-file worker.env up -d postgres minio minio-init redis")
    expect(result.output).toContain("CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker bun run cloud:providers:check --health")
    expect(result.output).toContain("CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke")
    expect(result.output).toContain("stop-local-provider-stack")
    expect(result.output).toContain("CLOUD_RUNTIME_K8S_SERVER_URL=http://127.0.0.1:18001")
    expect(result.output).toContain("CLOUD_RUNTIME_K8S_SMOKE_IMAGE=cloud-runtime-opencode:1.14.28")
    expect(result.output).toContain("kubernetes-worker-docker-e2e")
    expect(result.output).toContain("CLOUD_RUNTIME_K8S_SERVER_URL=http://host.docker.internal:18001 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:k8s:e2e")
    expect(result.output).toContain("Model-backed local opencode smoke remains a separate optional proof")
  })

  test("renders local acceptance JSON for CI artifacts", async () => {
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--local-acceptance-json"],
      env: {
        CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime-shared",
        CLOUD_RUNTIME_K8S_SERVER_URL: "http://127.0.0.1:18001",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
        CLOUD_RUNTIME_K8S_SMOKE_IMAGE: "cloud-runtime-opencode:1.14.28",
      },
    })
    const acceptance = JSON.parse(result.output) as {
      title: string
      steps: Array<{ name: string; command: string }>
    }

    expect(result.exitCode).toBe(0)
    expect(acceptance.title).toBe("Cloud Runtime local acceptance plan")
    expect(acceptance.steps.map((item) => item.name)).toEqual([
      "safe-code-verification",
      "shared-session-docker-e2e",
      "start-local-provider-stack",
      "local-provider-smoke",
      "local-provider-health",
      "stop-local-provider-stack",
      "kind-kubernetes-smoke",
      "kubernetes-worker-docker-e2e",
    ])
    expect(acceptance.steps.find((item) => item.name === "kind-kubernetes-smoke")?.command).toContain("CLOUD_RUNTIME_K8S_ALLOW_LOCAL_PROXY=1")
  })

  test("stops safe verification checks after the first failed step", async () => {
    const calls: string[] = []
    const result = await CloudVerification.runCLI({
      argv: ["bun", "verification.ts", "--check"],
      run: async (step) => {
        calls.push(step.name)
        return step.name === "check-docker"
          ? { ok: false, stdout: "", stderr: "docker wiring failed" }
          : { ok: true, stdout: `${step.name} ok`, stderr: "" }
      },
    })

    expect(result.exitCode).toBe(1)
    expect(calls).toEqual(["generate-docker", "check-docker"])
    expect(result.output).toContain("Cloud Runtime verification check: failed")
    expect(result.output).toContain("[failed] check-docker")
    expect(result.output).toContain("docker wiring failed")
  })

  test("exposes a package script for verification planning", async () => {
    expect((await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts["cloud:verify"]).toBe(
      "bun run ./src/cloud/verification.ts",
    )
    expect((await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts["cloud:local:acceptance"]).toBe(
      "CLOUD_RUNTIME_DOCKER_DIR=.cloud-runtime-shared CLOUD_RUNTIME_DOCKER_PROFILE=shared bun run ./src/cloud/verification.ts --local-acceptance",
    )
    expect((await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts["cloud:local:acceptance:json"]).toBe(
      "CLOUD_RUNTIME_DOCKER_DIR=.cloud-runtime-shared CLOUD_RUNTIME_DOCKER_PROFILE=shared bun run ./src/cloud/verification.ts --local-acceptance-json",
    )
    expect((await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts["cloud:real-runbook:check"]).toBe(
      "bun run ./src/cloud/verification.ts --real-runbook-check",
    )
  })
})
