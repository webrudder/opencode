import path from "path"

type ComposeInput = Parameters<typeof compose>[0]
type ExecutionMode = NonNullable<ComposeInput>["workerExecutionMode"]
type ImageProfile = "default" | "production-install"
type RuntimeCapabilityProfile = "minimal" | "standard" | "heavy"
type ServiceRole = "api" | "worker"

function databaseURL(input: { user: string; password: string; database: string }) {
  return `postgres://${input.user}:${input.password}@postgres:5432/${input.database}`
}

function number(input: string | undefined) {
  const result = Number(input)
  if (Number.isFinite(result) && result >= 0) return result
  return undefined
}

const DefaultModelEnvKeys = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "CEREBRAS_API_KEY",
  "COHERE_API_KEY",
]
const SmokeBYOKSecretEnv = "CLOUD_RUNTIME_MODEL_SECRET_TENANT_LOCAL_DOCKER_SMOKE_DOCKER_SMOKE_ANTHROPIC"

function envKey(input: string) {
  return /^[A-Z][A-Z0-9_]*$/.test(input)
}

function modelEnvKeys(input?: string[] | string) {
  const extra = Array.isArray(input) ? input : (input ?? "").split(",")
  return Array.from(new Set([...DefaultModelEnvKeys, ...extra.map((item) => item.trim()).filter(envKey)]))
}

function modelEnvironment(input?: { modelEnvKeys?: string[] }) {
  return {
    CLOUD_RUNTIME_MODEL_PROVIDER: "${CLOUD_RUNTIME_MODEL_PROVIDER:-}",
    CLOUD_RUNTIME_MODEL: "${CLOUD_RUNTIME_MODEL:-}",
    CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE: "${CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE:-}",
    CLOUD_RUNTIME_SMOKE_BYOK: "${CLOUD_RUNTIME_SMOKE_BYOK:-}",
    [SmokeBYOKSecretEnv]: "${CLOUD_RUNTIME_SMOKE_BYOK_SECRET:-modeless-smoke-key}",
    ...Object.fromEntries(modelEnvKeys(input?.modelEnvKeys).map((key) => [key, `\${${key}:-}`])),
  }
}

function imageProfile(input?: ImageProfile) {
  return input ?? "default"
}

function runtimeCapabilityProfile(input?: RuntimeCapabilityProfile) {
  return input ?? "standard"
}

function productionImage(input?: ImageProfile) {
  return imageProfile(input) === "production-install"
}

function apiCommand(input?: { imageProfile?: ImageProfile }) {
  if (productionImage(input?.imageProfile)) return "bun ./dist/local-api.js"
  return "bun run ./src/cloud/local-api.ts"
}

function workerCommand(input?: { imageProfile?: ImageProfile; storageBackend?: "sqlite" | "postgres" }) {
  if (productionImage(input?.imageProfile)) {
    if (input?.storageBackend === "postgres") return "bun ./dist/postgres-worker.js"
    return "bun ./dist/local-worker.js"
  }
  if (input?.storageBackend === "postgres") return "bun run ./src/cloud/postgres-worker.ts"
  return "bun run ./src/cloud/local-worker.ts"
}

function runtimeWorkerCommand(input?: { imageProfile?: ImageProfile }) {
  if (productionImage(input?.imageProfile)) return "bun ./dist/runtime-worker-server.js"
  return "bun run ./src/cloud/runtime-worker-server.ts"
}

function cmd(input: string) {
  return `CMD [${input.split(" ").map((item) => JSON.stringify(item)).join(", ")}]`
}

function runtimeImageTag(input?: { imageProfile?: ImageProfile; runtimeCapabilityProfile?: RuntimeCapabilityProfile }) {
  if (productionImage(input?.imageProfile)) return `1.14.28-${runtimeCapabilityProfile(input?.runtimeCapabilityProfile)}-production-install`
  return runtimeCapabilityProfile(input?.runtimeCapabilityProfile) === "standard"
    ? "1.14.28"
    : `1.14.28-${runtimeCapabilityProfile(input?.runtimeCapabilityProfile)}`
}

function imageNames(input?: { imageProfile?: ImageProfile; runtimeCapabilityProfile?: RuntimeCapabilityProfile }) {
  if (productionImage(input?.imageProfile)) {
    return {
      api: "cloud-runtime-api:production-install",
      worker: "cloud-runtime-worker:production-install",
      runtime: `cloud-runtime-opencode:${runtimeImageTag(input)}`,
    }
  }
  return {
    api: "cloud-runtime-api:dev",
    worker: "cloud-runtime-worker:dev",
    runtime: `cloud-runtime-opencode:${runtimeImageTag(input)}`,
  }
}

export function compose(input?: {
  apiImage?: string
  workerImage?: string
  runtimeImage?: string
  imageProfile?: ImageProfile
  runtimeCapabilityProfile?: RuntimeCapabilityProfile
  postgresPassword?: string
  minioRootPassword?: string
  storageBackend?: "sqlite" | "postgres"
  workerExecutionMode?: "lease" | "simulate" | "opencode" | "kubernetes" | "shared-session"
  modelEnvKeys?: string[]
  workerKubernetes?: {
    serverURL: string
    token?: string
    pollIntervalMS?: number
    maxPolls?: number
  }
  workerExecutionTimeoutMS?: number
  workerSessionCacheTTLMS?: number
  workerRetry?: {
    maxAttempts: number
    baseDelayMS: number
    maxDelayMS: number
  }
  otelEndpoint?: string
  otelHeaders?: string
}) {
  const postgres = {
    user: "opencode",
    password: input?.postgresPassword ?? "opencode",
    database: "cloud_runtime",
  }
  const storageBackend = input?.storageBackend ?? "sqlite"
  const workerExecutionMode = input?.workerExecutionMode ?? "shared-session"
  const sharedRuntimeWorker = storageBackend === "postgres" && workerExecutionMode === "shared-session"
  const images = imageNames({
    imageProfile: input?.imageProfile,
    runtimeCapabilityProfile: input?.runtimeCapabilityProfile,
  })
  const modelEnv = modelEnvironment(input)
  const common = {
    CLOUD_RUNTIME_ENVIRONMENT: "dev",
    CLOUD_RUNTIME_DATABASE_URL: databaseURL(postgres),
    CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
    CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
    CLOUD_RUNTIME_DEFAULT_VERSION: "1.14.28",
    CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://minio:9000",
    CLOUD_RUNTIME_OBJECT_REGION: "us-east-1",
    CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID: "opencode",
    CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY: input?.minioRootPassword ?? "opencode-password",
    CLOUD_RUNTIME_REDIS_URL: "redis://redis:6379/0",
    CLOUD_RUNTIME_SKILL_CATALOG_JSON: "${CLOUD_RUNTIME_SKILL_CATALOG_JSON:-}",
    CLOUD_RUNTIME_ALLOWED_SKILLS: "${CLOUD_RUNTIME_ALLOWED_SKILLS:-}",
    ...(storageBackend === "sqlite" ? { CLOUD_RUNTIME_SQLITE_PATH: "/data/cloud-runtime.sqlite" } : {}),
    ...(input?.otelEndpoint ? { OTEL_EXPORTER_OTLP_ENDPOINT: input.otelEndpoint } : {}),
    ...(input?.otelHeaders ? { OTEL_EXPORTER_OTLP_HEADERS: input.otelHeaders } : {}),
  }

  return {
    services: {
      postgres: {
        image: "postgres:16-alpine",
        ports: ["${CLOUD_RUNTIME_POSTGRES_PORT:-55432}:5432"],
        environment: {
          POSTGRES_USER: postgres.user,
          POSTGRES_PASSWORD: postgres.password,
          POSTGRES_DB: postgres.database,
        },
        volumes: ["cloud-postgres:/var/lib/postgresql/data"],
        healthcheck: {
          test: ["CMD-SHELL", `pg_isready -U ${postgres.user} -d ${postgres.database}`],
          interval: "2s",
          timeout: "2s",
          retries: 30,
        },
      },
      minio: {
        image: "minio/minio:latest",
        command: "server /data --console-address :9001",
        ports: ["9000:9000", "9001:9001"],
        environment: {
          MINIO_ROOT_USER: "opencode",
          MINIO_ROOT_PASSWORD: input?.minioRootPassword ?? "opencode-password",
        },
        volumes: ["cloud-minio:/data"],
      },
      "minio-init": {
        image: "minio/mc:latest",
        entrypoint: ["/bin/sh", "-c"],
        command: [
          `until mc alias set local http://minio:9000 opencode ${input?.minioRootPassword ?? "opencode-password"}; do sleep 1; done; mc mb --ignore-existing local/runtime-artifacts`,
        ],
        depends_on: ["minio"],
      },
      redis: {
        image: "redis:7-alpine",
        ports: ["6379:6379"],
      },
      api: {
        image: input?.apiImage ?? images.api,
        command: apiCommand(input),
        ports: ["8787:8787"],
        environment: {
          ...common,
          CLOUD_RUNTIME_HTTP_PORT: "8787",
          CLOUD_RUNTIME_STORAGE: storageBackend,
          OTEL_SERVICE_NAME: "cloud-opencode-runtime-api",
        },
        ...(storageBackend === "sqlite" ? { volumes: ["cloud-runtime-db:/data"] } : {}),
        depends_on: {
          postgres: { condition: "service_healthy" },
          minio: { condition: "service_started" },
          "minio-init": { condition: "service_completed_successfully" },
          redis: { condition: "service_started" },
        },
      },
      worker: {
        image: input?.workerImage ?? images.worker,
        command: workerCommand({ imageProfile: input?.imageProfile, storageBackend }),
        environment: {
          ...common,
          ...modelEnv,
          CLOUD_RUNTIME_WORKER_ID: "local-worker-1",
          CLOUD_RUNTIME_SANDBOX_MODE: "docker",
          CLOUD_RUNTIME_SANDBOX_IMAGE: input?.runtimeImage ?? images.runtime,
          OTEL_SERVICE_NAME: "cloud-opencode-runtime-worker",
          ...(workerExecutionMode !== "lease"
            ? { CLOUD_RUNTIME_EXECUTION_MODE: workerExecutionMode }
            : {}),
          ...(input?.workerKubernetes
            ? {
                CLOUD_RUNTIME_K8S_SERVER_URL: input.workerKubernetes.serverURL,
                ...(input.workerKubernetes.token ? { CLOUD_RUNTIME_K8S_TOKEN: input.workerKubernetes.token } : {}),
                ...(input.workerKubernetes.pollIntervalMS
                  ? { CLOUD_RUNTIME_K8S_POLL_INTERVAL_MS: `${input.workerKubernetes.pollIntervalMS}` }
                  : {}),
                ...(input.workerKubernetes.maxPolls ? { CLOUD_RUNTIME_K8S_MAX_POLLS: `${input.workerKubernetes.maxPolls}` } : {}),
              }
            : {}),
          ...(input?.workerExecutionTimeoutMS
            ? { CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: `${input.workerExecutionTimeoutMS}` }
            : {}),
          ...(input?.workerSessionCacheTTLMS
            ? { CLOUD_RUNTIME_SESSION_CACHE_TTL_MS: `${input.workerSessionCacheTTLMS}` }
            : {}),
          ...(input?.workerRetry
            ? {
                CLOUD_RUNTIME_RETRY_MAX_ATTEMPTS: `${input.workerRetry.maxAttempts}`,
                CLOUD_RUNTIME_RETRY_BASE_DELAY_MS: `${input.workerRetry.baseDelayMS}`,
                CLOUD_RUNTIME_RETRY_MAX_DELAY_MS: `${input.workerRetry.maxDelayMS}`,
              }
            : {}),
          OPENCODE_DISABLE_AUTOUPDATE: "true",
        },
        volumes: [
          "/var/run/docker.sock:/var/run/docker.sock",
          "cloud-worker-cache:/tmp/cloud-runtime",
          "${CLOUD_RUNTIME_SKILLS_DIR:-./skills}:/runtime/skills:ro",
          ...(storageBackend === "sqlite" ? ["cloud-runtime-db:/data"] : []),
        ],
        depends_on: {
          postgres: { condition: "service_healthy" },
          minio: { condition: "service_started" },
          "minio-init": { condition: "service_completed_successfully" },
          redis: { condition: "service_started" },
          ...(sharedRuntimeWorker ? { "runtime-worker": { condition: "service_started" } } : {}),
        },
      },
      ...(sharedRuntimeWorker
        ? {
            "runtime-worker": {
              image: input?.workerImage ?? images.worker,
              command: runtimeWorkerCommand(input),
              ports: ["8788:8788"],
              environment: {
                ...common,
                ...modelEnv,
                CLOUD_RUNTIME_ID: "runtime-local-1",
                CLOUD_RUNTIME_TENANT_ID: "tenant_local",
                CLOUD_RUNTIME_ENDPOINT: "http://runtime-worker:8788",
                CLOUD_RUNTIME_WORKER_PORT: "8788",
                CLOUD_RUNTIME_VERSION: "1.14.28",
                CLOUD_RUNTIME_PROFILE: "standard",
                CLOUD_RUNTIME_MAX_ACTIVE_JOBS: "4",
                CLOUD_RUNTIME_MAX_SESSIONS: "20",
                OPENCODE_DISABLE_AUTOUPDATE: "true",
                OTEL_SERVICE_NAME: "cloud-opencode-runtime-session-worker",
              },
              volumes: ["cloud-worker-cache:/tmp/cloud-runtime", "${CLOUD_RUNTIME_SKILLS_DIR:-./skills}:/runtime/skills:ro"],
              depends_on: {
                postgres: { condition: "service_healthy" },
                minio: { condition: "service_started" },
                "minio-init": { condition: "service_completed_successfully" },
              },
            },
          }
        : {}),
    },
    volumes: {
      "cloud-postgres": {},
      "cloud-minio": {},
      "cloud-worker-cache": {},
      ...(storageBackend === "sqlite" ? { "cloud-runtime-db": {} } : {}),
    },
  }
}

