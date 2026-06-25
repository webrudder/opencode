import { CloudAPIMount } from "./api-mount"
import { CloudAutoscale } from "./autoscale"
import path from "path"

type Environment = "dev" | "staging" | "production"

function replicas(input: { environment: Environment; minWorkers: number }) {
  if (input.environment === "production") return { api: 3, orchestrator: 2, worker: Math.max(2, input.minWorkers) }
  if (input.environment === "staging") return { api: 2, orchestrator: 1, worker: Math.max(1, input.minWorkers) }
  return { api: 1, orchestrator: 1, worker: input.minWorkers }
}

export function plan(input: {
  environment: Environment
  namespace: string
  image: string
  imageDigest?: string
  runtimeDefaultVersion: string
  apiBasePath?: string
  authMode: "api_key" | "internal_jwt" | "none"
  corsOrigins?: string[]
  databaseURLSecretRef: string
  objectStorageBucket: string
  queueName: string
  otelEndpoint?: string
  autoscale: {
    minWorkers: number
    maxWorkers: number
    jobsPerWorker: number
  }
}) {
  const count = replicas({ environment: input.environment, minWorkers: input.autoscale.minWorkers })
  const commonEnv = {
    CLOUD_RUNTIME_ENVIRONMENT: input.environment,
    CLOUD_RUNTIME_NAMESPACE: input.namespace,
    CLOUD_RUNTIME_DEFAULT_VERSION: input.runtimeDefaultVersion,
    CLOUD_RUNTIME_OBJECT_BUCKET: input.objectStorageBucket,
    CLOUD_RUNTIME_QUEUE: input.queueName,
    ...(input.otelEndpoint ? { OTEL_EXPORTER_OTLP_ENDPOINT: input.otelEndpoint } : {}),
  }

  return {
    environment: input.environment,
    namespace: input.namespace,
    image: input.imageDigest ? `${input.image}@${input.imageDigest}` : input.image,
    api: {
      replicas: count.api,
      mount: CloudAPIMount.plan({
        basePath: input.apiBasePath,
        authMode: input.authMode,
        corsOrigins: input.corsOrigins,
        exposeHealth: true,
        exposeOpenAPI: input.environment !== "production",
      }),
      env: {
        ...commonEnv,
        CLOUD_RUNTIME_DATABASE_URL_SECRET: input.databaseURLSecretRef,
      },
    },
    orchestrator: {
      replicas: count.orchestrator,
      env: {
        ...commonEnv,
        CLOUD_RUNTIME_DATABASE_URL_SECRET: input.databaseURLSecretRef,
      },
    },
    worker: {
      replicas: count.worker,
      autoscale: {
        min: input.autoscale.minWorkers,
        max: input.autoscale.maxWorkers,
        jobsPerWorker: input.autoscale.jobsPerWorker,
        targetOldestQueuedAgeMS: 30_000,
        scaleUpStep: Math.max(1, Math.ceil(input.autoscale.maxWorkers / 5)),
        scaleDownStep: 1,
        maxResourcePressure: 0.9,
      },
      env: {
        ...commonEnv,
        CLOUD_RUNTIME_DATABASE_URL_SECRET: input.databaseURLSecretRef,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
      },
    },
    dependencies: {
      database: { secretRef: input.databaseURLSecretRef },
      objectStorage: { bucket: input.objectStorageBucket },
      queue: { name: input.queueName },
      sandboxNamespace: input.namespace,
    },
  }
}

export function scaleDecision(input: {
  deployment: ReturnType<typeof plan>
  queue: { depth: number; oldestQueuedAgeMS: number }
  workers: { current: number; busy: number }
  resources?: { cpuPressure?: number; memoryPressure?: number }
}) {
  return CloudAutoscale.decide({
    queue: input.queue,
    workers: input.workers,
    resources: input.resources,
    policy: input.deployment.worker.autoscale,
  })
}

function labels(input: { component: string }) {
  return {
    "app.kubernetes.io/name": "cloud-opencode-runtime",
    "app.kubernetes.io/component": input.component,
  }
}

