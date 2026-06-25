import { describe, expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import os from "os"
import path from "path"
import { CloudDeployment } from "../../src/cloud/deployment"
import packageJSON from "../../package.json"

describe("CloudDeployment", () => {
  test("plans production control-plane and worker deployment topology", () => {
    const result = CloudDeployment.plan({
      environment: "production",
      namespace: "cloud-runtime",
      image: "registry.example.com/cloud-runtime-api:1.0.0",
      imageDigest: "sha256:api",
      runtimeDefaultVersion: "1.14.28",
      apiBasePath: "/cloud",
      authMode: "api_key",
      corsOrigins: ["https://saas.example.com"],
      databaseURLSecretRef: "cloud-runtime-db",
      objectStorageBucket: "runtime-artifacts",
      queueName: "cloud-runtime-jobs",
      otelEndpoint: "https://otel.example.com",
      autoscale: { minWorkers: 2, maxWorkers: 20, jobsPerWorker: 5 },
    })

    expect(result.image).toBe("registry.example.com/cloud-runtime-api:1.0.0@sha256:api")
    expect(result.api.replicas).toBe(3)
    expect(result.api.mount.routes.some((route) => route.path === "/openapi.json")).toBe(false)
    expect(result.worker.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("true")
    expect(result.dependencies).toEqual({
      database: { secretRef: "cloud-runtime-db" },
      objectStorage: { bucket: "runtime-artifacts" },
      queue: { name: "cloud-runtime-jobs" },
      sandboxNamespace: "cloud-runtime",
    })
  })

  test("keeps dev deployments small and exposes OpenAPI", () => {
    const result = CloudDeployment.plan({
      environment: "dev",
      namespace: "cloud-runtime-dev",
      image: "cloud-runtime-api:dev",
      runtimeDefaultVersion: "1.14.28",
      authMode: "none",
      databaseURLSecretRef: "dev-db",
      objectStorageBucket: "dev-artifacts",
      queueName: "dev-jobs",
      autoscale: { minWorkers: 0, maxWorkers: 2, jobsPerWorker: 1 },
    })

    expect(result.api.replicas).toBe(1)
    expect(result.orchestrator.replicas).toBe(1)
    expect(result.worker.replicas).toBe(0)
    expect(result.api.mount.routes.some((route) => route.path === "/openapi.json")).toBe(true)
  })

  test("uses deployment autoscale policy for worker scale decisions", () => {
    const deployment = CloudDeployment.plan({
      environment: "staging",
      namespace: "cloud-runtime-staging",
      image: "cloud-runtime-api:staging",
      runtimeDefaultVersion: "1.14.28",
      authMode: "internal_jwt",
      databaseURLSecretRef: "staging-db",
      objectStorageBucket: "staging-artifacts",
      queueName: "staging-jobs",
      autoscale: { minWorkers: 1, maxWorkers: 10, jobsPerWorker: 5 },
    })

    expect(
      CloudDeployment.scaleDecision({
        deployment,
        queue: { depth: 30, oldestQueuedAgeMS: 60_000 },
        workers: { current: 1, busy: 1 },
      }),
    ).toEqual({
      desired: 3,
      reason: "queue_depth",
    })
  })

  test("renders production Kubernetes manifests from a deployment plan", () => {
    const result = CloudDeployment.kubernetesManifests(
      CloudDeployment.plan({
        environment: "production",
        namespace: "cloud-runtime",
        image: "registry.example.com/cloud-runtime-api:1.0.0",
        imageDigest: "sha256:api",
        runtimeDefaultVersion: "1.14.28",
        authMode: "api_key",
        databaseURLSecretRef: "cloud-runtime-db",
        objectStorageBucket: "runtime-artifacts",
        queueName: "cloud-runtime-jobs",
        autoscale: { minWorkers: 2, maxWorkers: 20, jobsPerWorker: 5 },
      }),
    )

    expect(result.map((item) => `${item.kind}/${item.metadata.name}`)).toEqual([
      "Namespace/cloud-runtime",
      "Deployment/cloud-runtime-api",
      "Service/cloud-runtime-api",
      "Deployment/cloud-runtime-worker",
      "HorizontalPodAutoscaler/cloud-runtime-worker",
    ])
    expect(result.find((item) => item.kind === "Deployment" && item.metadata.name === "cloud-runtime-api")).toMatchObject({
      spec: {
        replicas: 3,
        template: {
          spec: {
            containers: [
              {
                name: "api",
                image: "registry.example.com/cloud-runtime-api:1.0.0@sha256:api",
                ports: [{ containerPort: 8787 }],
                env: expect.arrayContaining([
                  { name: "CLOUD_RUNTIME_ENVIRONMENT", value: "production" },
                  {
                    name: "CLOUD_RUNTIME_DATABASE_URL",
                    valueFrom: { secretKeyRef: { name: "cloud-runtime-db", key: "url" } },
                  },
                ]),
              },
            ],
          },
        },
      },
    })
    expect(result.find((item) => item.kind === "Deployment" && item.metadata.name === "cloud-runtime-worker")).toMatchObject({
      spec: {
        replicas: 2,
        template: {
          spec: {
            containers: [
              {
                name: "worker",
                image: "registry.example.com/cloud-runtime-api:1.0.0@sha256:api",
                env: expect.arrayContaining([
                  { name: "OPENCODE_DISABLE_AUTOUPDATE", value: "true" },
                  { name: "CLOUD_RUNTIME_OBJECT_BUCKET", value: "runtime-artifacts" },
                ]),
              },
            ],
          },
        },
      },
    })
    expect(result.find((item) => item.kind === "HorizontalPodAutoscaler")).toMatchObject({
      spec: {
        minReplicas: 2,
        maxReplicas: 20,
        scaleTargetRef: {
          kind: "Deployment",
          name: "cloud-runtime-worker",
        },
      },
    })
  })

  test("renders Kubernetes manifests as multi-document YAML", () => {
    const result = CloudDeployment.kubernetesYAML(
      CloudDeployment.plan({
        environment: "staging",
        namespace: "cloud-runtime-staging",
        image: "registry.example.com/cloud-runtime-api:1.0.0",
        runtimeDefaultVersion: "1.14.28",
        authMode: "internal_jwt",
        databaseURLSecretRef: "cloud-runtime-db",
        objectStorageBucket: "runtime-artifacts",
        queueName: "cloud-runtime-jobs",
        autoscale: { minWorkers: 1, maxWorkers: 5, jobsPerWorker: 3 },
      }),
    )

    expect(result).toStartWith("apiVersion: v1\nkind: Namespace\n")
    expect(result).toContain("---\napiVersion: apps/v1\nkind: Deployment\n")
    expect(result).toContain("name: cloud-runtime-api")
    expect(result).toContain("name: CLOUD_RUNTIME_DATABASE_URL")
    expect(result).toContain("secretKeyRef:")
    expect(result).toEndWith("\n")
  })

  test("writes Kubernetes deployment files to disk", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-k8s-"))
    const result = await CloudDeployment.writeKubernetesFiles({
      directory,
      environment: "production",
      namespace: "cloud-runtime",
      image: "registry.example.com/cloud-runtime-api:1.0.0",
      imageDigest: "sha256:api",
      runtimeDefaultVersion: "1.14.28",
      authMode: "api_key",
      databaseURLSecretRef: "cloud-runtime-db",
      objectStorageBucket: "runtime-artifacts",
      queueName: "cloud-runtime-jobs",
      autoscale: { minWorkers: 2, maxWorkers: 20, jobsPerWorker: 5 },
    })

    expect(result.files.map((item) => path.basename(item))).toEqual(["cloud-runtime.k8s.yaml", "README.md"])
    expect(await Bun.file(path.join(directory, "cloud-runtime.k8s.yaml")).text()).toContain("kind: HorizontalPodAutoscaler")
    expect(await Bun.file(path.join(directory, "README.md")).text()).toContain("kubectl apply -f cloud-runtime.k8s.yaml")
    expect(result.summary).toContain("Wrote Cloud Runtime Kubernetes files")
  })

  test("builds Kubernetes deployment CLI config from argv and environment", () => {
    expect(
      CloudDeployment.cliConfig({
        argv: ["bun", "src/cloud/deployment.ts", "/tmp/cloud-runtime-k8s"],
        env: {
          CLOUD_RUNTIME_ENVIRONMENT: "staging",
          CLOUD_RUNTIME_NAMESPACE: "cloud-runtime-staging",
          CLOUD_RUNTIME_IMAGE: "registry.example.com/cloud-runtime-api:1.0.0",
          CLOUD_RUNTIME_IMAGE_DIGEST: "sha256:api",
          CLOUD_RUNTIME_DEFAULT_VERSION: "1.14.28",
          CLOUD_RUNTIME_AUTH_MODE: "internal_jwt",
          CLOUD_RUNTIME_DATABASE_URL_SECRET: "cloud-runtime-db",
          CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
          CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
          CLOUD_RUNTIME_AUTOSCALE_MIN_WORKERS: "1",
          CLOUD_RUNTIME_AUTOSCALE_MAX_WORKERS: "8",
          CLOUD_RUNTIME_AUTOSCALE_JOBS_PER_WORKER: "4",
        },
      }),
    ).toEqual({
      directory: "/tmp/cloud-runtime-k8s",
      environment: "staging",
      namespace: "cloud-runtime-staging",
      image: "registry.example.com/cloud-runtime-api:1.0.0",
      imageDigest: "sha256:api",
      runtimeDefaultVersion: "1.14.28",
      authMode: "internal_jwt",
      databaseURLSecretRef: "cloud-runtime-db",
      objectStorageBucket: "runtime-artifacts",
      queueName: "cloud-runtime-jobs",
      autoscale: { minWorkers: 1, maxWorkers: 8, jobsPerWorker: 4 },
    })
  })

  test("exposes a package script for Kubernetes deployment file generation", () => {
    expect(packageJSON.scripts["cloud:k8s"]).toBe("bun run ./src/cloud/deployment.ts")
  })

  test("checks generated Kubernetes deployment files before apply", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-k8s-check-"))
    await CloudDeployment.writeKubernetesFiles({
      directory,
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

    const result = await CloudDeployment.checkKubernetesDirectory({ directory })

    expect(result.ok).toBe(true)
    expect(result.checks.map((item) => item.name)).toEqual([
      "manifest-file",
      "api-deployment",
      "worker-deployment",
      "database-secret-ref",
      "object-storage-env",
      "queue-env",
      "worker-autoupdate-disabled",
      "worker-hpa",
      "api-service",
    ])
    expect(result.checks.every((item) => item.status === "passed")).toBe(true)
  })

  test("reports Kubernetes deployment check failures with actionable details", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-k8s-bad-check-"))
    await Bun.write(
      path.join(directory, "cloud-runtime.k8s.yaml"),
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: cloud-runtime-api",
        "",
      ].join("\n"),
    )

    const result = await CloudDeployment.checkKubernetesDirectory({ directory })

    expect(result.ok).toBe(false)
    expect(result.checks.filter((item) => item.status === "failed").map((item) => item.name)).toEqual([
      "worker-deployment",
      "database-secret-ref",
      "object-storage-env",
      "queue-env",
      "worker-autoupdate-disabled",
      "worker-hpa",
      "api-service",
    ])
    expect(CloudDeployment.checkSummary(result)).toContain("[failed] database-secret-ref")
  })

  test("runs the Kubernetes check CLI path against a generated directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-k8s-cli-check-"))
    await CloudDeployment.writeKubernetesFiles({
      directory,
      environment: "staging",
      namespace: "cloud-runtime-staging",
      image: "registry.example.com/cloud-runtime-api:1.0.0",
      runtimeDefaultVersion: "1.14.28",
      authMode: "internal_jwt",
      databaseURLSecretRef: "cloud-runtime-db",
      objectStorageBucket: "runtime-artifacts",
      queueName: "cloud-runtime-jobs",
      autoscale: { minWorkers: 1, maxWorkers: 5, jobsPerWorker: 3 },
    })

    const result = await CloudDeployment.checkCLI({ directory })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime Kubernetes check: passed")
    expect(result.output).toContain("[passed] worker-hpa")
  })

  test("exposes a package script for Kubernetes deployment preflight checks", () => {
    expect(packageJSON.scripts["cloud:k8s:check"]).toBe("bun run ./src/cloud/deployment.ts --check")
  })
})