export function startupOrder(input: ReturnType<typeof compose>) {
  return ["postgres", "minio", "minio-init", "redis", "runtime-worker", "api", "worker"].filter((name) => input.services[name as keyof typeof input.services])
}

export function envFile(input?: Parameters<typeof compose>[0] & {
  target?: "api" | "worker"
}) {
  const result = compose(input)
  return Object.entries(result.services[input?.target ?? "api"].environment)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
}

export function composeJSON(input?: Parameters<typeof compose>[0]) {
  return `${JSON.stringify(compose(input), undefined, 2)}\n`
}

function scalar(input: unknown) {
  if (typeof input === "number" || typeof input === "boolean") return `${input}`
  if (typeof input === "string" && /^-?\d+(\.\d+)?$/.test(input)) return JSON.stringify(input)
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

export function composeYAML(input?: Parameters<typeof compose>[0]) {
  return `${yaml(compose(input))}\n`
}

export function runtimeProfile(input?: Parameters<typeof compose>[0]) {
  const storageBackend = input?.storageBackend ?? "sqlite"
  const workerExecutionMode = input?.workerExecutionMode ?? "shared-session"
  return {
    imageProfile: imageProfile(input?.imageProfile),
    runtimeCapabilityProfile: runtimeCapabilityProfile(input?.runtimeCapabilityProfile),
    storageBackend,
    workerExecutionMode,
    artifactStorage: "minio",
    objectEndpoint: "http://minio:9000",
    objectBucket: "runtime-artifacts",
    runtimeImage: input?.runtimeImage ?? imageNames({
      imageProfile: input?.imageProfile,
      runtimeCapabilityProfile: input?.runtimeCapabilityProfile,
    }).runtime,
    apiCommand: apiCommand(input),
    workerCommand: workerCommand({ imageProfile: input?.imageProfile, storageBackend }),
    modelEnvKeys: modelEnvKeys(input?.modelEnvKeys),
  }
}

function commandsForProfile(input: ReturnType<typeof runtimeProfile>) {
  return commands({
    includeRuntimeWorker: input.storageBackend === "postgres" && input.workerExecutionMode === "shared-session",
    imageProfile: input.imageProfile,
    runtimeCapabilityProfile: input.runtimeCapabilityProfile,
  })
}

function commandsForFiles(input: ReturnType<typeof files>) {
  try {
    return commandsForProfile(JSON.parse(input["runtime-profile.json"]) as ReturnType<typeof runtimeProfile>)
  } catch {
    return commands()
  }
}

async function directoryCommands(input: { directory: string }) {
  return commandsForFiles({
    ...files(),
    "runtime-profile.json": await Bun.file(path.join(input.directory, "runtime-profile.json")).text(),
  })
}

function archiveName(input: string) {
  return `${input.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.tar`
}

export function commands(input?: {
  includeRuntimeWorker?: boolean
  imageProfile?: ImageProfile
  runtimeCapabilityProfile?: RuntimeCapabilityProfile
}) {
  const images = imageNames({
    imageProfile: input?.imageProfile,
    runtimeCapabilityProfile: input?.runtimeCapabilityProfile,
  })
  return {
    buildAPI: `docker build -f Dockerfile.cloud-api -t ${images.api} ../../..`,
    buildWorker: `docker build -f Dockerfile.cloud-worker -t ${images.worker} ../../..`,
    buildRuntime: `docker build -f Dockerfile.cloud-opencode-runtime -t ${images.runtime} ../../..`,
    up: "docker compose --env-file api.env --env-file worker.env up -d",
    down: "docker compose down -v",
    logs: input?.includeRuntimeWorker ? "docker compose logs -f api worker runtime-worker" : "docker compose logs -f api worker",
    inspectImages: `docker image inspect ${images.api} ${images.worker} ${images.runtime}`,
    saveImages: `mkdir -p image-archive && docker save ${images.api} ${images.worker} ${images.runtime} -o image-archive/cloud-runtime-images.tar`,
    loadImages: "docker load -i image-archive/cloud-runtime-images.tar",
    bundle: "tar -czf cloud-runtime-compose-bundle.tgz docker-compose.yml api.env worker.env runtime-profile.json smoke-api-workflow.ts REMOTE_DOCKER.md image-archive",
    saveImageArchives: [
      `docker save ${images.api} -o image-archive/${archiveName(images.api)}`,
      `docker save ${images.worker} -o image-archive/${archiveName(images.worker)}`,
      `docker save ${images.runtime} -o image-archive/${archiveName(images.runtime)}`,
    ],
  }
}

function diagnosticLogs(input: string) {
  return input.replace("logs -f", "logs --tail=240")
}

function dependencyLayer() {
  return [
    "COPY --chown=bun:bun . .",
    "RUN bun -e 'for (const file of [\"package.json\", \"packages/opencode/package.json\"]) { const pkg = await Bun.file(file).json(); if (pkg.scripts) { delete pkg.scripts.prepare; delete pkg.scripts.postinstall } await Bun.write(file, JSON.stringify(pkg, undefined, 2)) }'",
    "RUN test -d node_modules && test -d packages/opencode/node_modules",
  ]
}

function productionInstallLayer() {
  return [
    "COPY --chown=bun:bun . .",
    "RUN bun -e 'for (const file of [\"package.json\", \"packages/opencode/package.json\"]) { const pkg = await Bun.file(file).json(); if (pkg.scripts) { delete pkg.scripts.prepare; delete pkg.scripts.postinstall } await Bun.write(file, JSON.stringify(pkg, undefined, 2)) }'",
    "RUN bun -e 'const pkg = await Bun.file(\"packages/opencode/package.json\").json(); pkg.dependencies = { ...(pkg.dependencies ?? {}), \"@opencode-ai/core\": \"workspace:*\" }; await Bun.write(\"packages/opencode/package.json\", JSON.stringify(pkg, undefined, 2))'",
    "RUN bun -e 'const pkg = await Bun.file(\"package.json\").json(); pkg.workspaces = { ...(pkg.workspaces ?? {}), packages: [\"packages/core\", \"packages/opencode\", \"packages/plugin\", \"packages/script\", \"packages/sdk/js\"] }; await Bun.write(\"package.json\", JSON.stringify(pkg, undefined, 2))'",
    "RUN rm -f /app/bun.lock /app/bun.lockb",
    "RUN rm -rf /app/node_modules /app/packages/opencode/node_modules",
    ...workspacePruneLayer(),
  ]
}

function workspacePruneLayer() {
  return [
    "RUN rm -rf \\",
    "  /app/packages/app \\",
    "  /app/packages/console \\",
    "  /app/packages/desktop \\",
    "  /app/packages/desktop-electron \\",
    "  /app/packages/docs \\",
    "  /app/packages/enterprise \\",
    "  /app/packages/extensions \\",
    "  /app/packages/function \\",
    "  /app/packages/identity \\",
    "  /app/packages/slack \\",
    "  /app/packages/storybook \\",
    "  /app/packages/ui \\",
    "  /app/packages/web",
  ]
}

function pruneLayer() {
  return [
    "RUN rm -rf \\",
    "  /app/.bun \\",
    "  /app/.cloud-runtime* \\",
    "  /app/.next \\",
    "  /app/.turbo \\",
    "  /app/coverage \\",
    "  /app/node_modules/.cache \\",
    "  /app/node_modules/.turbo \\",
    "  /app/node_modules/.vite \\",
    "  /app/packages/opencode/.next \\",
    "  /app/packages/opencode/.turbo \\",
    "  /app/packages/opencode/coverage \\",
    "  /app/packages/opencode/node_modules/.cache \\",
    "  /app/packages/opencode/node_modules/.turbo \\",
    "  /app/packages/opencode/node_modules/.vite \\",
    "  /app/packages/opencode/specs \\",
    "  /app/packages/opencode/test",
  ]
}

function productionDependencyPruneLayer() {
  return [
    "RUN for dir in /app/node_modules/.bun /app/node_modules; do if [ -d \"$dir\" ]; then find \"$dir\" -type f \\( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' -o -name '*.md' -o -name '*.markdown' \\) -delete; fi; done",
    "RUN for dir in /app/node_modules/.bun /app/node_modules; do if [ -d \"$dir\" ]; then find \"$dir\" -type d \\( -name test -o -name tests -o -name __tests__ -o -name docs -o -name examples -o -name example -o -name benchmark -o -name benchmarks \\) -prune -exec rm -rf {} +; fi; done",
  ]
}

function workspaceDependencyLinkLayer() {
  return [
    "RUN bun -e 'import path from \"path\"; const workspaces = [\"packages/core\", \"packages/plugin\", \"packages/script\", \"packages/sdk/js\"]; const entries = Array.from(new Bun.Glob(\"*\").scanSync({ cwd: \"node_modules/.bun\", onlyFiles: false })); for (const workspace of workspaces) { const pkg = await Bun.file(`${workspace}/package.json`).json(); for (const dep of Object.keys(pkg.dependencies ?? {})) { if (dep.startsWith(\"@opencode-ai/\")) continue; const prefix = dep === \"zod\" ? \"zod@4.\" : `${dep.replace(\"/\", \"+\")}@`; const match = entries.find((entry) => entry.startsWith(prefix)); if (!match) continue; const target = `/app/node_modules/.bun/${match}/node_modules/${dep}`; const link = `/app/${workspace}/node_modules/${dep}`; await Bun.$`mkdir -p ${path.dirname(link)}`; await Bun.$`ln -sfn ${target} ${link}`; } }'",
  ]
}

function workspaceRuntimeLinkLayer() {
  return [
    "RUN mkdir -p /app/node_modules/@opencode-ai && ln -sfn ../../packages/core /app/node_modules/@opencode-ai/core",
  ]
}

function runtimePackages(input?: RuntimeCapabilityProfile) {
  if (runtimeCapabilityProfile(input) === "minimal") return "git ripgrep"
  if (runtimeCapabilityProfile(input) === "heavy") return "git ripgrep python3 chromium chromium-chromedriver libreoffice tesseract-ocr poppler-utils font-noto"
  return "git ripgrep python3"
}

function retryShell(command: string) {
  return `RUN sh -lc 'for attempt in 1 2 3; do ${command} && exit 0; echo "retry ${command} attempt $attempt" >&2; sleep $((attempt * 2)); done; ${command}'`
}

function apkAdd(packages: string) {
  return retryShell(`apk add --no-cache ${packages}`)
}

function bunProductionInstall() {
  return retryShell("bun install --production --no-save")
}

function servicePackages(role: ServiceRole) {
  if (role === "worker") return runtimePackages("standard")
  return ""
}

function serviceRuntimeLayer(role: ServiceRole, input?: { production?: boolean }) {
  if (role !== "worker") return ["RUN mkdir -p /tmp/cloud-runtime && chown -R bun:bun /tmp/cloud-runtime"]
  return [
    ...(input?.production
      ? [
          "COPY --from=source --chown=bun:bun /app/packages/opencode/migration /migration",
          "RUN printf '%s\\n' '#!/bin/sh' 'exec /usr/local/bin/bun /app/dist/opencode-run.js \"$@\"' > /usr/local/bin/opencode",
        ]
      : [
          "RUN printf '%s\\n' '#!/bin/sh' 'exec /usr/local/bin/bun run --conditions=browser /app/packages/opencode/src/index.ts \"$@\"' > /usr/local/bin/opencode",
        ]),
    "RUN chmod +x /usr/local/bin/opencode",
    "RUN mkdir -p /workspace /tmp/cloud-runtime /runtime/skills && chown -R bun:bun /workspace /tmp/cloud-runtime /runtime/skills",
  ]
}

function serviceDockerfile(role: ServiceRole, command: string, input?: { imageProfile?: ImageProfile }) {
  if (productionImage(input?.imageProfile)) return bundledServiceDockerfile(role, command)
  const packageLayer = servicePackages(role) ? [apkAdd(servicePackages(role))] : []
  return [
    "FROM oven/bun:1.3.14-alpine AS source",
    "",
    "WORKDIR /app",
    ...dependencyLayer(),
    ...pruneLayer(),
    "",
    "FROM oven/bun:1.3.14-alpine AS runtime",
    "",
    "ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
    "WORKDIR /app",
    ...packageLayer,
    "COPY --from=source --chown=bun:bun /app /app",
    ...serviceRuntimeLayer(role),
    "USER 1000:1000",
    "WORKDIR /app/packages/opencode",
    command,
    "",
  ].join("\n")
}

function serviceBundleEntrypoints(role: ServiceRole) {
  if (role === "api") return [
    "RUN bun build ./packages/opencode/src/cloud/local-api.ts --target=bun --outfile=/app/dist/local-api.js",
  ]
  return [
    "RUN bun build ./packages/opencode/src/cloud/local-worker.ts --target=bun --outfile=/app/dist/local-worker.js",
    "RUN bun build ./packages/opencode/src/cloud/postgres-worker.ts --target=bun --outfile=/app/dist/postgres-worker.js",
    "RUN bun build ./packages/opencode/src/cloud/runtime-worker-server.ts --target=bun --outfile=/app/dist/runtime-worker-server.js",
    "RUN bun build ./packages/opencode/src/cloud/opencode-run.ts --target=bun --conditions=browser --outdir=/app/dist",
  ]
}

function bundledServiceDockerfile(role: ServiceRole, command: string) {
  return [
    "FROM oven/bun:1.3.14-alpine AS source",
    "",
    "WORKDIR /app",
    ...productionInstallLayer(),
    ...pruneLayer(),
    "",
    "FROM oven/bun:1.3.14-alpine AS deps",
    "",
    "WORKDIR /app",
    "COPY --from=source --chown=bun:bun /app /app",
    apkAdd("python3 make g++"),
    bunProductionInstall(),
    ...workspaceDependencyLinkLayer(),
    ...productionDependencyPruneLayer(),
    "RUN mkdir -p packages/opencode/node_modules && test -d node_modules",
    "",
    "FROM deps AS build",
    "",
    "WORKDIR /app",
    ...serviceBundleEntrypoints(role),
    "",
    "FROM oven/bun:1.3.14-alpine AS runtime",
    "",
    "ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
    "WORKDIR /app",
    ...((role === "worker") ? [apkAdd(runtimePackages("standard"))] : []),
    "COPY --from=build --chown=bun:bun /app/dist /app/dist",
    ...serviceRuntimeLayer(role, { production: true }),
    "USER 1000:1000",
    command,
    "",
  ].join("\n")
}

function baseDockerfile(input: {
  final: string[]
  imageProfile?: ImageProfile
  runtimeCapabilityProfile?: RuntimeCapabilityProfile
}) {
  if (input.imageProfile === "production-install") {
    return [
      "FROM oven/bun:1.3.14-alpine AS source",
      "",
      "WORKDIR /app",
      ...productionInstallLayer(),
      ...pruneLayer(),
      "",
      "FROM oven/bun:1.3.14-alpine AS deps",
      "",
      "WORKDIR /app",
      "COPY --from=source --chown=bun:bun /app /app",
      apkAdd("python3 make g++"),
      bunProductionInstall(),
      ...workspaceDependencyLinkLayer(),
      ...productionDependencyPruneLayer(),
      "RUN mkdir -p packages/opencode/node_modules && test -d node_modules",
      "",
      "FROM oven/bun:1.3.14-alpine AS runtime",
      "",
      "ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
      "WORKDIR /app",
      apkAdd(runtimePackages(input.runtimeCapabilityProfile)),
      "COPY --from=source --chown=bun:bun /app /app",
      "COPY --from=deps --chown=bun:bun /app/node_modules /app/node_modules",
      "COPY --from=deps --chown=bun:bun /app/packages/opencode/node_modules /app/packages/opencode/node_modules",
      ...workspaceDependencyLinkLayer(),
      ...workspaceRuntimeLinkLayer(),
      "RUN printf '%s\\n' '#!/bin/sh' 'exec /usr/local/bin/bun run --conditions=browser /app/packages/opencode/src/index.ts \"$@\"' > /usr/local/bin/opencode",
      "RUN chmod +x /usr/local/bin/opencode",
      "RUN mkdir -p /workspace /tmp/cloud-runtime /runtime/skills && chown -R bun:bun /workspace /tmp/cloud-runtime /runtime/skills",
      "USER 1000:1000",
      ...input.final,
      "",
    ].join("\n")
  }
  return [
    "FROM oven/bun:1.3.14-alpine AS source",
    "",
    "WORKDIR /app",
    ...dependencyLayer(),
    ...pruneLayer(),
    "",
    "FROM oven/bun:1.3.14-alpine AS runtime",
    "",
    "ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
    "WORKDIR /app",
    apkAdd(runtimePackages(input.runtimeCapabilityProfile)),
    "COPY --from=source --chown=bun:bun /app /app",
    "RUN printf '%s\\n' '#!/bin/sh' 'exec /usr/local/bin/bun run --conditions=browser /app/packages/opencode/src/index.ts \"$@\"' > /usr/local/bin/opencode",
    "RUN chmod +x /usr/local/bin/opencode",
    "RUN mkdir -p /workspace /tmp/cloud-runtime /runtime/skills && chown -R bun:bun /workspace /tmp/cloud-runtime /runtime/skills",
    "USER 1000:1000",
    ...input.final,
    "",
  ].join("\n")
}

function runtimeDockerfile(input?: {
  imageProfile?: ImageProfile
  runtimeCapabilityProfile?: RuntimeCapabilityProfile
}) {
  if (productionImage(input?.imageProfile)) return bundledRuntimeDockerfile(input)
  return baseDockerfile({
    imageProfile: input?.imageProfile,
    runtimeCapabilityProfile: input?.runtimeCapabilityProfile,
    final: [
    "WORKDIR /workspace",
    "ENTRYPOINT [\"opencode\"]",
    ],
  })
}

function bundledRuntimeDockerfile(input?: {
  runtimeCapabilityProfile?: RuntimeCapabilityProfile
}) {
  return [
    "FROM oven/bun:1.3.14-alpine AS source",
    "",
    "WORKDIR /app",
    ...productionInstallLayer(),
    ...pruneLayer(),
    "",
    "FROM oven/bun:1.3.14-alpine AS deps",
    "",
    "WORKDIR /app",
    "COPY --from=source --chown=bun:bun /app /app",
    apkAdd("python3 make g++"),
    bunProductionInstall(),
    ...workspaceDependencyLinkLayer(),
    ...productionDependencyPruneLayer(),
    "RUN mkdir -p packages/opencode/node_modules && test -d node_modules",
    "",
    "FROM deps AS build",
    "",
    "WORKDIR /app/packages/opencode",
    "RUN bun build ./src/cloud/opencode-run.ts --target=bun --conditions=browser --outdir=/app/dist",
    "",
    "FROM oven/bun:1.3.14-alpine AS runtime",
    "",
    "ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
    "WORKDIR /app",
    apkAdd(runtimePackages(input?.runtimeCapabilityProfile)),
    "COPY --from=build --chown=bun:bun /app/dist /app/dist",
    "COPY --from=source --chown=bun:bun /app/packages/opencode/migration /migration",
    "RUN printf '%s\\n' '#!/bin/sh' 'exec /usr/local/bin/bun /app/dist/opencode-run.js \"$@\"' > /usr/local/bin/opencode",
    "RUN chmod +x /usr/local/bin/opencode",
    "RUN mkdir -p /workspace /tmp/cloud-runtime /runtime/skills && chown -R bun:bun /workspace /tmp/cloud-runtime /runtime/skills",
    "USER 1000:1000",
    "WORKDIR /workspace",
    "ENTRYPOINT [\"opencode\"]",
    "",
  ].join("\n")
}

function dockerignore(input?: { imageProfile?: ImageProfile }) {
  const production = imageProfile(input?.imageProfile) === "production-install"
  return [
    ".git",
    ".bun",
    ".cloud-runtime*",
    ".turbo",
    ".next",
    "coverage",
    "**/coverage",
    ...(production
      ? [
          "node_modules",
          "**/node_modules",
          "packages/app",
          "packages/console",
          "packages/desktop",
          "packages/desktop-electron",
          "packages/docs",
          "packages/enterprise",
          "packages/extensions",
          "packages/function",
          "packages/identity",
          "packages/slack",
          "packages/storybook",
          "packages/ui",
          "packages/web",
        ]
      : []),
    "**/node_modules/.cache",
    "**/node_modules/.vite",
    "**/node_modules/.turbo",
    "",
  ].join("\n")
}

function smokeAPIWorkflowScript() {
  return [
    "export async function run(input: {",
    "  baseURL?: string",
    "  fetch?: typeof fetch",
    "  waitForArtifacts?: boolean",
    "  useBYOK?: boolean",
    "  pollIntervalMS?: number",
    "  maxPolls?: number",
    "  onPoll?: (state: { jobID: string; attempt: number }) => Promise<void> | void",
    "} = {}) {",
    "const baseURL = input.baseURL ?? Bun.env.CLOUD_RUNTIME_API_URL ?? \"http://localhost:8787\"",
    "const fetcher = input.fetch ?? fetch",
    "",
    "async function request(path: string, init?: RequestInit) {",
    "  const response = await fetcher(`${baseURL}${path}`, {",
    "    ...init,",
    "    headers: {",
    "      \"content-type\": \"application/json\",",
    "      ...(init?.headers ?? {}),",
    "    },",
    "  })",
    "  if (!response.ok) throw new Error(`${init?.method ?? \"GET\"} ${path} failed: ${response.status} ${await response.text()}`)",
    "  return await response.json() as Record<string, unknown>",
    "}",
    "",
    "async function list(path: string) {",
    "  const response = await fetcher(`${baseURL}${path}`)",
    "  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`)",
    "  return await response.json() as Array<Record<string, unknown>>",
    "}",
    "",
    "async function waitForRuntimeArtifact(jobID: string, attempt: number): Promise<{ jobStatus: unknown; artifacts: number; events: number }> {",
    "  if (attempt > (input.maxPolls ?? 60)) throw new Error(`job ${jobID} did not produce artifacts before timeout`)",
    "  const current = await request(`/v1/jobs/${jobID}`)",
    "  const runtimeEvents = await list(`/v1/jobs/${jobID}/events`)",
    "  const artifacts = await list(`/v1/artifacts?jobID=${jobID}`)",
    "  if (current.status === \"succeeded\" && artifacts.length > 0) return { jobStatus: current.status, artifacts: artifacts.length, events: runtimeEvents.length }",
    "  if (current.status === \"failed\" || current.status === \"canceled\" || current.status === \"expired\") {",
    "    throw new Error(`job ${jobID} ended as ${String(current.status)} before producing artifacts`)",
    "  }",
    "  await input.onPoll?.({ jobID, attempt })",
    "  if ((input.pollIntervalMS ?? 1000) > 0) await Bun.sleep(input.pollIntervalMS ?? 1000)",
    "  return waitForRuntimeArtifact(jobID, attempt + 1)",
    "}",
    "",
    "// POST /v1/workspaces",
    "const workspace = await request(\"/v1/workspaces\", {",
    "  method: \"POST\",",
    "  body: JSON.stringify({ name: \"Docker Smoke\" }),",
    "})",
    "if (typeof workspace.id !== \"string\") throw new Error(\"workspace response did not include an id\")",
    "",
    "const session = await request(\"/v1/sessions\", {",
    "  method: \"POST\",",
    "  body: JSON.stringify({ workspaceID: workspace.id, userID: \"docker_smoke\" }),",
    "})",
    "if (typeof session.id !== \"string\") throw new Error(\"session response did not include an id\")",
    "",
    "const credential = input.useBYOK ? await request(\"/v1/llm-credentials\", {",
    "  method: \"POST\",",
    "  body: JSON.stringify({",
    "    scope: \"integrator\",",
    "    ownerKey: \"docker_smoke\",",
    "    name: \"Docker Smoke Anthropic\",",
    "    providerType: \"anthropic\",",
    "    provider: \"anthropic\",",
    "    apiKey: \"stored-outside-runtime\",",
    "    allowedModels: [\"claude-sonnet-4-5\"],",
    "    defaultModel: \"claude-sonnet-4-5\",",
    "    enabled: true,",
    "  }),",
    "}) : undefined",
    "if (input.useBYOK && typeof credential?.id !== \"string\") throw new Error(\"credential response did not include an id\")",
    "",
    "const prompt = [",
    "  \"Docker smoke runtime check.\",",
    "  \"Create docker-smoke-report.md in the current working directory with a short runtime summary.\",",
    "  \"Create .opencode-cloud/artifacts.json with JSON: {\\\"version\\\":1,\\\"jobID\\\":process.env.OPENCODE_RUNTIME_JOB_ID,\\\"artifacts\\\":[{\\\"name\\\":\\\"docker-smoke-report.md\\\",\\\"kind\\\":\\\"md\\\",\\\"path\\\":\\\"docker-smoke-report.md\\\",\\\"mime\\\":\\\"text/markdown\\\"}]}\",",
    "  \"Do not include any extra artifacts.\",",
    "].join(\"\\n\")",
    "",
    "const job = await request(\"/v1/jobs\", {",
    "  method: \"POST\",",
    "  body: JSON.stringify({",
    "    sessionID: session.id,",
    "    prompt,",
    "    inputs: [],",
    "    outputs: [\"md\"],",
    "    runtime: { profile: \"standard\" },",
    "    ...(credential?.id ? { integratorID: \"docker_smoke\", model: { credentialID: credential.id, provider: \"anthropic\", model: \"claude-sonnet-4-5\" } } : {}),",
    "    tools: {",
    "      webfetch: { enabled: false, allowDomains: [] },",
    "      websearch: { enabled: false },",
    "      mcp: [],",
    "      skills: [],",
    "    },",
    "  }),",
    "})",
    "if (typeof job.id !== \"string\") throw new Error(\"job response did not include an id\")",
    "",
    "const found = await request(`/v1/jobs/${job.id}`)",
    "if (found.id !== job.id) throw new Error(\"job lookup returned a different id\")",
    "",
    "const events = await list(`/v1/jobs/${job.id}/events`)",
    "if (!events.some((event) => event.type === \"job.status\")) throw new Error(\"job events did not include a status event\")",
    "",
    "if (input.waitForArtifacts) {",
    "  const first = await waitForRuntimeArtifact(String(job.id), 1)",
    "  const followupPrompt = [",
    "    \"Docker smoke shared-session continuity check.\",",
    "    \"Read the previous artifacts under process.env.OPENCODE_RUNTIME_WORKSPACE_DIR + '/artifacts'.\",",
    "    \"Create docker-smoke-followup.md in the current working directory summarizing what previous artifact files were visible.\",",
    "    \"Create .opencode-cloud/artifacts.json with JSON: {\\\"version\\\":1,\\\"jobID\\\":process.env.OPENCODE_RUNTIME_JOB_ID,\\\"artifacts\\\":[{\\\"name\\\":\\\"docker-smoke-followup.md\\\",\\\"kind\\\":\\\"md\\\",\\\"path\\\":\\\"docker-smoke-followup.md\\\",\\\"mime\\\":\\\"text/markdown\\\"}]}\",",
    "    \"Do not include any extra artifacts.\",",
    "  ].join(\"\\n\")",
    "  const followup = await request(\"/v1/jobs\", {",
    "    method: \"POST\",",
    "    body: JSON.stringify({",
    "      sessionID: session.id,",
    "      prompt: followupPrompt,",
    "      inputs: [],",
    "      outputs: [\"md\"],",
    "      runtime: { profile: \"standard\" },",
    "      ...(credential?.id ? { integratorID: \"docker_smoke\", model: { credentialID: credential.id, provider: \"anthropic\", model: \"claude-sonnet-4-5\" } } : {}),",
    "      tools: {",
    "        webfetch: { enabled: false, allowDomains: [] },",
    "        websearch: { enabled: false },",
    "        mcp: [],",
    "        skills: [],",
    "      },",
    "    }),",
    "  })",
    "  if (typeof followup.id !== \"string\") throw new Error(\"followup job response did not include an id\")",
    "  const second = await waitForRuntimeArtifact(String(followup.id), 1)",
    "  return {",
    "    workspaceID: workspace.id,",
    "    sessionID: session.id,",
    "    ...(credential?.id ? { credentialID: credential.id } : {}),",
    "    jobID: job.id,",
    "    ...first,",
    "    followupJobID: followup.id,",
    "    followupJobStatus: second.jobStatus,",
    "    followupArtifacts: second.artifacts,",
    "    followupEvents: second.events,",
    "  }",
    "}",
    "",
    "return { workspaceID: workspace.id, sessionID: session.id, ...(credential?.id ? { credentialID: credential.id } : {}), jobID: job.id, events: events.length }",
    "}",
    "",
    "if (import.meta.main) console.log(JSON.stringify(await run({ waitForArtifacts: true, useBYOK: Bun.env.CLOUD_RUNTIME_SMOKE_BYOK === \"1\" })))",
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

function buildTag(input: string) {
  return input.split(" ").at(input.split(" ").indexOf("-t") + 1) ?? ""
}

export function files(input?: Parameters<typeof compose>[0]) {
  const storageBackend = input?.storageBackend ?? "sqlite"
  const workerExecutionMode = input?.workerExecutionMode ?? "shared-session"
  const command = commands({
    includeRuntimeWorker: storageBackend === "postgres" && workerExecutionMode === "shared-session",
    imageProfile: input?.imageProfile,
    runtimeCapabilityProfile: input?.runtimeCapabilityProfile,
  })
  const profile = runtimeProfile(input)
  return {
    "docker-compose.yml": composeYAML(input),
    "api.env": `${envFile({ ...input, target: "api" })}\n`,
    "worker.env": `${envFile({ ...input, target: "worker" })}\n`,
    "Dockerfile.cloud-api": serviceDockerfile("api", cmd(apiCommand(input)), {
      imageProfile: input?.imageProfile,
    }),
    "Dockerfile.cloud-api.dockerignore": dockerignore({ imageProfile: input?.imageProfile }),
    "Dockerfile.cloud-worker": serviceDockerfile(
      "worker",
      cmd(workerCommand({ imageProfile: input?.imageProfile, storageBackend })),
      { imageProfile: input?.imageProfile },
    ),
    "Dockerfile.cloud-worker.dockerignore": dockerignore({ imageProfile: input?.imageProfile }),
    "Dockerfile.cloud-opencode-runtime": runtimeDockerfile({
      imageProfile: input?.imageProfile,
      runtimeCapabilityProfile: input?.runtimeCapabilityProfile,
    }),
    "Dockerfile.cloud-opencode-runtime.dockerignore": dockerignore({ imageProfile: input?.imageProfile }),
    "smoke-api-workflow.ts": smokeAPIWorkflowScript(),
    "runtime-profile.json": `${JSON.stringify(profile, undefined, 2)}\n`,
    "REMOTE_DOCKER.md": remoteDockerRunbook({ profile, commands: command }),
    "README.md": [
      "# Cloud OpenCode Runtime Local Docker",
      "",
      "Runtime profile:",
      "",
      `- Storage backend: ${profile.storageBackend}`,
      `- Worker execution: ${profile.workerExecutionMode}`,
      `- Image profile: ${profile.imageProfile}`,
      `- Runtime capability profile: ${profile.runtimeCapabilityProfile}`,
      `- Artifact storage: ${profile.artifactStorage}/${profile.objectBucket}`,
      `- Runtime image: ${profile.runtimeImage}`,
      "",
      "Build local images from this generated directory:",
      "",
      `    ${command.buildAPI}`,
      `    ${command.buildWorker}`,
      `    ${command.buildRuntime}`,
      "",
      "Start the local Cloud Runtime stack:",
      "",
      `    ${command.up}`,
      "",
      "The Compose stack initializes the MinIO `runtime-artifacts` bucket before API and worker startup.",
      "",
      "Tail API and worker logs:",
      "",
      `    ${command.logs}`,
      "",
      "Stop the stack:",
      "",
      `    ${command.down}`,
      "",
      "Check API health:",
      "",
      "    curl -fsS http://localhost:8787/health",
      "",
      "Run a minimal API workflow:",
      "",
      "    WORKSPACE_ID=$(curl -fsS -X POST http://localhost:8787/v1/workspaces \\",
      "      -H 'content-type: application/json' \\",
      "      -d '{\"name\":\"Local SaaS\"}' | jq -r .id)",
      "    SESSION_ID=$(curl -fsS -X POST http://localhost:8787/v1/sessions \\",
      "      -H 'content-type: application/json' \\",
      "      -d \"{\\\"workspaceID\\\":\\\"$WORKSPACE_ID\\\",\\\"userID\\\":\\\"user_local\\\"}\" | jq -r .id)",
      "    JOB_ID=$(curl -fsS -X POST http://localhost:8787/v1/jobs \\",
      "      -H 'content-type: application/json' \\",
      "      -d \"{\\\"sessionID\\\":\\\"$SESSION_ID\\\",\\\"prompt\\\":\\\"Create a local runtime summary\\\",\\\"inputs\\\":[],\\\"outputs\\\":[\\\"md\\\"],\\\"runtime\\\":{\\\"profile\\\":\\\"standard\\\"},\\\"tools\\\":{\\\"webfetch\\\":{\\\"enabled\\\":false,\\\"allowDomains\\\":[]},\\\"websearch\\\":{\\\"enabled\\\":false},\\\"mcp\\\":[],\\\"skills\\\":[]}}\" | jq -r .id)",
      "    curl -fsS http://localhost:8787/v1/jobs/$JOB_ID",
      "    curl -fsS http://localhost:8787/v1/jobs/$JOB_ID/events",
      "",
      "Generate files for simulated worker execution:",
      "",
      "    CLOUD_RUNTIME_EXECUTION_MODE=simulate bun run cloud:docker .cloud-runtime-simulate",
      "",
      "Generate files for real local opencode execution:",
      "",
      "    CLOUD_RUNTIME_EXECUTION_MODE=opencode CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS=900000 bun run cloud:docker .cloud-runtime-opencode",
      "",
      "Generate files for the PostgreSQL shared-session pool profile:",
      "",
      "    bun run cloud:docker:shared",
      "    bun run cloud:docker:shared:check",
      "    bun run cloud:docker:shared:smoke",
      "    CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run",
      "",
      "One-command shared-session E2E path:",
      "",
      "    bun run cloud:docker:e2e",
      "    CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e",
      "    CLOUD_RUNTIME_DOCKER_SKIP_BUILD=1 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e",
      "    CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_SMOKE_BYOK_SECRET=$ANTHROPIC_API_KEY CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e",
      "",
      "Production-install shared-session E2E path:",
      "",
      "    bun run cloud:docker:e2e:production",
      "    CLOUD_RUNTIME_DOCKER_SKIP_BUILD=1 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e:production",
      "    CLOUD_RUNTIME_CAPABILITY_PROFILE=minimal CLOUD_RUNTIME_DOCKER_SKIP_BUILD=1 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e:production",
      "    CLOUD_RUNTIME_CAPABILITY_PROFILE=heavy CLOUD_RUNTIME_DOCKER_SKIP_BUILD=1 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e:production",
      "",
      "`cloud:docker:e2e` writes `.cloud-runtime-shared`, validates it, and prints the smoke plan. It only builds images and starts Compose when `CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1` is set.",
      "`cloud:docker:e2e:production` writes `.cloud-runtime-shared-production` and uses the role-specific production-install API, worker, and opencode runtime images.",
      "Set `CLOUD_RUNTIME_DOCKER_SKIP_BUILD=1` when local `cloud-runtime-*` images are already current and you want to run only Compose plus the API workflow.",
      "",
      "The shared profile writes to `.cloud-runtime-shared` and runs API, queue worker, and runtime-worker services together.",
      "The production shared profile writes to `.cloud-runtime-shared-production`; copy that directory plus pushed or loaded images to another Docker host to run the same Compose topology there.",
      "",
      "Model configuration:",
      "",
      "    export ANTHROPIC_API_KEY=sk-ant-...",
      "    export CLOUD_RUNTIME_MODEL_PROVIDER=anthropic",
      "    export CLOUD_RUNTIME_MODEL=claude-sonnet-4-5",
      "    CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run",
      "",
      "For OpenAI-compatible or customer BYOK testing, set the matching provider key such as `OPENAI_API_KEY` and optional model override before running smoke. Custom key names can be passed through generated containers with:",
      "",
      "    CLOUD_RUNTIME_MODEL_ENV_KEYS=CUSTOM_LLM_API_KEY bun run cloud:docker .cloud-runtime-custom",
      "",
      "If model preflight fails, export one of the generated `runtime-profile.json` modelEnvKeys, or regenerate with `CLOUD_RUNTIME_MODEL_ENV_KEYS` for a custom provider key.",
      "To validate API, Postgres, MinIO, queue worker, and runtime-worker without a model key, run:",
      "",
      "    CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run",
      "",
      "To validate the BYOK credential path during smoke, pass a scoped smoke secret and enable the BYOK workflow:",
      "",
      "    CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_SMOKE_BYOK_SECRET=$ANTHROPIC_API_KEY CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run",
      "",
      "Validate the generated Docker wiring without starting Docker:",
      "",
      "    bun run cloud:docker:check .cloud-runtime-opencode",
      "    bun run cloud:docker:smoke .cloud-runtime-opencode",
      "    bun run cloud:verify --audit",
      "",
      "Run the real Docker smoke workflow:",
      "",
      "    CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:run .cloud-runtime-opencode",
      "",
      "The smoke run checks `/health`, then verifies `POST /v1/workspaces`, session creation, job creation, job lookup, job events, worker completion, and artifacts.",
      "The real smoke run requires `CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1` because it builds images, starts Compose services, and may execute real opencode work.",
      "If the smoke run fails, the CLI prints each step status with attempts plus compact stdout and stderr snippets.",
      `Use \`${command.logs}\` from the generated directory for full service logs.`,
      "",
    ].join("\n"),
  }
}

function remoteDockerRunbook(input: {
  profile: ReturnType<typeof runtimeProfile>
  commands: ReturnType<typeof commands>
}) {
  const images = imageNames({
    imageProfile: input.profile.imageProfile,
    runtimeCapabilityProfile: input.profile.runtimeCapabilityProfile,
  })
  const runtimeTag = runtimeImageTag({
    imageProfile: input.profile.imageProfile,
    runtimeCapabilityProfile: input.profile.runtimeCapabilityProfile,
  })
  return [
    "# Cloud Runtime Remote Docker Runbook",
    "",
    "This directory can be copied to another Docker host after the images are built locally or published to a registry.",
    "",
    "Runtime profile:",
    "",
    `- Image profile: ${input.profile.imageProfile}`,
    `- Runtime capability profile: ${input.profile.runtimeCapabilityProfile}`,
    `- Storage backend: ${input.profile.storageBackend}`,
    `- Worker execution: ${input.profile.workerExecutionMode}`,
    `- API image: ${images.api}`,
    `- Worker image: ${images.worker}`,
    `- Runtime image: ${images.runtime}`,
    "",
    "Option A: move images with docker save/load",
    "",
    "On the build machine:",
    "",
    "```bash",
    input.commands.saveImages,
    "tar -czf cloud-runtime-compose-bundle.tgz docker-compose.yml api.env worker.env runtime-profile.json smoke-api-workflow.ts REMOTE_DOCKER.md image-archive",
    "```",
    "",
    "Copy `cloud-runtime-compose-bundle.tgz` to the target Docker host, then run:",
    "",
    "```bash",
    "tar -xzf cloud-runtime-compose-bundle.tgz",
    "CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_DOCKER_BUNDLE_VERIFY=1 bun run ./src/cloud/local-docker.ts --bundle-verify .",
    "```",
    "",
    "The verify command loads images, starts Compose, checks `/health`, runs the smoke API workflow, prints diagnostics on failure, and cleans up. To run the same steps manually:",
    "",
    "```bash",
    input.commands.loadImages,
    input.commands.up,
    "curl -fsS http://localhost:8787/health",
    "```",
    "",
    "Option B: publish images to a registry",
    "",
    "Tag and push the three role-specific images to your registry, then edit `docker-compose.yml` image names to those registry tags before copying this directory.",
    "",
    "```bash",
    `docker tag ${images.api} registry.example.com/cloud-runtime-api:production-install`,
    `docker tag ${images.worker} registry.example.com/cloud-runtime-worker:production-install`,
    `docker tag ${images.runtime} registry.example.com/cloud-runtime-opencode:${runtimeTag}`,
    "docker push registry.example.com/cloud-runtime-api:production-install",
    "docker push registry.example.com/cloud-runtime-worker:production-install",
    `docker push registry.example.com/cloud-runtime-opencode:${runtimeTag}`,
    "```",
    "",
    "Operational notes:",
    "",
    "- Keep `api.env` and `worker.env` as deployment secrets when they contain model or storage credentials.",
    "- Use `minimal` for light file/code jobs, `standard` for Python-assisted analysis, and `heavy` only for browser, OCR, LibreOffice, or bulk document processing pools.",
    "- On the remote host, run `docker compose logs -f api worker runtime-worker` for shared-session diagnostics.",
    "- Stop and clean the remote stack with `docker compose down -v` when you want to remove Postgres, MinIO, Redis, and worker cache volumes.",
    "",
  ].join("\n")
}

export function smokePlan(input: { files: ReturnType<typeof files>; commands: ReturnType<typeof commands> }) {
  const apiImage = buildTag(input.commands.buildAPI)
  const workerImage = buildTag(input.commands.buildWorker)
  const runtimeImage = buildTag(input.commands.buildRuntime)
  const apiCommandPresent = input.files["Dockerfile.cloud-api"].includes('CMD ["bun", "run", "./src/cloud/local-api.ts"]') ||
    input.files["Dockerfile.cloud-api"].includes('CMD ["bun", "./dist/local-api.js"]')
  const workerCommandPresent = [
    'CMD ["bun", "run", "./src/cloud/local-worker.ts"]',
    'CMD ["bun", "run", "./src/cloud/postgres-worker.ts"]',
    'CMD ["bun", "./dist/local-worker.js"]',
    'CMD ["bun", "./dist/postgres-worker.js"]',
  ].some((item) => input.files["Dockerfile.cloud-worker"].includes(item))
  const result = [
    check({
      name: "build-api-image",
      passed: apiCommandPresent && apiImage.startsWith("cloud-runtime-api:"),
      detail: input.commands.buildAPI,
    }),
    check({
      name: "build-worker-image",
      passed: workerCommandPresent && workerImage.startsWith("cloud-runtime-worker:"),
      detail: input.commands.buildWorker,
    }),
    check({
      name: "build-runtime-image",
      passed: input.files["Dockerfile.cloud-opencode-runtime"].includes('ENTRYPOINT ["opencode"]') &&
        runtimeImage.startsWith("cloud-runtime-opencode:"),
      detail: input.commands.buildRuntime,
    }),
    check({
      name: "api-role-pruning",
      passed: !input.files["Dockerfile.cloud-api"].includes('ENTRYPOINT ["opencode"]') &&
        !input.files["Dockerfile.cloud-api"].includes("/usr/local/bin/opencode") &&
        !input.files["Dockerfile.cloud-api"].includes("apk add --no-cache git ripgrep") &&
        !input.files["Dockerfile.cloud-api"].includes("WORKDIR /workspace"),
      detail: "API image excludes opencode runtime entrypoint, wrapper, workspace, and runtime tools",
    }),
    check({
      name: "worker-role-pruning",
      passed: !input.files["Dockerfile.cloud-worker"].includes('ENTRYPOINT ["opencode"]') &&
        input.files["Dockerfile.cloud-worker"].includes("/usr/local/bin/opencode") &&
        !input.files["Dockerfile.cloud-worker"].includes("chromium") &&
        !input.files["Dockerfile.cloud-worker"].includes("libreoffice") &&
        !input.files["Dockerfile.cloud-worker"].includes("tesseract-ocr"),
      detail: "Worker image can execute opencode for shared-session runtime workers without heavy runtime packages",
    }),
    check({
      name: "runtime-role-tools",
      passed: input.files["Dockerfile.cloud-opencode-runtime"].includes("/usr/local/bin/opencode") &&
        input.files["Dockerfile.cloud-opencode-runtime"].includes("WORKDIR /workspace") &&
        input.files["Dockerfile.cloud-opencode-runtime"].includes("apk add --no-cache git ripgrep"),
      detail: "OpenCode runtime image keeps the wrapper, workspace, and selected runtime tools",
    }),
    check({
      name: "runtime-skill-directory",
      passed: input.files["Dockerfile.cloud-opencode-runtime"].includes("/runtime/skills"),
      detail: "OpenCode runtime image creates the managed skill directory",
    }),
    check({
      name: "compose-skill-volume",
      passed: input.files["docker-compose.yml"].includes("${CLOUD_RUNTIME_SKILLS_DIR:-./skills}:/runtime/skills:ro"),
      detail: "Docker Compose mounts managed skills into runtime services read-only",
    }),
    check({
      name: "compose-api-image",
      passed: input.files["docker-compose.yml"].includes(`image: ${apiImage}`),
      detail: `docker-compose.yml uses ${apiImage}`,
    }),
    check({
      name: "compose-worker-image",
      passed: input.files["docker-compose.yml"].includes(`image: ${workerImage}`),
      detail: `docker-compose.yml uses ${workerImage}`,
    }),
    check({
      name: "compose-runtime-image",
      passed: input.files["docker-compose.yml"].includes(`CLOUD_RUNTIME_SANDBOX_IMAGE: ${runtimeImage}`),
      detail: `worker uses ${runtimeImage}`,
    }),
    check({
      name: "api-health",
      passed: input.files["README.md"].includes("curl -fsS http://localhost:8787/health"),
      detail: "curl -fsS http://localhost:8787/health",
    }),
    check({
      name: "api-workflow",
      passed: input.files["README.md"].includes("curl -fsS -X POST http://localhost:8787/v1/jobs"),
      detail: "README.md includes workspace/session/job workflow",
    }),
    check({
      name: "artifact-workflow",
      passed: input.files["smoke-api-workflow.ts"].includes("waitForArtifacts") &&
        input.files["smoke-api-workflow.ts"].includes("/v1/artifacts?jobID="),
      detail: "smoke-api-workflow.ts waits for worker completion and artifacts",
    }),
    check({
      name: "postgres-storage-env",
      passed: input.files["api.env"].includes("CLOUD_RUNTIME_OBJECT_ENDPOINT=http://minio:9000") &&
        input.files["api.env"].includes("CLOUD_RUNTIME_OBJECT_REGION=us-east-1") &&
        input.files["api.env"].includes("CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID=opencode") &&
        input.files["api.env"].includes("CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY=opencode-password") &&
        input.files["worker.env"].includes("CLOUD_RUNTIME_OBJECT_ENDPOINT=http://minio:9000") &&
        input.files["worker.env"].includes("CLOUD_RUNTIME_OBJECT_REGION=us-east-1") &&
        input.files["worker.env"].includes("CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID=opencode") &&
        input.files["worker.env"].includes("CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY=opencode-password"),
      detail: "PostgreSQL API and worker use S3-compatible object storage env",
    }),
    check({
      name: "byok-smoke-workflow",
      passed: input.files["smoke-api-workflow.ts"].includes("/v1/llm-credentials") &&
        input.files["smoke-api-workflow.ts"].includes("CLOUD_RUNTIME_SMOKE_BYOK") &&
        input.files["worker.env"].includes(`${SmokeBYOKSecretEnv}=`),
      detail: "smoke-api-workflow.ts can create a scoped LLM credential and run a job with credentialID",
    }),
    check({
      name: "minio-bucket-init",
      passed: input.files["docker-compose.yml"].includes("minio-init:") &&
        input.files["docker-compose.yml"].includes("mc mb --ignore-existing local/runtime-artifacts") &&
        input.files["docker-compose.yml"].includes("depends_on:") &&
        input.files["docker-compose.yml"].includes("service_completed_successfully"),
      detail: "docker-compose.yml initializes runtime-artifacts bucket",
    }),
    check({
      name: "runtime-worker-service",
      passed: !input.files["runtime-profile.json"].includes('"workerExecutionMode": "shared-session"') ||
        !input.files["runtime-profile.json"].includes('"storageBackend": "postgres"') ||
        (input.files["docker-compose.yml"].includes("runtime-worker:") &&
          input.files["docker-compose.yml"].includes("CLOUD_RUNTIME_ENDPOINT: http://runtime-worker:8788") &&
          input.commands.logs.includes("runtime-worker")),
      detail: input.files["runtime-profile.json"].includes('"workerExecutionMode": "shared-session"') &&
        input.files["runtime-profile.json"].includes('"storageBackend": "postgres"')
        ? "docker-compose.yml exposes runtime-worker for shared-session execution"
        : "runtime-worker service is not required for this profile",
    }),
    check({
      name: "runtime-profile",
      passed: input.files["runtime-profile.json"].includes("\"storageBackend\"") &&
        input.files["runtime-profile.json"].includes("\"workerExecutionMode\"") &&
        input.files["runtime-profile.json"].includes("\"objectBucket\": \"runtime-artifacts\""),
      detail: input.files["runtime-profile.json"],
    }),
  ]
  return {
    ok: result.every((item) => item.status === "passed"),
    checks: result,
    commands: [
      input.commands.buildAPI,
      input.commands.buildWorker,
      input.commands.buildRuntime,
      input.commands.up,
      "curl -fsS http://localhost:8787/health",
      input.commands.logs,
    ],
  }
}

export function smokeRunPlan(input: {
  directory: string
  timeoutMS?: number
  healthRetries?: number
  healthIntervalMS?: number
  commands: ReturnType<typeof commands>
  checkRuntimeWorker?: boolean
  skipBuild?: boolean
}) {
  return {
    directory: input.directory,
    timeoutMS: input.timeoutMS ?? 300_000,
    steps: [
      {
        name: "check-docker",
        phase: "preflight",
        command: "docker info",
      },
      {
        name: "check-docker-compose",
        phase: "preflight",
        command: "docker compose version",
      },
      {
        name: "check-api-port",
        phase: "preflight",
        command: "sh -lc '! lsof -iTCP:8787 -sTCP:LISTEN'",
        args: ["sh", "-lc", "! lsof -iTCP:8787 -sTCP:LISTEN"],
      },
      {
        name: "check-build-context",
        phase: "preflight",
        command: "test -d ../../..",
        args: ["test", "-d", "../../.."],
      },
      ...(input.checkRuntimeWorker
        ? [
            {
              name: "check-runtime-worker-service",
              phase: "preflight",
              command: "docker compose config --services | grep -qx runtime-worker",
              args: ["sh", "-lc", "docker compose config --services | grep -qx runtime-worker"],
            },
          ]
        : []),
      ...(input.skipBuild
        ? []
        : [
            {
              name: "build-api-image",
              phase: "build",
              command: input.commands.buildAPI,
            },
            {
              name: "build-worker-image",
              phase: "build",
              command: input.commands.buildWorker,
            },
            {
              name: "build-runtime-image",
              phase: "build",
              command: input.commands.buildRuntime,
            },
          ]),
      {
        name: "start-compose",
        phase: "start",
        command: input.commands.up,
      },
      {
        name: "wait-api-health",
        phase: "verify",
        command: "curl -fsS http://localhost:8787/health",
        retries: input.healthRetries ?? 30,
        intervalMS: input.healthIntervalMS ?? 1_000,
      },
      {
        name: "verify-api-workflow",
        phase: "verify",
        command: "bun run ./smoke-api-workflow.ts",
        args: ["bun", "run", "./smoke-api-workflow.ts"],
      },
      {
        name: "print-logs-on-failure",
        phase: "diagnose",
        command: diagnosticLogs(input.commands.logs),
        onFailure: true,
      },
      {
        name: "cleanup-compose",
        phase: "cleanup",
        command: input.commands.down,
        alwaysRun: true,
      },
    ],
  }
}

export async function smokeRunPlanForDirectory(input: {
  directory: string
  timeoutMS?: number
  healthRetries?: number
  healthIntervalMS?: number
  skipBuild?: boolean
}) {
  const command = await directoryCommands({ directory: input.directory })
  return smokeRunPlan({
    directory: input.directory,
    commands: command,
    checkRuntimeWorker: command.logs.includes("runtime-worker"),
    ...(input.timeoutMS ? { timeoutMS: input.timeoutMS } : {}),
    ...(input.healthRetries ? { healthRetries: input.healthRetries } : {}),
    ...(input.healthIntervalMS ? { healthIntervalMS: input.healthIntervalMS } : {}),
    skipBuild: input.skipBuild,
  })
}

export async function bundlePlanForDirectory(input: { directory: string }) {
  const command = await directoryCommands({ directory: input.directory })
  return {
    directory: input.directory,
    timeoutMS: 300_000,
    steps: [
      {
        name: "check-docker",
        phase: "preflight",
        command: "docker info",
      },
      {
        name: "check-images",
        phase: "preflight",
        command: command.inspectImages,
      },
      {
        name: "save-images",
        phase: "build",
        command: command.saveImages,
        args: ["sh", "-lc", command.saveImages],
      },
      {
        name: "create-compose-bundle",
        phase: "build",
        command: command.bundle,
        args: ["sh", "-lc", command.bundle],
      },
    ],
  }
}

export async function bundleVerifyPlanForDirectory(input: {
  directory: string
  healthRetries?: number
  healthIntervalMS?: number
}) {
  const command = await directoryCommands({ directory: input.directory })
  return {
    directory: input.directory,
    timeoutMS: 300_000,
    steps: [
      {
        name: "check-docker",
        phase: "preflight",
        command: "docker info",
      },
      {
        name: "check-docker-compose",
        phase: "preflight",
        command: "docker compose version",
      },
      {
        name: "check-api-port",
        phase: "preflight",
        command: "sh -lc '! lsof -iTCP:8787 -sTCP:LISTEN'",
        args: ["sh", "-lc", "! lsof -iTCP:8787 -sTCP:LISTEN"],
      },
      {
        name: "check-image-archive",
        phase: "preflight",
        command: "test -f image-archive/cloud-runtime-images.tar",
        args: ["test", "-f", "image-archive/cloud-runtime-images.tar"],
      },
      {
        name: "load-images",
        phase: "build",
        command: command.loadImages,
        args: ["sh", "-lc", command.loadImages],
      },
      {
        name: "start-compose",
        phase: "start",
        command: command.up,
      },
      {
        name: "wait-api-health",
        phase: "verify",
        command: "curl -fsS http://localhost:8787/health",
        retries: input.healthRetries ?? 30,
        intervalMS: input.healthIntervalMS ?? 1_000,
      },
      {
        name: "verify-api-workflow",
        phase: "verify",
        command: "bun run ./smoke-api-workflow.ts",
        args: ["bun", "run", "./smoke-api-workflow.ts"],
      },
      {
        name: "print-logs-on-failure",
        phase: "diagnose",
        command: diagnosticLogs(command.logs),
        onFailure: true,
      },
      {
        name: "cleanup-compose",
        phase: "cleanup",
        command: command.down,
        alwaysRun: true,
      },
    ],
  }
}

export function bundlePlanSummary(input: Awaited<ReturnType<typeof bundlePlanForDirectory>>) {
  return [
    `Cloud Runtime Docker bundle plan for ${input.directory}`,
    ...input.steps.map((item) => `[${item.phase}] ${item.name}: ${item.command}`),
    "Set CLOUD_RUNTIME_CONFIRM_DOCKER_BUNDLE=1 to create cloud-runtime-compose-bundle.tgz.",
  ].join("\n")
}

export function bundleVerifyPlanSummary(input: Awaited<ReturnType<typeof bundleVerifyPlanForDirectory>>) {
  return [
    `Cloud Runtime Docker bundle verify plan for ${input.directory}`,
    ...input.steps.map((item) => `[${item.phase}] ${item.name}: ${item.command}`),
    "Set CLOUD_RUNTIME_CONFIRM_DOCKER_BUNDLE_VERIFY=1 to load images, start Compose, run smoke, and clean up.",
  ].join("\n")
}

export function bundleResultSummary(input: Awaited<ReturnType<typeof runSmokePlan>>) {
  return [
    `Cloud Runtime Docker bundle: ${input.ok ? "passed" : "failed"}`,
    ...input.steps.flatMap((step) => [
      `[${step.status}] ${step.name} attempts=${step.attempts}: ${step.command}`,
      ...summaryLines(step.stdout).map((line) => `  stdout: ${line}`),
      ...summaryLines(step.stderr).map((line) => `  stderr: ${line}`),
    ]),
    ...(input.ok ? ["Bundle artifact: cloud-runtime-compose-bundle.tgz"] : []),
  ].join("\n")
}

export function bundleVerifyResultSummary(input: Awaited<ReturnType<typeof runSmokePlan>>) {
  return [
    `Cloud Runtime Docker bundle verify: ${input.ok ? "passed" : "failed"}`,
    ...input.steps.flatMap((step) => [
      `[${step.status}] ${step.name} attempts=${step.attempts}: ${step.command}`,
      ...summaryLines(step.stdout).map((line) => `  stdout: ${line}`),
      ...smokeWorkflowEvidenceLines(step),
      ...summaryLines(step.stderr).map((line) => `  stderr: ${line}`),
    ]),
  ].join("\n")
}

export async function writeFiles(input: Parameters<typeof compose>[0] & { directory: string }) {
  const generated = files(input)
  const command = commandsForFiles(generated)
  await Promise.all(
    Object.entries(generated).map(async ([name, content]) => {
      await Bun.write(path.join(input.directory, name), content)
    }),
  )
  return {
    directory: input.directory,
    files: Object.keys(generated).map((name) => path.join(input.directory, name)),
    commands: command,
    staticCheck: smokePlan({ files: generated, commands: command }),
  }
}

export async function checkDirectory(input: { directory: string }) {
  const expected = Object.keys(files())
  const missing = (await Promise.all(expected.map(async (name) => await Bun.file(path.join(input.directory, name)).exists() ? undefined : name)))
    .filter((name): name is string => Boolean(name))
  if (missing.length) {
    const command = commands()
    return {
      ok: false,
      checks: [
        check({
          name: "generated-files",
          passed: false,
          detail: `missing ${missing.join(", ")}`,
        }),
      ],
      commands: [
        command.buildAPI,
        command.buildWorker,
        command.buildRuntime,
        command.up,
        "curl -fsS http://localhost:8787/health",
      ],
    }
  }
  const generated = Object.fromEntries(
    await Promise.all(expected.map(async (name) => [name, await Bun.file(path.join(input.directory, name)).text()])),
  ) as ReturnType<typeof files>
  const command = commandsForFiles(generated)
  return smokePlan({
    files: generated,
    commands: command,
  })
}

export async function checkCLI(input: { directory: string }) {
  const result = await checkDirectory(input)
  return {
    exitCode: result.ok ? 0 : 1,
    output: checkSummary(result),
  }
}

export function cliSummary(input: { directory: string; commands: ReturnType<typeof commands>; staticCheck: ReturnType<typeof smokePlan> }) {
  const profileCheck = input.staticCheck.checks.find((item) => item.name === "runtime-profile")
  const profile = profileCheck?.status === "passed" ? JSON.parse(profileCheck.detail) as ReturnType<typeof runtimeProfile> : runtimeProfile()
  return [
    `Wrote Cloud Runtime Docker files to ${input.directory}`,
    `Static Check:  ${input.staticCheck.ok ? "passed" : "failed"}`,
    `Storage:       ${profile.storageBackend}`,
    `Execution:     ${profile.workerExecutionMode}`,
    `Image Profile: ${profile.imageProfile}`,
    `Runtime Profile: ${profile.runtimeCapabilityProfile}`,
    `Artifacts:     ${profile.artifactStorage}/${profile.objectBucket}`,
    `Build API:     ${input.commands.buildAPI}`,
    `Build Worker:  ${input.commands.buildWorker}`,
    `Build Runtime: ${input.commands.buildRuntime}`,
    `Check:         bun run cloud:docker:check ${input.directory}`,
    `Smoke Plan:    bun run cloud:docker:smoke ${input.directory}`,
    `Start:         ${input.commands.up}`,
    `Logs:          ${input.commands.logs}`,
    `Stop:          ${input.commands.down}`,
  ].join("\n")
}

export function checkSummary(input: ReturnType<typeof smokePlan>) {
  return [
    `Cloud Runtime Docker static check: ${input.ok ? "passed" : "failed"}`,
    ...input.checks.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
    "Next commands:",
    ...input.commands.map((item) => `  ${item}`),
  ].join("\n")
}

export function smokeRunSummary(input: ReturnType<typeof smokeRunPlan>) {
  return [
    `Cloud Runtime Docker smoke run plan for ${input.directory}`,
    `Timeout: ${input.timeoutMS}ms`,
    ...input.steps.map((item) => `[${item.phase}] ${item.name}: ${item.command}`),
    "Cleanup always runs after start.",
  ].join("\n")
}

export async function smokeCLI(input: {
  directory: string
  healthRetries?: number
  healthIntervalMS?: number
}) {
  return {
    exitCode: 0,
    output: smokeRunSummary(
      await smokeRunPlanForDirectory({
        directory: input.directory,
        ...(input.healthRetries ? { healthRetries: input.healthRetries } : {}),
        ...(input.healthIntervalMS ? { healthIntervalMS: input.healthIntervalMS } : {}),
      }),
    ),
  }
}

function firstLine(input: string) {
  return input.split(/\r?\n/).find((item) => item.trim())?.slice(0, 240) ?? ""
}

function summaryLines(input: string) {
  const lines = input
    .split(/\r?\n/)
    .filter((item) => item.trim())
  const errors = lines.filter((item) => /error|err_|failed/i.test(item)).slice(-8)
  const selected = lines.length > 12 ? lines.slice(0, 4).concat("...", ...errors, ...lines.slice(-8)) : lines
  return [...new Set(selected)]
    .map((item) => item.slice(0, 240))
}

function smokeWorkflowEvidenceLines(input: { name: string; stdout: string }) {
  if (input.name !== "verify-api-workflow") return []
  try {
    const result = JSON.parse(input.stdout) as Record<string, unknown>
    if (typeof result.workspaceID !== "string" || typeof result.sessionID !== "string" || typeof result.jobID !== "string") return []
    return [
      `  evidence: workspace=${result.workspaceID} session=${result.sessionID} job=${result.jobID} status=${String(result.jobStatus ?? "unknown")} artifacts=${String(result.artifacts ?? 0)} events=${String(result.events ?? 0)}`,
      ...(typeof result.followupJobID === "string"
        ? [
            `  followup: job=${result.followupJobID} status=${String(result.followupJobStatus ?? "unknown")} artifacts=${String(result.followupArtifacts ?? 0)} events=${String(result.followupEvents ?? 0)}`,
          ]
        : []),
    ]
  } catch {
    return []
  }
}

function smokeSuggestion(input: { name: string; status: string; logsRuntimeWorker?: boolean }) {
  if (input.status !== "failed") return []
  if (input.name === "check-docker") return ["  next: start Docker Desktop or verify docker info works from this shell"]
  if (input.name === "check-docker-compose") return ["  next: install or enable Docker Compose v2 so docker compose version succeeds"]
  if (input.name === "check-api-port") return ["  next: stop the process listening on port 8787 or change the generated API port before running smoke"]
  if (input.name === "check-build-context") return ["  next: run smoke from the generated directory or regenerate files so ../../.. points at the repo root"]
  if (input.name === "check-runtime-worker-service") return ["  next: regenerate .cloud-runtime-shared with bun run cloud:docker:shared so docker compose includes runtime-worker"]
  if (input.name === "build-api-image") return ["  next: inspect Dockerfile.cloud-api, Bun dependency install output, and build context ../../.."]
  if (input.name === "build-worker-image") return ["  next: inspect Dockerfile.cloud-worker, Bun dependency install output, and build context ../../.."]
  if (input.name === "build-runtime-image") return ["  next: inspect Dockerfile.cloud-opencode-runtime, opencode entrypoint generation, and build context ../../.."]
  if (input.name === "start-compose") return ["  next: inspect docker compose config and ensure Postgres, MinIO, Redis, API, and worker ports are available"]
  if (input.name === "wait-api-health") return ["  next: inspect docker compose logs for api and worker; verify the API service bound port 8787"]
  if (input.name === "verify-api-workflow") {
    return input.logsRuntimeWorker
      ? ["  next: inspect the API workflow output, worker logs, runtime-worker logs, and artifact manifest generation"]
      : ["  next: inspect the API workflow output, worker logs, and artifact manifest generation"]
  }
  return ["  next: inspect this step output and rerun bun run cloud:docker:smoke for the planned command sequence"]
}

function modelCredentialConfigured(input: {
  env: Record<string, string | undefined>
  keys: string[]
}) {
  return input.keys.some((key) => Boolean(input.env[key]))
}

export function modelPreflight(input: {
  profile: ReturnType<typeof runtimeProfile>
  env: Record<string, string | undefined>
}) {
  const required = input.profile.workerExecutionMode !== "simulate" && input.profile.workerExecutionMode !== "lease"
  const credentialOverride = input.env.CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE === "1"
  const keys = "modelEnvKeys" in input.profile && Array.isArray(input.profile.modelEnvKeys) ? input.profile.modelEnvKeys : modelEnvKeys()
  const selection = input.env.CLOUD_RUNTIME_MODEL_PROVIDER && input.env.CLOUD_RUNTIME_MODEL
    ? `${input.env.CLOUD_RUNTIME_MODEL_PROVIDER}/${input.env.CLOUD_RUNTIME_MODEL}`
    : "platform default model"
  const checks = [
    check({
      name: "model-selection",
      passed: true,
      detail: `using ${selection}`,
    }),
    check({
      name: "model-credential",
      passed: !required || credentialOverride || modelCredentialConfigured({ env: input.env, keys }),
      detail: !required
        ? "not required for simulated or lease-only Docker smoke"
        : credentialOverride
          ? "CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 set for offline smoke"
          : "set a provider API key env such as ANTHROPIC_API_KEY, OPENAI_API_KEY, or any *_API_KEY",
    }),
  ]
  return {
    ok: checks.every((item) => item.status === "passed"),
    checks,
    keys,
  }
}

export function modelPreflightSummary(input: ReturnType<typeof modelPreflight>) {
  return [
    `Cloud Runtime Docker model preflight: ${input.ok ? "passed" : "failed"}`,
    ...input.checks.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
    ...(input.ok ? [] : [`accepted keys: ${input.keys.join(", ")}`]),
  ].join("\n")
}

export function smokeRunResultSummary(input: Awaited<ReturnType<typeof runSmokePlan>>) {
  const logsRuntimeWorker = input.steps.some((step) => step.command.includes("runtime-worker"))
  return [
    `Cloud Runtime Docker smoke run: ${input.ok ? "passed" : "failed"}`,
    ...input.steps.flatMap((step) => [
      `[${step.status}] ${step.name} attempts=${step.attempts}: ${step.command}`,
      ...summaryLines(step.stdout).map((line) => `  stdout: ${line}`),
      ...smokeWorkflowEvidenceLines(step),
      ...summaryLines(step.stderr).map((line) => `  stderr: ${line}`),
      ...smokeSuggestion({ ...step, logsRuntimeWorker }),
    ]),
  ].join("\n")
}

function skippedStep(input: ReturnType<typeof smokeRunPlan>["steps"][number]) {
  return {
    name: input.name,
    phase: input.phase,
    command: input.command,
    status: "skipped" as const,
    attempts: 0,
    stdout: "",
    stderr: "",
  }
}

export async function runSmokePlan(input: {
  plan: ReturnType<typeof smokeRunPlan>
  run: (step: ReturnType<typeof smokeRunPlan>["steps"][number]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  sleep?: (ms: number) => Promise<void>
  progress?: (line: string) => void
}) {
  async function runStep(step: ReturnType<typeof smokeRunPlan>["steps"][number]) {
    const attempts = "retries" in step ? step.retries : 1
    async function attempt(remaining: number, count: number): Promise<{ ok: boolean; stdout: string; stderr: string; attempts: number }> {
      const result = await input.run(step)
      if (result.ok || remaining <= 1) return { ...result, attempts: count }
      await (input.sleep ?? Bun.sleep)("intervalMS" in step && step.intervalMS ? step.intervalMS : 0)
      return attempt(remaining - 1, count + 1)
    }
    const result = await attempt(attempts ?? 1, 1)
    input.progress?.(`${result.ok ? "passed" : "failed"} ${step.name} attempts=${result.attempts}`)
    return {
      name: step.name,
      phase: step.phase,
      command: step.command,
      status: result.ok ? "passed" as const : "failed" as const,
      attempts: result.attempts,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }

  const state = await input.plan.steps.reduce(
    async (previous, step) => {
      const current = await previous
      if (step.phase === "diagnose" && !current.failed) {
        input.progress?.(`skipped ${step.name}`)
        return { ...current, steps: [...current.steps, skippedStep(step)] }
      }
      if (current.failed && step.phase !== "diagnose" && step.phase !== "cleanup") {
        input.progress?.(`skipped ${step.name}`)
        return { ...current, steps: [...current.steps, skippedStep(step)] }
      }
      input.progress?.(`start ${step.name}: ${step.command}`)
      const result = await runStep(step)
      return {
        failed: current.failed || result.status === "failed",
        steps: [...current.steps, result],
      }
    },
    Promise.resolve({
      failed: false,
      steps: [] as Array<ReturnType<typeof skippedStep> | Awaited<ReturnType<typeof runStep>>>,
    }),
  )
  return {
    ok: !state.failed,
    steps: state.steps,
  }
}

function splitCommand(input: string) {
  return input.split(" ").filter(Boolean)
}

export function bunSmokeExecutor(input?: {
  directory?: string
  spawn?: (input: { cmd: string[]; cwd: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}) {
  return async (step: ReturnType<typeof smokeRunPlan>["steps"][number]) => {
    const result = await (input?.spawn ?? (async (spawnInput) => {
      const proc = Bun.spawn(spawnInput.cmd, {
        cwd: spawnInput.cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      return {
        exitCode: await proc.exited,
        stdout: await new Response(proc.stdout).text(),
        stderr: await new Response(proc.stderr).text(),
      }
    }))({
      cmd: "args" in step && Array.isArray(step.args) ? step.args : splitCommand(step.command),
      cwd: input?.directory ?? ".cloud-runtime",
    })
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }
}

export function smokeRunEvidence(input: {
  directory: string
  confirmed: boolean
  staticCheck: Awaited<ReturnType<typeof checkDirectory>>
  model?: ReturnType<typeof modelPreflight>
  plan?: ReturnType<typeof smokeRunPlan>
  result?: Awaited<ReturnType<typeof runSmokePlan>>
}) {
  return {
    schemaVersion: 1,
    status: input.result ? "docker_smoke_run_evidence" : "docker_smoke_preflight_evidence",
    directory: input.directory,
    confirmed: input.confirmed,
    staticCheck: {
      ok: input.staticCheck.ok,
      checks: input.staticCheck.checks,
    },
    ...(input.model
      ? {
          modelPreflight: {
            ok: input.model.ok,
            checks: input.model.checks,
            keys: input.model.keys,
          },
        }
      : {}),
    ...(input.plan
      ? {
          plan: {
            timeoutMS: input.plan.timeoutMS,
            steps: input.plan.steps.map((step) => ({
              name: step.name,
              phase: step.phase,
              command: step.command,
            })),
          },
        }
      : {}),
    ...(input.result
      ? {
          smoke: {
            ok: input.result.ok,
            steps: input.result.steps,
          },
        }
      : {}),
  }
}

export function smokeRunEvidenceSummary(input: ReturnType<typeof smokeRunEvidence>) {
  return `${JSON.stringify(input, undefined, 2)}\n`
}

export async function bundleCLI(input?: {
  directory?: string
  env?: Record<string, string | undefined>
  run?: (step: ReturnType<typeof smokeRunPlan>["steps"][number]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  progress?: (line: string) => void
}) {
  const env = input?.env ?? Bun.env
  const directory = input?.directory ?? ".cloud-runtime-shared-production"
  const config = cliConfig({ argv: ["bun", "src/cloud/local-docker.ts", directory], env })
  const written = await writeFiles({
    directory,
    ...(config.storageBackend ? { storageBackend: config.storageBackend } : {}),
    ...(config.workerExecutionMode ? { workerExecutionMode: config.workerExecutionMode } : {}),
    ...(config.imageProfile ? { imageProfile: config.imageProfile } : {}),
    ...(config.runtimeCapabilityProfile ? { runtimeCapabilityProfile: config.runtimeCapabilityProfile } : {}),
    ...(config.workerExecutionTimeoutMS ? { workerExecutionTimeoutMS: config.workerExecutionTimeoutMS } : {}),
    ...(config.workerSessionCacheTTLMS ? { workerSessionCacheTTLMS: config.workerSessionCacheTTLMS } : {}),
    ...(config.modelEnvKeys ? { modelEnvKeys: config.modelEnvKeys } : {}),
    ...(config.workerRetry ? { workerRetry: config.workerRetry } : {}),
  })
  const plan = await bundlePlanForDirectory({ directory })
  if (env.CLOUD_RUNTIME_CONFIRM_DOCKER_BUNDLE !== "1") {
    return {
      exitCode: written.staticCheck.ok ? 0 : 1,
      output: [
        cliSummary(written),
        "",
        bundlePlanSummary(plan),
      ].join("\n"),
    }
  }
  if (!written.staticCheck.ok) {
    return {
      exitCode: 1,
      output: checkSummary(written.staticCheck),
    }
  }
  const result = await runSmokePlan({
    plan,
    run: input?.run ?? bunSmokeExecutor({ directory }),
    progress: input?.progress,
  })
  return {
    exitCode: result.ok ? 0 : 1,
    output: bundleResultSummary(result),
  }
}

export async function bundleVerifyCLI(input?: {
  directory?: string
  env?: Record<string, string | undefined>
  healthRetries?: number
  healthIntervalMS?: number
  run?: (step: ReturnType<typeof smokeRunPlan>["steps"][number]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  progress?: (line: string) => void
}) {
  const env = input?.env ?? Bun.env
  const directory = input?.directory ?? ".cloud-runtime-shared-production"
  const check = await checkDirectory({ directory })
  const plan = await bundleVerifyPlanForDirectory({
    directory,
    ...(input?.healthRetries ? { healthRetries: input.healthRetries } : {}),
    ...(input?.healthIntervalMS ? { healthIntervalMS: input.healthIntervalMS } : {}),
  })
  if (!check.ok) {
    return {
      exitCode: 1,
      output: checkSummary(check),
    }
  }
  const model = modelPreflight({
    profile: JSON.parse((check.checks.find((item) => item.name === "runtime-profile")?.detail) ?? JSON.stringify(runtimeProfile())) as ReturnType<typeof runtimeProfile>,
    env,
  })
  if (env.CLOUD_RUNTIME_CONFIRM_DOCKER_BUNDLE_VERIFY !== "1") {
    return {
      exitCode: model.ok ? 0 : 1,
      output: [
        modelPreflightSummary(model),
        "",
        bundleVerifyPlanSummary(plan),
      ].join("\n"),
    }
  }
  if (!model.ok) {
    return {
      exitCode: 1,
      output: modelPreflightSummary(model),
    }
  }
  const result = await runSmokePlan({
    plan,
    run: input?.run ?? bunSmokeExecutor({ directory }),
    progress: input?.progress,
  })
  return {
    exitCode: result.ok ? 0 : 1,
    output: bundleVerifyResultSummary(result),
  }
}

export async function smokeRunCLI(input: {
  directory: string
  env?: Record<string, string | undefined>
  evidence?: boolean
  healthRetries?: number
  healthIntervalMS?: number
  run?: (step: ReturnType<typeof smokeRunPlan>["steps"][number]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  progress?: (line: string) => void
}) {
  const check = await checkDirectory({ directory: input.directory })
  if (!check.ok) {
    if (input.evidence) {
      return {
        exitCode: 1,
        output: smokeRunEvidenceSummary(smokeRunEvidence({
          directory: input.directory,
          confirmed: (input.env ?? Bun.env).CLOUD_RUNTIME_CONFIRM_REAL_DOCKER === "1",
          staticCheck: check,
        })),
      }
    }
    return {
      exitCode: 1,
      output: checkSummary(check),
    }
  }
  const model = modelPreflight({
    profile: JSON.parse((check.checks.find((item) => item.name === "runtime-profile")?.detail) ?? JSON.stringify(runtimeProfile())) as ReturnType<typeof runtimeProfile>,
    env: input.env ?? Bun.env,
  })
  if (input.evidence && ((input.env ?? Bun.env).CLOUD_RUNTIME_CONFIRM_REAL_DOCKER !== "1" || !model.ok)) {
    return {
      exitCode: model.ok ? 0 : 1,
      output: smokeRunEvidenceSummary(smokeRunEvidence({
        directory: input.directory,
        confirmed: (input.env ?? Bun.env).CLOUD_RUNTIME_CONFIRM_REAL_DOCKER === "1",
        staticCheck: check,
        model,
        plan: await smokeRunPlanForDirectory({
          directory: input.directory,
          ...(input.healthRetries ? { healthRetries: input.healthRetries } : {}),
          ...(input.healthIntervalMS ? { healthIntervalMS: input.healthIntervalMS } : {}),
        }),
      })),
    }
  }
  if ((input.env ?? Bun.env).CLOUD_RUNTIME_CONFIRM_REAL_DOCKER !== "1") {
    return {
      exitCode: 1,
      output: [
        "Cloud Runtime Docker smoke confirmation: failed",
        "[failed] real-docker-confirmation: set CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 to run real Docker smoke",
      ].join("\n"),
    }
  }
  if (!model.ok) {
    return {
      exitCode: 1,
      output: modelPreflightSummary(model),
    }
  }
  const plan = await smokeRunPlanForDirectory({
    directory: input.directory,
    ...(input.healthRetries ? { healthRetries: input.healthRetries } : {}),
    ...(input.healthIntervalMS ? { healthIntervalMS: input.healthIntervalMS } : {}),
    skipBuild: (input.env ?? Bun.env).CLOUD_RUNTIME_DOCKER_SKIP_BUILD === "1",
  })
  const result = await runSmokePlan({
    plan,
    run: input.run ?? bunSmokeExecutor({ directory: input.directory }),
    progress: input.evidence ? undefined : input.progress,
  })
  if (input.evidence) {
    return {
      exitCode: result.ok ? 0 : 1,
      output: smokeRunEvidenceSummary(smokeRunEvidence({
        directory: input.directory,
        confirmed: true,
        staticCheck: check,
        model,
        plan,
        result,
      })),
    }
  }
  return {
    exitCode: result.ok ? 0 : 1,
    output: smokeRunResultSummary(result),
  }
}

export function cliMode(input?: {
  argv?: string[]
}) {
  if (input?.argv?.includes("--check")) return "check"
  if (input?.argv?.includes("--bundle-verify")) return "bundle-verify"
  if (input?.argv?.includes("--bundle")) return "bundle"
  if (input?.argv?.includes("--k8s-e2e-evidence")) return "k8s-e2e-evidence"
  if (input?.argv?.includes("--k8s-e2e")) return "k8s-e2e"
  if (input?.argv?.includes("--e2e-evidence")) return "e2e-evidence"
  if (input?.argv?.includes("--e2e")) return "e2e"
  if (input?.argv?.includes("--smoke-evidence")) return "smoke-evidence"
  if (input?.argv?.includes("--smoke-run")) return "smoke-run"
  if (input?.argv?.includes("--smoke")) return "smoke"
  return "write"
}

export function cliConfig(input?: {
  argv?: string[]
  env?: Record<string, string | undefined>
}) {
  const env = input?.env ?? Bun.env
  const mode =
    env.CLOUD_RUNTIME_EXECUTION_MODE === "simulate" ||
    env.CLOUD_RUNTIME_EXECUTION_MODE === "opencode" ||
    env.CLOUD_RUNTIME_EXECUTION_MODE === "kubernetes" ||
    env.CLOUD_RUNTIME_EXECUTION_MODE === "shared-session"
      ? env.CLOUD_RUNTIME_EXECUTION_MODE
      : undefined
  const storageBackend: "postgres" | "sqlite" | undefined = env.CLOUD_RUNTIME_STORAGE_BACKEND === "postgres"
    ? "postgres"
    : env.CLOUD_RUNTIME_STORAGE_BACKEND === "sqlite"
      ? "sqlite"
      : undefined
  const selectedImageProfile = env.CLOUD_RUNTIME_IMAGE_PROFILE === "production-install" ? "production-install" : undefined
  const selectedRuntimeCapabilityProfile =
    env.CLOUD_RUNTIME_CAPABILITY_PROFILE === "minimal" ||
    env.CLOUD_RUNTIME_CAPABILITY_PROFILE === "standard" ||
    env.CLOUD_RUNTIME_CAPABILITY_PROFILE === "heavy"
      ? env.CLOUD_RUNTIME_CAPABILITY_PROFILE
      : undefined
  const directory = input?.argv?.slice(2).find((item) => !item.startsWith("--"))
  return {
    directory: directory ?? env.CLOUD_RUNTIME_DOCKER_DIR ?? ".cloud-runtime",
    ...(storageBackend ? { storageBackend } : {}),
    ...(selectedImageProfile ? { imageProfile: selectedImageProfile as ImageProfile } : {}),
    ...(selectedRuntimeCapabilityProfile ? { runtimeCapabilityProfile: selectedRuntimeCapabilityProfile as RuntimeCapabilityProfile } : {}),
    ...(mode ? { workerExecutionMode: mode as ExecutionMode } : {}),
    ...(env.CLOUD_RUNTIME_K8S_SERVER_URL
      ? {
          workerKubernetes: {
            serverURL: env.CLOUD_RUNTIME_K8S_SERVER_URL,
            ...(env.CLOUD_RUNTIME_K8S_TOKEN ? { token: env.CLOUD_RUNTIME_K8S_TOKEN } : {}),
            ...(number(env.CLOUD_RUNTIME_K8S_POLL_INTERVAL_MS)
              ? { pollIntervalMS: number(env.CLOUD_RUNTIME_K8S_POLL_INTERVAL_MS) }
              : {}),
            ...(number(env.CLOUD_RUNTIME_K8S_MAX_POLLS) ? { maxPolls: number(env.CLOUD_RUNTIME_K8S_MAX_POLLS) } : {}),
          },
        }
      : {}),
    ...(number(env.CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS)
      ? { workerExecutionTimeoutMS: number(env.CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS) }
      : {}),
    ...(number(env.CLOUD_RUNTIME_SESSION_CACHE_TTL_MS)
      ? { workerSessionCacheTTLMS: number(env.CLOUD_RUNTIME_SESSION_CACHE_TTL_MS) }
      : {}),
    ...(env.CLOUD_RUNTIME_MODEL_ENV_KEYS ? { modelEnvKeys: modelEnvKeys(env.CLOUD_RUNTIME_MODEL_ENV_KEYS) } : {}),
    ...(number(env.CLOUD_RUNTIME_RETRY_MAX_ATTEMPTS)
      ? {
          workerRetry: {
            maxAttempts: number(env.CLOUD_RUNTIME_RETRY_MAX_ATTEMPTS)!,
            baseDelayMS: number(env.CLOUD_RUNTIME_RETRY_BASE_DELAY_MS) ?? 1_000,
            maxDelayMS: number(env.CLOUD_RUNTIME_RETRY_MAX_DELAY_MS) ?? 30_000,
          },
        }
      : {}),
  }
}

export async function e2eCLI(input?: {
  directory?: string
  env?: Record<string, string | undefined>
  evidence?: boolean
  run?: (step: ReturnType<typeof smokeRunPlan>["steps"][number]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  progress?: (line: string) => void
}) {
  const env = input?.env ?? Bun.env
  const directory = input?.directory ?? ".cloud-runtime-shared"
  const config = cliConfig({ argv: ["bun", "src/cloud/local-docker.ts", directory], env })
  const written = await writeFiles({
    directory,
    storageBackend: "postgres",
    workerExecutionMode: "shared-session",
    ...(config.imageProfile ? { imageProfile: config.imageProfile } : {}),
    ...(config.runtimeCapabilityProfile ? { runtimeCapabilityProfile: config.runtimeCapabilityProfile } : {}),
    ...(config.workerExecutionTimeoutMS ? { workerExecutionTimeoutMS: config.workerExecutionTimeoutMS } : {}),
    ...(config.workerSessionCacheTTLMS ? { workerSessionCacheTTLMS: config.workerSessionCacheTTLMS } : {}),
    ...(config.modelEnvKeys ? { modelEnvKeys: config.modelEnvKeys } : {}),
    ...(config.workerRetry ? { workerRetry: config.workerRetry } : {}),
  })
  const plan = await smokeRunPlanForDirectory({
    directory,
    skipBuild: env.CLOUD_RUNTIME_DOCKER_SKIP_BUILD === "1",
  })
  if (env.CLOUD_RUNTIME_CONFIRM_REAL_DOCKER !== "1") {
    const output = {
      schemaVersion: 1,
      status: "docker_e2e_plan",
      directory,
      confirmed: false,
      staticCheck: written.staticCheck,
      plan,
    }
    return {
      exitCode: written.staticCheck.ok ? 0 : 1,
      output: input?.evidence
        ? `${JSON.stringify(output, undefined, 2)}\n`
        : [
            cliSummary(written),
            "",
            smokeRunSummary(plan),
            "",
            "Real run:",
            `  CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e`,
            "BYOK run:",
            `  CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_SMOKE_BYOK_SECRET=$ANTHROPIC_API_KEY CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e`,
          ].join("\n"),
    }
  }
  const result = await smokeRunCLI({
    directory,
    env,
    evidence: input?.evidence,
    ...(input?.run ? { run: input.run } : {}),
    progress: input?.progress,
  })
  return {
    exitCode: result.exitCode,
    output: input?.evidence
      ? result.output
      : [
          cliSummary(written),
          "",
          result.output,
        ].join("\n"),
  }
}

export async function kubernetesE2ECLI(input?: {
  directory?: string
  env?: Record<string, string | undefined>
  evidence?: boolean
  run?: (step: ReturnType<typeof smokeRunPlan>["steps"][number]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  progress?: (line: string) => void
}) {
  const env = input?.env ?? Bun.env
  const directory = input?.directory ?? ".cloud-runtime-k8s-worker"
  const config = cliConfig({ argv: ["bun", "src/cloud/local-docker.ts", directory], env })
  const serverURL = env.CLOUD_RUNTIME_K8S_SERVER_URL ?? "http://host.docker.internal:18001"
  const written = await writeFiles({
    directory,
    storageBackend: "postgres",
    workerExecutionMode: "kubernetes",
    ...(config.imageProfile ? { imageProfile: config.imageProfile } : {}),
    ...(config.runtimeCapabilityProfile ? { runtimeCapabilityProfile: config.runtimeCapabilityProfile } : {}),
    ...(config.workerExecutionTimeoutMS ? { workerExecutionTimeoutMS: config.workerExecutionTimeoutMS } : {}),
    ...(config.workerSessionCacheTTLMS ? { workerSessionCacheTTLMS: config.workerSessionCacheTTLMS } : {}),
    ...(config.modelEnvKeys ? { modelEnvKeys: config.modelEnvKeys } : {}),
    ...(config.workerRetry ? { workerRetry: config.workerRetry } : {}),
    workerKubernetes: {
      serverURL,
      ...(env.CLOUD_RUNTIME_K8S_TOKEN ? { token: env.CLOUD_RUNTIME_K8S_TOKEN } : {}),
      ...(number(env.CLOUD_RUNTIME_K8S_POLL_INTERVAL_MS) ? { pollIntervalMS: number(env.CLOUD_RUNTIME_K8S_POLL_INTERVAL_MS) } : {}),
      ...(number(env.CLOUD_RUNTIME_K8S_MAX_POLLS) ? { maxPolls: number(env.CLOUD_RUNTIME_K8S_MAX_POLLS) } : {}),
    },
  })
  const plan = await smokeRunPlanForDirectory({
    directory,
    skipBuild: env.CLOUD_RUNTIME_DOCKER_SKIP_BUILD === "1",
  })
  if (env.CLOUD_RUNTIME_CONFIRM_REAL_DOCKER !== "1") {
    const output = {
      schemaVersion: 1,
      status: "docker_kubernetes_e2e_plan",
      directory,
      confirmed: false,
      staticCheck: written.staticCheck,
      plan,
    }
    return {
      exitCode: written.staticCheck.ok ? 0 : 1,
      output: input?.evidence
        ? `${JSON.stringify(output, undefined, 2)}\n`
        : [
            cliSummary(written),
            "",
            smokeRunSummary(plan),
            "",
            "Kubernetes worker profile:",
            `  CLOUD_RUNTIME_K8S_SERVER_URL=${serverURL}`,
            "Real run:",
            "  CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:k8s:e2e",
          ].join("\n"),
    }
  }
  const result = await smokeRunCLI({
    directory,
    env,
    evidence: input?.evidence,
    ...(input?.run ? { run: input.run } : {}),
    progress: input?.progress,
  })
  return {
    exitCode: result.exitCode,
    output: input?.evidence
      ? result.output
      : [
          cliSummary(written),
          "",
          result.output,
        ].join("\n"),
  }
}

if (import.meta.main) {
  if (cliMode({ argv: Bun.argv }) === "check") {
    const result = await checkCLI({
      directory: cliConfig({ argv: Bun.argv, env: Bun.env }).directory,
    })
    console.log(result.output)
    process.exit(result.exitCode)
  }
  if (cliMode({ argv: Bun.argv }) === "bundle") {
    const result = await bundleCLI({
      directory: cliConfig({ argv: Bun.argv, env: Bun.env }).directory,
      env: Bun.env,
      progress: (line) => console.error(`[cloud:docker] ${line}`),
    })
    console.log(result.output)
    process.exit(result.exitCode)
  }
  if (cliMode({ argv: Bun.argv }) === "bundle-verify") {
    const result = await bundleVerifyCLI({
      directory: cliConfig({ argv: Bun.argv, env: Bun.env }).directory,
      env: Bun.env,
      progress: (line) => console.error(`[cloud:docker] ${line}`),
    })
    console.log(result.output)
    process.exit(result.exitCode)
  }
  if (cliMode({ argv: Bun.argv }) === "e2e" || cliMode({ argv: Bun.argv }) === "e2e-evidence") {
    const result = await e2eCLI({
      directory: cliConfig({ argv: Bun.argv, env: Bun.env }).directory,
      env: Bun.env,
      evidence: cliMode({ argv: Bun.argv }) === "e2e-evidence",
      progress: (line) => console.error(`[cloud:docker] ${line}`),
    })
    console.log(result.output)
    process.exit(result.exitCode)
  }
  if (cliMode({ argv: Bun.argv }) === "k8s-e2e" || cliMode({ argv: Bun.argv }) === "k8s-e2e-evidence") {
    const result = await kubernetesE2ECLI({
      directory: cliConfig({ argv: Bun.argv, env: Bun.env }).directory,
      env: Bun.env,
      evidence: cliMode({ argv: Bun.argv }) === "k8s-e2e-evidence",
      progress: (line) => console.error(`[cloud:docker] ${line}`),
    })
    console.log(result.output)
    process.exit(result.exitCode)
  }
  if (cliMode({ argv: Bun.argv }) === "smoke") {
    const result = await smokeCLI({
      directory: cliConfig({ argv: Bun.argv, env: Bun.env }).directory,
    })
    console.log(result.output)
    process.exit(result.exitCode)
  }
  if (cliMode({ argv: Bun.argv }) === "smoke-run") {
    const result = await smokeRunCLI({
      directory: cliConfig({ argv: Bun.argv, env: Bun.env }).directory,
      progress: (line) => console.error(`[cloud:docker] ${line}`),
    })
    console.log(result.output)
    process.exit(result.exitCode)
  }
  if (cliMode({ argv: Bun.argv }) === "smoke-evidence") {
    const result = await smokeRunCLI({
      directory: cliConfig({ argv: Bun.argv, env: Bun.env }).directory,
      env: Bun.env,
      evidence: true,
    })
    console.log(result.output)
    process.exit(result.exitCode)
  }
  const result = await writeFiles(cliConfig({ argv: Bun.argv, env: Bun.env }))
  console.log(cliSummary(result))
}

export * as CloudLocalDocker from "./local-docker"