function env(input: Record<string, string>) {
  return Object.entries(input)
    .filter(([key]) => key !== "CLOUD_RUNTIME_DATABASE_URL_SECRET")
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({
      name: key,
      value,
    }))
}

function envWithDatabase(input: { env: Record<string, string>; secretRef: string }) {
  return [
    ...env(input.env),
    {
      name: "CLOUD_RUNTIME_DATABASE_URL",
      valueFrom: {
        secretKeyRef: {
          name: input.secretRef,
          key: "url",
        },
      },
    },
  ].toSorted((left, right) => left.name.localeCompare(right.name))
}

function deployment(input: {
  namespace: string
  name: string
  component: string
  replicas: number
  image: string
  command: string[]
  env: Record<string, string>
  databaseURLSecretRef: string
  port?: number
}) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: labels({ component: input.component }),
    },
    spec: {
      replicas: input.replicas,
      selector: {
        matchLabels: labels({ component: input.component }),
      },
      template: {
        metadata: {
          labels: labels({ component: input.component }),
        },
        spec: {
          containers: [
            {
              name: input.component,
              image: input.image,
              command: input.command,
              ...(input.port ? { ports: [{ containerPort: input.port }] } : {}),
              env: envWithDatabase({
                env: input.env,
                secretRef: input.databaseURLSecretRef,
              }),
              securityContext: {
                allowPrivilegeEscalation: false,
                runAsNonRoot: true,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
        },
      },
    },
  }
}

export function kubernetesManifests(input: ReturnType<typeof plan>) {
  return [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: input.namespace,
      },
    },
    deployment({
      namespace: input.namespace,
      name: "cloud-runtime-api",
      component: "api",
      replicas: input.api.replicas,
      image: input.image,
      command: ["bun", "run", "./src/cloud/postgres-server.ts"],
      env: input.api.env,
      databaseURLSecretRef: input.dependencies.database.secretRef,
      port: 8787,
    }),
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: "cloud-runtime-api",
        namespace: input.namespace,
        labels: labels({ component: "api" }),
      },
      spec: {
        selector: labels({ component: "api" }),
        ports: [
          {
            name: "http",
            port: 80,
            targetPort: 8787,
          },
        ],
      },
    },
    deployment({
      namespace: input.namespace,
      name: "cloud-runtime-worker",
      component: "worker",
      replicas: input.worker.replicas,
      image: input.image,
      command: ["bun", "run", "./src/cloud/local-worker.ts"],
      env: input.worker.env,
      databaseURLSecretRef: input.dependencies.database.secretRef,
    }),
    {
      apiVersion: "autoscaling/v2",
      kind: "HorizontalPodAutoscaler",
      metadata: {
        name: "cloud-runtime-worker",
        namespace: input.namespace,
        labels: labels({ component: "worker" }),
      },
      spec: {
        scaleTargetRef: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: "cloud-runtime-worker",
        },
        minReplicas: input.worker.autoscale.min,
        maxReplicas: input.worker.autoscale.max,
        metrics: [
          {
            type: "Resource",
            resource: {
              name: "cpu",
              target: {
                type: "Utilization",
                averageUtilization: 70,
              },
            },
          },
        ],
      },
    },
  ]
}

function scalar(input: unknown) {
  if (typeof input === "number" || typeof input === "boolean") return `${input}`
  if (typeof input === "string" && /^[a-zA-Z0-9_./:@-]+$/.test(input)) return input
  return JSON.stringify(input)
}

function yaml(input: unknown, indent = 0): string {
  const space = " ".repeat(indent)
  if (Array.isArray(input)) {
    return input.map((item) => (typeof item === "object" && item !== null ? `${space}-\n${yaml(item, indent + 2)}` : `${space}- ${scalar(item)}`)).join("\n")
  }
  if (typeof input === "object" && input !== null) {
    return Object.entries(input)
      .map(([key, value]) => {
        if (typeof value === "object" && value !== null) return `${space}${key}:\n${yaml(value, indent + 2)}`
        return `${space}${key}: ${scalar(value)}`
      })
      .join("\n")
  }
  return `${space}${scalar(input)}`
}

