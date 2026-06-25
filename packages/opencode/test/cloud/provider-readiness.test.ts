import { describe, expect, test } from "bun:test"
import { CloudProviderReadiness } from "../../src/cloud/provider-readiness"

describe("CloudProviderReadiness", () => {
  test("checks production provider configuration and builds health-check plans", () => {
    const result = CloudProviderReadiness.fromEnv({
      CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:secret@postgres.example.com:5432/cloud_runtime",
      CLOUD_RUNTIME_OBJECT_ENDPOINT: "https://s3.example.com",
      CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
      CLOUD_RUNTIME_OBJECT_REGION: "us-east-1",
      CLOUD_RUNTIME_QUEUE_PROVIDER: "postgres",
      CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
      CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
      CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
      CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
    })

    expect(result.ok).toBe(true)
    expect(result.checks).toEqual([
      { name: "postgres-config", status: "passed", detail: "CLOUD_RUNTIME_DATABASE_URL configured" },
      { name: "object-storage-config", status: "passed", detail: "runtime-artifacts at https://s3.example.com" },
      { name: "queue-config", status: "passed", detail: "postgres queue cloud-runtime-jobs configured" },
      { name: "kubernetes-config", status: "passed", detail: "cloud-runtime at https://kubernetes.example.com" },
    ])
    expect(result.plans.map((item) => [item.name, item.command])).toEqual([
      ["postgres-health", "select 1"],
      ["object-storage-health", "head bucket runtime-artifacts"],
      ["queue-health", "lease dry-run cloud-runtime-jobs"],
      ["kubernetes-health", "GET /api/v1/namespaces/cloud-runtime"],
    ])
    expect(CloudProviderReadiness.summary(result)).toContain("Cloud Runtime provider readiness: passed")
  })

  test("reports missing production provider configuration", () => {
    const result = CloudProviderReadiness.fromEnv({
      CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
      CLOUD_RUNTIME_QUEUE_PROVIDER: "sqs",
      CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
    })

    expect(result.ok).toBe(false)
    expect(result.checks.filter((item) => item.status === "failed").map((item) => item.name)).toEqual([
      "postgres-config",
      "object-storage-config",
      "queue-config",
      "kubernetes-config",
    ])
    expect(CloudProviderReadiness.summary(result)).toContain("[failed] queue-config: CLOUD_RUNTIME_QUEUE is required for sqs queue")
  })

  test("builds local Docker provider defaults without requiring Kubernetes", () => {
    const result = CloudProviderReadiness.fromEnv({
      CLOUD_RUNTIME_PROVIDER_PROFILE: "local-docker",
    })

    expect(result.ok).toBe(true)
    expect(result.checks).toEqual([
      { name: "postgres-config", status: "passed", detail: "CLOUD_RUNTIME_DATABASE_URL configured" },
      { name: "object-storage-config", status: "passed", detail: "runtime-artifacts at http://localhost:9000" },
      { name: "queue-config", status: "passed", detail: "postgres queue cloud-runtime-jobs configured" },
      { name: "kubernetes-config", status: "passed", detail: "skipped for local-docker profile" },
    ])
    expect(result.plans.map((item) => [item.name, item.provider, item.command])).toEqual([
      ["postgres-health", "postgres", "select 1"],
      ["object-storage-health", "object_storage", "head bucket runtime-artifacts"],
      ["queue-health", "queue", "lease dry-run cloud-runtime-jobs"],
    ])
  })

  test("allows local Docker provider ports and credentials to be overridden", () => {
    const result = CloudProviderReadiness.fromEnv({
      CLOUD_RUNTIME_PROVIDER_PROFILE: "local-docker",
      CLOUD_RUNTIME_POSTGRES_PORT: "15432",
      CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://127.0.0.1:19000",
      CLOUD_RUNTIME_OBJECT_BUCKET: "custom-artifacts",
      CLOUD_RUNTIME_QUEUE: "custom-queue",
    })

    expect(result.ok).toBe(true)
    expect(result.env).toMatchObject({
      CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:opencode@localhost:15432/cloud_runtime",
      CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://127.0.0.1:19000",
      CLOUD_RUNTIME_OBJECT_BUCKET: "custom-artifacts",
      CLOUD_RUNTIME_QUEUE: "custom-queue",
    })
    expect(result.plans.map((item) => item.command)).toEqual([
      "select 1",
      "head bucket custom-artifacts",
      "lease dry-run custom-queue",
    ])
  })

  test("executes provider health-check plans through an injected runner", async () => {
    const called: string[] = []
    const readiness = CloudProviderReadiness.fromEnv({
      CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:secret@postgres.example.com:5432/cloud_runtime",
      CLOUD_RUNTIME_OBJECT_ENDPOINT: "https://s3.example.com",
      CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
      CLOUD_RUNTIME_QUEUE_PROVIDER: "postgres",
      CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
      CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
      CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
      CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
    })

    const result = await CloudProviderReadiness.runHealthChecks({
      plans: readiness.plans,
      run: async (plan) => {
        called.push(`${plan.provider}:${plan.command}`)
        return { ok: true, detail: `${plan.name} ok` }
      },
    })

    expect(result.ok).toBe(true)
    expect(called).toEqual([
      "postgres:select 1",
      "object_storage:head bucket runtime-artifacts",
      "queue:lease dry-run cloud-runtime-jobs",
      "kubernetes:GET /api/v1/namespaces/cloud-runtime",
    ])
    expect(result.checks).toEqual([
      { name: "postgres-health", status: "passed", detail: "postgres-health ok" },
      { name: "object-storage-health", status: "passed", detail: "object-storage-health ok" },
      { name: "queue-health", status: "passed", detail: "queue-health ok" },
      { name: "kubernetes-health", status: "passed", detail: "kubernetes-health ok" },
    ])
  })

  test("records provider health-check failures without stopping later checks", async () => {
    const result = await CloudProviderReadiness.runHealthChecks({
      plans: [
        { name: "postgres-health", provider: "postgres", command: "select 1" },
        { name: "object-storage-health", provider: "object_storage", command: "head bucket runtime-artifacts" },
        { name: "queue-health", provider: "queue", command: "lease dry-run cloud-runtime-jobs" },
      ],
      run: async (plan) => {
        if (plan.provider === "object_storage") throw new Error("bucket unavailable")
        return { ok: true, detail: `${plan.provider} ok` }
      },
    })

    expect(result.ok).toBe(false)
    expect(result.checks).toEqual([
      { name: "postgres-health", status: "passed", detail: "postgres ok" },
      { name: "object-storage-health", status: "failed", detail: "bucket unavailable" },
      { name: "queue-health", status: "passed", detail: "queue ok" },
    ])
    expect(CloudProviderReadiness.healthSummary(result)).toContain("[failed] object-storage-health: bucket unavailable")
  })

  test("builds a default health runner from provider clients", async () => {
    const calls: unknown[] = []
    const run = CloudProviderReadiness.defaultHealthRunner({
      postgres: {
        query: async (sql, params) => {
          calls.push(["postgres", sql, params])
          return { rows: [{ ok: 1 }] }
        },
      },
      objectStorage: {
        listObjects: async (input) => {
          calls.push(["object_storage", input])
          return []
        },
      },
      queue: {
        lease: async (input) => {
          calls.push(["queue", input])
          return { leased: false, reason: "dry_run" }
        },
      },
      kubernetes: {
        getNamespace: async (input) => {
          calls.push(["kubernetes", input])
          return { name: input.namespace }
        },
      },
    })

    const result = await CloudProviderReadiness.runHealthChecks({
      plans: [
        { name: "postgres-health", provider: "postgres", command: "select 1" },
        { name: "object-storage-health", provider: "object_storage", command: "head bucket runtime-artifacts" },
        { name: "queue-health", provider: "queue", command: "lease dry-run cloud-runtime-jobs" },
        { name: "kubernetes-health", provider: "kubernetes", command: "GET /api/v1/namespaces/cloud-runtime" },
      ],
      run,
    })

    expect(result.ok).toBe(true)
    expect(result.checks.map((item) => item.detail)).toEqual([
      "postgres query succeeded",
      "object storage bucket runtime-artifacts reachable",
      "queue cloud-runtime-jobs reachable",
      "kubernetes namespace cloud-runtime reachable",
    ])
    expect(calls).toEqual([
      ["postgres", "select 1", []],
      ["object_storage", { bucket: "runtime-artifacts", prefix: "", notBefore: 0 }],
      [
        "queue",
        {
          queue: "cloud-runtime-jobs",
          tenantID: "healthcheck",
          jobID: "healthcheck",
          workerID: "healthcheck",
          leaseTTLMS: 1000,
        },
      ],
      ["kubernetes", { namespace: "cloud-runtime" }],
    ])
  })

  test("default health runner reports missing clients as failed checks", async () => {
    const result = await CloudProviderReadiness.runHealthChecks({
      plans: [{ name: "postgres-health", provider: "postgres", command: "select 1" }],
      run: CloudProviderReadiness.defaultHealthRunner({}),
    })

    expect(result).toEqual({
      ok: false,
      checks: [{ name: "postgres-health", status: "failed", detail: "Postgres health client is not configured" }],
    })
  })

  test("builds CLI config from argv and environment", () => {
    expect(
      CloudProviderReadiness.cliConfig({
        argv: ["bun", "provider-readiness.ts", "--health", "--env-template", "--evidence"],
        env: { CLOUD_RUNTIME_QUEUE_PROVIDER: "postgres" },
      }),
    ).toEqual({
      envTemplate: true,
      evidence: true,
      health: true,
      env: { CLOUD_RUNTIME_QUEUE_PROVIDER: "postgres" },
    })
  })

  test("renders production and local Docker provider env templates", () => {
    expect(CloudProviderReadiness.envTemplate()).toContain("Cloud Runtime provider env template: production")
    expect(CloudProviderReadiness.envTemplate()).toContain("CLOUD_RUNTIME_DATABASE_URL=postgres://opencode:secret@postgres.example.com:5432/cloud_runtime")
    expect(CloudProviderReadiness.envTemplate()).toContain("CLOUD_RUNTIME_K8S_SERVER_URL=https://kubernetes.example.com")
    expect(CloudProviderReadiness.envTemplate({ profile: "local-docker" })).toContain("Cloud Runtime provider env template: local-docker")
    expect(CloudProviderReadiness.envTemplate({ profile: "local-docker" })).toContain("CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker")
    expect(CloudProviderReadiness.envTemplate({ profile: "local-docker" })).toContain("CLOUD_RUNTIME_POSTGRES_PORT=55432")
  })

  test("runs the CLI provider env template path without checking providers", async () => {
    const result = await CloudProviderReadiness.runCLI({
      envTemplate: true,
      env: {
        CLOUD_RUNTIME_PROVIDER_PROFILE: "local-docker",
      },
      run: async () => {
        throw new Error("health should not run")
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime provider env template: local-docker")
    expect(result.output).toContain("CLOUD_RUNTIME_OBJECT_ENDPOINT=http://localhost:9000")
  })

  test("renders provider readiness evidence without running health checks", async () => {
    const result = await CloudProviderReadiness.runCLI({
      evidence: true,
      env: {
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:secret@postgres.example.com:5432/cloud_runtime",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "https://s3.example.com",
        CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
        CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
        CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
        CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
      },
      run: async () => {
        throw new Error("health should not run")
      },
    })
    const evidence = JSON.parse(result.output) as { status: string; readiness: { ok: boolean }; healthPlans: Array<{ name: string }> }

    expect(result.exitCode).toBe(0)
    expect(evidence.status).toBe("provider_readiness_evidence")
    expect(evidence.readiness.ok).toBe(true)
    expect(evidence.healthPlans.map((item) => item.name)).toEqual(["postgres-health", "object-storage-health", "queue-health", "kubernetes-health"])
  })

  test("renders provider health evidence with per-provider results", async () => {
    const result = await CloudProviderReadiness.runCLI({
      evidence: true,
      health: true,
      env: {
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:secret@postgres.example.com:5432/cloud_runtime",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "https://s3.example.com",
        CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
        CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
        CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
        CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
      },
      run: async (plan) => ({ ok: plan.provider !== "object_storage", detail: `${plan.name} checked` }),
    })
    const evidence = JSON.parse(result.output) as { status: string; health: { ok: boolean; checks: Array<{ name: string; status: string; detail: string }> } }

    expect(result.exitCode).toBe(1)
    expect(evidence.status).toBe("provider_health_evidence")
    expect(evidence.health.ok).toBe(false)
    expect(evidence.health.checks).toContainEqual({
      name: "object-storage-health",
      status: "failed",
      detail: "object-storage-health checked",
    })
  })

  test("runs the CLI readiness path without executing health checks by default", async () => {
    const result = await CloudProviderReadiness.runCLI({
      env: {
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:secret@postgres.example.com:5432/cloud_runtime",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "https://s3.example.com",
        CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
        CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
        CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
        CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
      },
      run: async () => {
        throw new Error("health should not run")
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime provider readiness: passed")
    expect(result.output).toContain("Health check plans:")
  })

  test("runs CLI health checks when requested", async () => {
    const called: string[] = []
    const result = await CloudProviderReadiness.runCLI({
      health: true,
      env: {
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:secret@postgres.example.com:5432/cloud_runtime",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "https://s3.example.com",
        CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
        CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
        CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
        CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
      },
      run: async (plan) => {
        called.push(plan.name)
        return { ok: true, detail: `${plan.provider} ok` }
      },
    })

    expect(result.exitCode).toBe(0)
    expect(called).toEqual(["postgres-health", "object-storage-health", "queue-health", "kubernetes-health"])
    expect(result.output).toContain("Cloud Runtime provider health checks: passed")
  })

  test("runs CLI readiness path for local Docker provider defaults", async () => {
    const result = await CloudProviderReadiness.runCLI({
      env: {
        CLOUD_RUNTIME_PROVIDER_PROFILE: "local-docker",
      },
      run: async () => {
        throw new Error("health should not run")
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime provider readiness: passed")
    expect(result.output).toContain("[passed] kubernetes-config: skipped for local-docker profile")
    expect(result.output).toContain("object-storage-health: head bucket runtime-artifacts")
  })

  test("runs CLI health checks for local Docker provider without Kubernetes", async () => {
    const called: string[] = []
    const result = await CloudProviderReadiness.runCLI({
      health: true,
      env: {
        CLOUD_RUNTIME_PROVIDER_PROFILE: "local-docker",
      },
      run: async (plan) => {
        called.push(plan.name)
        return { ok: true, detail: `${plan.provider} ok` }
      },
    })

    expect(result.exitCode).toBe(0)
    expect(called).toEqual(["postgres-health", "object-storage-health", "queue-health"])
    expect(result.output).toContain("[passed] kubernetes-config: skipped for local-docker profile")
  })

  test("does not run CLI health checks when readiness config fails", async () => {
    const called: string[] = []
    const result = await CloudProviderReadiness.runCLI({
      health: true,
      env: {},
      run: async (plan) => {
        called.push(plan.name)
        return { ok: true, detail: "ok" }
      },
    })

    expect(result.exitCode).toBe(1)
    expect(called).toEqual([])
    expect(result.output).toContain("Cloud Runtime provider readiness: failed")
  })

  test("exposes a package script for provider readiness checks", async () => {
    expect((await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts["cloud:providers:check"]).toBe(
      "bun run ./src/cloud/provider-readiness.ts",
    )
    expect((await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts["cloud:providers:env"]).toBe(
      "bun run ./src/cloud/provider-readiness.ts --env-template",
    )
    expect((await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts["cloud:providers:evidence"]).toBe(
      "bun run ./src/cloud/provider-readiness.ts --evidence",
    )
  })
})