export function kubernetesYAML(input: ReturnType<typeof plan>) {
  return `${kubernetesManifests(input).map((item) => yaml(item)).join("\n---\n")}\n`
}

function number(input: string | undefined, fallback: number) {
  const result = Number(input)
  if (Number.isFinite(result) && result >= 0) return result
  return fallback
}

function environment(input: string | undefined): Environment {
  if (input === "production" || input === "staging" || input === "dev") return input
  return "production"
}

function authMode(input: string | undefined): "api_key" | "internal_jwt" | "none" {
  if (input === "api_key" || input === "internal_jwt" || input === "none") return input
  return "api_key"
}

function readme(input: ReturnType<typeof plan>) {
  return [
    "# Cloud OpenCode Runtime Kubernetes",
    "",
    `Namespace: ${input.namespace}`,
    `Image: ${input.image}`,
    `Runtime default version: ${input.worker.env.CLOUD_RUNTIME_DEFAULT_VERSION}`,
    "",
    "Apply the manifests:",
    "",
    "    kubectl apply -f cloud-runtime.k8s.yaml",
    "",
    "Check rollout status:",
    "",
    "    kubectl -n " + input.namespace + " rollout status deployment/cloud-runtime-api",
    "    kubectl -n " + input.namespace + " rollout status deployment/cloud-runtime-worker",
    "",
    "Required secret:",
    "",
    `    kubectl -n ${input.namespace} create secret generic ${input.dependencies.database.secretRef} --from-literal=url='postgres://...'`,
    "",
  ].join("\n")
}

function check(input: { name: string; passed: boolean; detail: string }) {
  return {
    name: input.name,
    status: input.passed ? "passed" as const : "failed" as const,
    detail: input.detail,
  }
}

export async function writeKubernetesFiles(input: Parameters<typeof plan>[0] & { directory: string }) {
  const deployment = plan(input)
  await Bun.write(path.join(input.directory, "cloud-runtime.k8s.yaml"), kubernetesYAML(deployment))
  await Bun.write(path.join(input.directory, "README.md"), readme(deployment))
  return {
    directory: input.directory,
    files: ["cloud-runtime.k8s.yaml", "README.md"].map((name) => path.join(input.directory, name)),
    summary: [
      `Wrote Cloud Runtime Kubernetes files to ${input.directory}`,
      `Apply: kubectl apply -f ${path.join(input.directory, "cloud-runtime.k8s.yaml")}`,
      `Namespace: ${deployment.namespace}`,
      `Image: ${deployment.image}`,
    ].join("\n"),
  }
}

export function checkKubernetesYAML(input: string) {
  const checks = [
    check({
      name: "manifest-file",
      passed: input.trim().length > 0,
      detail: "cloud-runtime.k8s.yaml is present and non-empty",
    }),
    check({
      name: "api-deployment",
      passed: input.includes("kind: Deployment") && input.includes("name: cloud-runtime-api"),
      detail: "API Deployment cloud-runtime-api exists",
    }),
    check({
      name: "worker-deployment",
      passed: input.includes("kind: Deployment") && input.includes("name: cloud-runtime-worker"),
      detail: "Worker Deployment cloud-runtime-worker exists",
    }),
    check({
      name: "database-secret-ref",
      passed: input.includes("name: CLOUD_RUNTIME_DATABASE_URL") && input.includes("secretKeyRef:") && input.includes("key: url"),
      detail: "database URL is sourced from a Kubernetes Secret key named url",
    }),
    check({
      name: "object-storage-env",
      passed: input.includes("name: CLOUD_RUNTIME_OBJECT_BUCKET"),
      detail: "object storage bucket environment variable is configured",
    }),
    check({
      name: "queue-env",
      passed: input.includes("name: CLOUD_RUNTIME_QUEUE"),
      detail: "queue environment variable is configured",
    }),
    check({
      name: "worker-autoupdate-disabled",
      passed: input.includes("name: OPENCODE_DISABLE_AUTOUPDATE") && input.includes("value: true"),
      detail: "worker disables opencode autoupdate",
    }),
    check({
      name: "worker-hpa",
      passed: input.includes("kind: HorizontalPodAutoscaler") && input.includes("name: cloud-runtime-worker"),
      detail: "worker HorizontalPodAutoscaler exists",
    }),
    check({
      name: "api-service",
      passed: input.includes("kind: Service") && input.includes("name: cloud-runtime-api") && input.includes("targetPort: 8787"),
      detail: "API Service exposes the API container port",
    }),
  ]
  return {
    ok: checks.every((item) => item.status === "passed"),
    checks,
  }
}

export async function checkKubernetesDirectory(input: { directory: string }) {
  if (!(await Bun.file(path.join(input.directory, "cloud-runtime.k8s.yaml")).exists())) {
    return {
      ok: false,
      checks: [
        check({
          name: "manifest-file",
          passed: false,
          detail: `missing ${path.join(input.directory, "cloud-runtime.k8s.yaml")}`,
        }),
      ],
    }
  }
  return checkKubernetesYAML(await Bun.file(path.join(input.directory, "cloud-runtime.k8s.yaml")).text())
}

export function checkSummary(input: ReturnType<typeof checkKubernetesYAML>) {
  return [
    `Cloud Runtime Kubernetes check: ${input.ok ? "passed" : "failed"}`,
    ...input.checks.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
  ].join("\n")
}

export async function checkCLI(input: { directory: string }) {
  const result = await checkKubernetesDirectory(input)
  return {
    exitCode: result.ok ? 0 : 1,
    output: checkSummary(result),
  }
}

export function cliConfig(input?: {
  argv?: string[]
  env?: Record<string, string | undefined>
}) {
  const env = input?.env ?? Bun.env
  return {
    directory: input?.argv?.slice(2).find((item) => !item.startsWith("--")) ?? env.CLOUD_RUNTIME_K8S_DIR ?? ".cloud-runtime-k8s",
    environment: environment(env.CLOUD_RUNTIME_ENVIRONMENT),
    namespace: env.CLOUD_RUNTIME_NAMESPACE ?? "cloud-runtime",
    image: env.CLOUD_RUNTIME_IMAGE ?? "cloud-runtime-api:dev",
    ...(env.CLOUD_RUNTIME_IMAGE_DIGEST ? { imageDigest: env.CLOUD_RUNTIME_IMAGE_DIGEST } : {}),
    runtimeDefaultVersion: env.CLOUD_RUNTIME_DEFAULT_VERSION ?? "1.14.28",
    authMode: authMode(env.CLOUD_RUNTIME_AUTH_MODE),
    databaseURLSecretRef: env.CLOUD_RUNTIME_DATABASE_URL_SECRET ?? "cloud-runtime-db",
    objectStorageBucket: env.CLOUD_RUNTIME_OBJECT_BUCKET ?? "runtime-artifacts",
    queueName: env.CLOUD_RUNTIME_QUEUE ?? "cloud-runtime-jobs",
    autoscale: {
      minWorkers: number(env.CLOUD_RUNTIME_AUTOSCALE_MIN_WORKERS, 2),
      maxWorkers: number(env.CLOUD_RUNTIME_AUTOSCALE_MAX_WORKERS, 20),
      jobsPerWorker: number(env.CLOUD_RUNTIME_AUTOSCALE_JOBS_PER_WORKER, 5),
    },
  }
}

function cliMode(input?: { argv?: string[] }) {
  if (input?.argv?.includes("--check")) return "check"
  return "write"
}

if (import.meta.main) {
  if (cliMode({ argv: Bun.argv }) === "check") {
    const result = await checkCLI({ directory: cliConfig({ argv: Bun.argv, env: Bun.env }).directory })
    console.log(result.output)
    process.exit(result.exitCode)
  }
  const result = await writeKubernetesFiles(cliConfig({ argv: Bun.argv, env: Bun.env }))
  console.log(result.summary)
}

export * as CloudDeployment from "./deployment"
