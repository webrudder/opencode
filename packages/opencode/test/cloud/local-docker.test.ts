import { describe, expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import os from "os"
import path from "path"
import { CloudLocalDocker } from "../../src/cloud/local-docker"
import { CloudSQLiteServer } from "../../src/cloud/sqlite-server"
import { runOnce } from "../../src/cloud/local-worker"
import { CloudSQLiteRepository } from "../../src/cloud/sqlite-repository"

describe("CloudLocalDocker", () => {
  test("plans a local Docker Compose topology for the runtime MVP", () => {
    const result = CloudLocalDocker.compose({
      apiImage: "local/api:dev",
      workerImage: "local/worker:dev",
      runtimeImage: "local/opencode:1.14.28",
      workerExecutionMode: "simulate",
    })

    expect(Object.keys(result.services)).toEqual(["postgres", "minio", "minio-init", "redis", "api", "worker"])
    expect(result.services["minio-init"]).toMatchObject({
      image: "minio/mc:latest",
      entrypoint: ["/bin/sh", "-c"],
      command: [
        "until mc alias set local http://minio:9000 opencode opencode-password; do sleep 1; done; mc mb --ignore-existing local/runtime-artifacts",
      ],
      depends_on: ["minio"],
    })
    expect(result.services.api).toMatchObject({
      image: "local/api:dev",
      command: "bun run ./src/cloud/local-api.ts",
      ports: ["8787:8787"],
      environment: {
        CLOUD_RUNTIME_STORAGE: "sqlite",
        CLOUD_RUNTIME_SQLITE_PATH: "/data/cloud-runtime.sqlite",
      },
      volumes: ["cloud-runtime-db:/data"],
      depends_on: {
        postgres: { condition: "service_healthy" },
        minio: { condition: "service_started" },
        "minio-init": { condition: "service_completed_successfully" },
        redis: { condition: "service_started" },
      },
    })
    expect(result.services.worker).toMatchObject({
      image: "local/worker:dev",
      command: "bun run ./src/cloud/local-worker.ts",
      environment: {
        CLOUD_RUNTIME_SANDBOX_MODE: "docker",
        CLOUD_RUNTIME_SANDBOX_IMAGE: "local/opencode:1.14.28",
        CLOUD_RUNTIME_SQLITE_PATH: "/data/cloud-runtime.sqlite",
        CLOUD_RUNTIME_EXECUTION_MODE: "simulate",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
      },
      volumes: [
        "/var/run/docker.sock:/var/run/docker.sock",
        "cloud-worker-cache:/tmp/cloud-runtime",
        "${CLOUD_RUNTIME_SKILLS_DIR:-./skills}:/runtime/skills:ro",
        "cloud-runtime-db:/data",
      ],
    })
    expect(result.services.worker.volumes).toContain("${CLOUD_RUNTIME_SKILLS_DIR:-./skills}:/runtime/skills:ro")
    expect(result.volumes).toMatchObject({ "cloud-runtime-db": {} })
  })

  test("waits for PostgreSQL and MinIO bucket initialization before starting runtime services", () => {
    const result = CloudLocalDocker.compose({
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })

    expect(result.services.postgres.healthcheck).toMatchObject({
      test: ["CMD-SHELL", "pg_isready -U opencode -d cloud_runtime"],
    })
    expect(result.services.postgres.ports).toEqual(["${CLOUD_RUNTIME_POSTGRES_PORT:-55432}:5432"])
    expect(result.services.api.depends_on).toMatchObject({
      postgres: { condition: "service_healthy" },
      "minio-init": { condition: "service_completed_successfully" },
    })
    expect(result.services.worker.depends_on).toMatchObject({
      postgres: { condition: "service_healthy" },
      "minio-init": { condition: "service_completed_successfully" },
      "runtime-worker": { condition: "service_started" },
    })
    expect(result.services["runtime-worker"]?.depends_on).toMatchObject({
      postgres: { condition: "service_healthy" },
      "minio-init": { condition: "service_completed_successfully" },
    })
  })

  test("keeps service startup order explicit", () => {
    expect(CloudLocalDocker.startupOrder(CloudLocalDocker.compose())).toEqual([
      "postgres",
      "minio",
      "minio-init",
      "redis",
      "api",
      "worker",
    ])
  })

  test("renders a deterministic local env file for API and worker development", () => {
    expect(CloudLocalDocker.envFile()).toBe(
      [
        "CLOUD_RUNTIME_ALLOWED_SKILLS=${CLOUD_RUNTIME_ALLOWED_SKILLS:-}",
        "CLOUD_RUNTIME_DATABASE_URL=postgres://opencode:opencode@postgres:5432/cloud_runtime",
        "CLOUD_RUNTIME_DEFAULT_VERSION=1.14.28",
        "CLOUD_RUNTIME_ENVIRONMENT=dev",
        "CLOUD_RUNTIME_HTTP_PORT=8787",
        "CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID=opencode",
        "CLOUD_RUNTIME_OBJECT_BUCKET=runtime-artifacts",
        "CLOUD_RUNTIME_OBJECT_ENDPOINT=http://minio:9000",
        "CLOUD_RUNTIME_OBJECT_REGION=us-east-1",
        "CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY=opencode-password",
        "CLOUD_RUNTIME_QUEUE=cloud-runtime-jobs",
        "CLOUD_RUNTIME_REDIS_URL=redis://redis:6379/0",
        "CLOUD_RUNTIME_SKILL_CATALOG_JSON=${CLOUD_RUNTIME_SKILL_CATALOG_JSON:-}",
        "CLOUD_RUNTIME_SQLITE_PATH=/data/cloud-runtime.sqlite",
        "CLOUD_RUNTIME_STORAGE=sqlite",
        "OTEL_SERVICE_NAME=cloud-opencode-runtime-api",
      ].join("\n"),
    )
  })

  test("can render worker environment for simulated local execution", () => {
    expect(CloudLocalDocker.envFile({ target: "worker", workerExecutionMode: "simulate" })).toContain(
      "CLOUD_RUNTIME_EXECUTION_MODE=simulate",
    )
  })

  test("can render worker environment for real local opencode execution", () => {
    expect(CloudLocalDocker.envFile({ target: "worker", workerExecutionMode: "opencode" })).toContain(
      "CLOUD_RUNTIME_EXECUTION_MODE=opencode",
    )
  })

  test("passes model selection and provider credentials through worker containers", () => {
    const worker = CloudLocalDocker.compose({ workerExecutionMode: "opencode" }).services.worker.environment
    const runtimeWorker = CloudLocalDocker.compose({
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    }).services["runtime-worker"]?.environment

    expect(worker).toMatchObject({
      CLOUD_RUNTIME_MODEL_PROVIDER: "${CLOUD_RUNTIME_MODEL_PROVIDER:-}",
      CLOUD_RUNTIME_MODEL: "${CLOUD_RUNTIME_MODEL:-}",
      CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE: "${CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE:-}",
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY:-}",
      OPENAI_API_KEY: "${OPENAI_API_KEY:-}",
    })
    expect(runtimeWorker).toMatchObject({
      CLOUD_RUNTIME_MODEL_PROVIDER: "${CLOUD_RUNTIME_MODEL_PROVIDER:-}",
      CLOUD_RUNTIME_MODEL: "${CLOUD_RUNTIME_MODEL:-}",
      CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE: "${CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE:-}",
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY:-}",
      OPENAI_API_KEY: "${OPENAI_API_KEY:-}",
    })
  })

  test("allows custom model credential environment keys for Docker passthrough", () => {
    expect(
      CloudLocalDocker.compose({
        workerExecutionMode: "opencode",
        modelEnvKeys: ["CUSTOM_LLM_API_KEY"],
      }).services.worker.environment,
    ).toMatchObject({
      CUSTOM_LLM_API_KEY: "${CUSTOM_LLM_API_KEY:-}",
    })
    const config = CloudLocalDocker.cliConfig({
      argv: ["bun", "src/cloud/local-docker.ts", ".cloud-runtime-custom"],
      env: {
        CLOUD_RUNTIME_MODEL_ENV_KEYS: "CUSTOM_LLM_API_KEY,SECOND_TOKEN",
      },
    })

    expect(config.modelEnvKeys).toContain("CUSTOM_LLM_API_KEY")
    expect(config.modelEnvKeys).toContain("SECOND_TOKEN")
  })

  test("defaults local Docker runtime to the shared session pool worker mode", () => {
    const result = CloudLocalDocker.files()

    expect(JSON.parse(result["runtime-profile.json"])).toMatchObject({
      workerExecutionMode: "shared-session",
    })
    expect(result["worker.env"]).toContain("CLOUD_RUNTIME_EXECUTION_MODE=shared-session")
    expect(result["README.md"]).toContain("Worker execution: shared-session")
  })

  test("builds CLI config for shared session pool Docker workers", () => {
    expect(
      CloudLocalDocker.cliConfig({
        argv: ["bun", "src/cloud/local-docker.ts", "/tmp/cloud-runtime-shared"],
        env: {
          CLOUD_RUNTIME_EXECUTION_MODE: "shared-session",
          CLOUD_RUNTIME_SESSION_CACHE_TTL_MS: "1800000",
        },
      }),
    ).toEqual({
      directory: "/tmp/cloud-runtime-shared",
      workerExecutionMode: "shared-session",
      workerSessionCacheTTLMS: 1800000,
    })
  })

  test("can render worker environment for Kubernetes execution", () => {
    const env = CloudLocalDocker.envFile({
      target: "worker",
      workerExecutionMode: "kubernetes",
      workerKubernetes: {
        serverURL: "https://kubernetes.example",
        token: "token_123",
        pollIntervalMS: 250,
        maxPolls: 10,
      },
    })

    expect(env).toContain("CLOUD_RUNTIME_EXECUTION_MODE=kubernetes")
    expect(env).toContain("CLOUD_RUNTIME_K8S_SERVER_URL=https://kubernetes.example")
    expect(env).toContain("CLOUD_RUNTIME_K8S_TOKEN=token_123")
    expect(env).toContain("CLOUD_RUNTIME_K8S_POLL_INTERVAL_MS=250")
    expect(env).toContain("CLOUD_RUNTIME_K8S_MAX_POLLS=10")
  })

  test("can render a PostgreSQL-backed API and worker topology", () => {
    const result = CloudLocalDocker.compose({
      storageBackend: "postgres",
      workerExecutionMode: "kubernetes",
      workerKubernetes: { serverURL: "https://kubernetes.example" },
    })

    expect(result.services.api).toMatchObject({
      command: "bun run ./src/cloud/local-api.ts",
      environment: {
        CLOUD_RUNTIME_STORAGE: "postgres",
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:opencode@postgres:5432/cloud_runtime",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://minio:9000",
        CLOUD_RUNTIME_OBJECT_REGION: "us-east-1",
        CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID: "opencode",
        CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY: "opencode-password",
      },
    })
    expect(result.services.worker).toMatchObject({
      command: "bun run ./src/cloud/postgres-worker.ts",
      environment: {
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:opencode@postgres:5432/cloud_runtime",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://minio:9000",
        CLOUD_RUNTIME_OBJECT_REGION: "us-east-1",
        CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID: "opencode",
        CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY: "opencode-password",
        CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example",
      },
    })
  })

  test("omits empty API volumes from PostgreSQL Docker Compose YAML", () => {
    expect(
      CloudLocalDocker.composeYAML({
        storageBackend: "postgres",
        workerExecutionMode: "shared-session",
      }),
    ).not.toContain("volumes:\n\n    depends_on:")
  })

  test("omits obsolete Docker Compose version", () => {
    expect(CloudLocalDocker.composeYAML()).toStartWith("services:")
    expect(CloudLocalDocker.composeYAML()).not.toContain("version:")
  })

  test("adds a runtime worker endpoint service for PostgreSQL shared-session mode", () => {
    const result = CloudLocalDocker.compose({
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })

    expect(result.services["runtime-worker"]).toMatchObject({
      command: "bun run ./src/cloud/runtime-worker-server.ts",
      ports: ["8788:8788"],
      environment: {
        CLOUD_RUNTIME_ID: "runtime-local-1",
        CLOUD_RUNTIME_ENDPOINT: "http://runtime-worker:8788",
        CLOUD_RUNTIME_TENANT_ID: "tenant_local",
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:opencode@postgres:5432/cloud_runtime",
      },
      depends_on: {
        postgres: { condition: "service_healthy" },
        "minio-init": { condition: "service_completed_successfully" },
      },
    })
    expect(result.services.worker.depends_on).toMatchObject({
      "runtime-worker": { condition: "service_started" },
    })
    expect(CloudLocalDocker.startupOrder(result)).toContain("runtime-worker")
  })

  test("renders shared-session Docker diagnostics for the runtime worker endpoint", () => {
    const result = CloudLocalDocker.files({
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })
    const plan = CloudLocalDocker.smokePlan({
      files: result,
      commands: CloudLocalDocker.commands({ includeRuntimeWorker: true }),
    })

    expect(CloudLocalDocker.commands({ includeRuntimeWorker: true }).logs).toBe(
      "docker compose logs -f api worker runtime-worker",
    )
    expect(result["README.md"]).toContain("docker compose logs -f api worker runtime-worker")
    expect(plan.checks.find((item) => item.name === "runtime-worker-service")).toMatchObject({
      status: "passed",
      detail: "docker-compose.yml exposes runtime-worker for shared-session execution",
    })
  })

  test("checks PostgreSQL Docker storage wiring in the smoke plan", () => {
    const result = CloudLocalDocker.smokePlan({
      files: CloudLocalDocker.files({ storageBackend: "postgres" }),
      commands: CloudLocalDocker.commands(),
    })

    expect(result.checks.map((item) => item.name)).toContain("postgres-storage-env")
    expect(result.checks.find((item) => item.name === "postgres-storage-env")).toMatchObject({
      status: "passed",
      detail: "PostgreSQL API and worker use S3-compatible object storage env",
    })
    expect(result.checks.find((item) => item.name === "minio-bucket-init")).toMatchObject({
      status: "passed",
      detail: "docker-compose.yml initializes runtime-artifacts bucket",
    })
  })

  test("can render worker timeout and retry environment", () => {
    expect(
      CloudLocalDocker.envFile({
        target: "worker",
        workerExecutionMode: "opencode",
        workerExecutionTimeoutMS: 900000,
        workerSessionCacheTTLMS: 1800000,
        workerRetry: { maxAttempts: 3, baseDelayMS: 1000, maxDelayMS: 30000 },
      }),
    ).toContain("CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS=900000")
    expect(
      CloudLocalDocker.envFile({
        target: "worker",
        workerExecutionMode: "shared-session",
        workerSessionCacheTTLMS: 1800000,
      }),
    ).toContain("CLOUD_RUNTIME_SESSION_CACHE_TTL_MS=1800000")
    expect(
      CloudLocalDocker.envFile({
        target: "worker",
        workerRetry: { maxAttempts: 3, baseDelayMS: 1000, maxDelayMS: 30000 },
      }),
    ).toContain("CLOUD_RUNTIME_RETRY_MAX_ATTEMPTS=3")
  })

  test("can render OTEL environment for local Docker services", () => {
    expect(
      CloudLocalDocker.envFile({
        target: "worker",
        otelEndpoint: "http://otel-collector:4318/v1/metrics",
        otelHeaders: "authorization=Bearer local-token",
      }),
    ).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318/v1/metrics")
    expect(
      CloudLocalDocker.envFile({
        target: "worker",
        otelEndpoint: "http://otel-collector:4318/v1/metrics",
        otelHeaders: "authorization=Bearer local-token",
      }),
    ).toContain("OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer local-token")
    expect(
      CloudLocalDocker.envFile({
        target: "api",
        otelEndpoint: "http://otel-collector:4318/v1/metrics",
      }),
    ).toContain("OTEL_SERVICE_NAME=cloud-opencode-runtime-api")
  })

  test("renders Docker Compose JSON for local docker compose usage", () => {
    expect(JSON.parse(CloudLocalDocker.composeJSON())).toMatchObject({
      services: {
        api: { ports: ["8787:8787"] },
        worker: {
          environment: {
            CLOUD_RUNTIME_SANDBOX_MODE: "docker",
            OPENCODE_DISABLE_AUTOUPDATE: "true",
          },
        },
        postgres: { image: "postgres:16-alpine" },
        minio: { ports: ["9000:9000", "9001:9001"] },
        redis: { image: "redis:7-alpine" },
      },
    })
  })

  test("renders local Docker deployment files and commands", () => {
    const result = CloudLocalDocker.files({
      workerExecutionMode: "opencode",
      workerExecutionTimeoutMS: 900000,
      workerRetry: { maxAttempts: 3, baseDelayMS: 1000, maxDelayMS: 30000 },
    })

    expect(Object.keys(result)).toEqual([
      "docker-compose.yml",
      "api.env",
      "worker.env",
      "Dockerfile.cloud-api",
      "Dockerfile.cloud-api.dockerignore",
      "Dockerfile.cloud-worker",
      "Dockerfile.cloud-worker.dockerignore",
      "Dockerfile.cloud-opencode-runtime",
      "Dockerfile.cloud-opencode-runtime.dockerignore",
      "smoke-api-workflow.ts",
      "runtime-profile.json",
      "REMOTE_DOCKER.md",
      "README.md",
    ])
    expect(result["docker-compose.yml"]).toContain("services:")
    expect(result["docker-compose.yml"]).toContain("CLOUD_RUNTIME_EXECUTION_MODE: opencode")
    expect(result["worker.env"]).toContain("CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS=900000")
    expect(result["Dockerfile.cloud-api"]).toContain("FROM oven/bun:1.3.14-alpine AS source")
    expect(result["Dockerfile.cloud-api"]).toContain("FROM oven/bun:1.3.14-alpine AS runtime")
    expect(result["Dockerfile.cloud-api"]).toContain("COPY --from=source --chown=bun:bun /app /app")
    expect(result["Dockerfile.cloud-api"]).not.toContain("RUN apk add --no-cache git ripgrep python3")
    expect(result["Dockerfile.cloud-api"]).not.toContain("/usr/local/bin/opencode")
    expect(result["Dockerfile.cloud-api"]).not.toContain("WORKDIR /workspace")
    expect(result["Dockerfile.cloud-api"]).not.toContain("make g++")
    expect(result["Dockerfile.cloud-api"]).toContain("COPY --chown=bun:bun . .")
    expect(result["Dockerfile.cloud-api"]).toContain("delete pkg.scripts.prepare")
    expect(result["Dockerfile.cloud-api"]).toContain("delete pkg.scripts.postinstall")
    expect(result["Dockerfile.cloud-api"]).toContain("RUN test -d node_modules && test -d packages/opencode/node_modules")
    expect(result["Dockerfile.cloud-api"]).toContain("/app/packages/opencode/test")
    expect(result["Dockerfile.cloud-api"]).toContain("/app/packages/opencode/specs")
    expect(result["Dockerfile.cloud-api"].indexOf("COPY --chown=bun:bun . .")).toBeLessThan(
      result["Dockerfile.cloud-api"].indexOf("RUN test -d node_modules && test -d packages/opencode/node_modules"),
    )
    expect(result["Dockerfile.cloud-api"]).not.toContain("chown -R bun:bun /app")
    expect(result["Dockerfile.cloud-opencode-runtime"]).toContain("USER 1000:1000")
    expect(result["Dockerfile.cloud-api"]).toContain("CMD [\"bun\", \"run\", \"./src/cloud/local-api.ts\"]")
    expect(result["Dockerfile.cloud-api.dockerignore"]).toContain(".cloud-runtime*")
    expect(result["Dockerfile.cloud-api.dockerignore"]).toContain(".bun")
    expect(result["Dockerfile.cloud-api.dockerignore"]).toContain("**/node_modules/.cache")
    expect(result["Dockerfile.cloud-api.dockerignore"]).toContain("**/node_modules/.vite")
    expect(result["Dockerfile.cloud-api.dockerignore"]).toContain("**/node_modules/.turbo")
    expect(result["Dockerfile.cloud-worker"]).toContain("CMD [\"bun\", \"run\", \"./src/cloud/local-worker.ts\"]")
    expect(result["Dockerfile.cloud-worker"]).not.toContain("/usr/local/bin/opencode")
    expect(result["Dockerfile.cloud-worker"]).not.toContain("chromium")
    expect(result["Dockerfile.cloud-worker"]).not.toContain("libreoffice")
    expect(result["Dockerfile.cloud-worker"]).not.toContain("tesseract-ocr")
    expect(result["Dockerfile.cloud-worker.dockerignore"]).toBe(result["Dockerfile.cloud-api.dockerignore"])
    expect(result["Dockerfile.cloud-opencode-runtime"]).toContain("ENTRYPOINT [\"opencode\"]")
    expect(result["Dockerfile.cloud-opencode-runtime"]).toContain("/usr/local/bin/opencode")
    expect(result["Dockerfile.cloud-opencode-runtime.dockerignore"]).toBe(result["Dockerfile.cloud-api.dockerignore"])
    expect(result["smoke-api-workflow.ts"]).toContain("POST /v1/workspaces")
    expect(result["smoke-api-workflow.ts"]).toContain("/v1/sessions")
    expect(result["smoke-api-workflow.ts"]).toContain("/v1/jobs")
    expect(result["smoke-api-workflow.ts"]).toContain("/events")
    expect(JSON.parse(result["runtime-profile.json"])).toMatchObject({
      storageBackend: "sqlite",
      workerExecutionMode: "opencode",
      artifactStorage: "minio",
      objectBucket: "runtime-artifacts",
      runtimeImage: "cloud-runtime-opencode:1.14.28",
    })
    expect(result["README.md"]).toContain("docker build -f Dockerfile.cloud-api -t cloud-runtime-api:dev ../../..")
    expect(result["README.md"]).toContain("docker compose --env-file api.env --env-file worker.env up -d")
    expect(CloudLocalDocker.commands()).toEqual({
      buildAPI: "docker build -f Dockerfile.cloud-api -t cloud-runtime-api:dev ../../..",
      buildWorker: "docker build -f Dockerfile.cloud-worker -t cloud-runtime-worker:dev ../../..",
      buildRuntime: "docker build -f Dockerfile.cloud-opencode-runtime -t cloud-runtime-opencode:1.14.28 ../../..",
      up: "docker compose --env-file api.env --env-file worker.env up -d",
      down: "docker compose down -v",
      logs: "docker compose logs -f api worker",
      inspectImages: "docker image inspect cloud-runtime-api:dev cloud-runtime-worker:dev cloud-runtime-opencode:1.14.28",
      saveImages: "mkdir -p image-archive && docker save cloud-runtime-api:dev cloud-runtime-worker:dev cloud-runtime-opencode:1.14.28 -o image-archive/cloud-runtime-images.tar",
      loadImages: "docker load -i image-archive/cloud-runtime-images.tar",
      bundle: "tar -czf cloud-runtime-compose-bundle.tgz docker-compose.yml api.env worker.env runtime-profile.json smoke-api-workflow.ts REMOTE_DOCKER.md image-archive",
      saveImageArchives: [
        "docker save cloud-runtime-api:dev -o image-archive/cloud-runtime-api_dev.tar",
        "docker save cloud-runtime-worker:dev -o image-archive/cloud-runtime-worker_dev.tar",
        "docker save cloud-runtime-opencode:1.14.28 -o image-archive/cloud-runtime-opencode_1.14.28.tar",
      ],
    })
  })

  test("documents local Docker health checks and sample API workflow", () => {
    const readme = CloudLocalDocker.files({ workerExecutionMode: "simulate" })["README.md"]

    expect(readme).toContain("curl -fsS http://localhost:8787/health")
    expect(readme).toContain("curl -fsS -X POST http://localhost:8787/v1/workspaces")
    expect(readme).toContain("curl -fsS -X POST http://localhost:8787/v1/sessions")
    expect(readme).toContain("curl -fsS -X POST http://localhost:8787/v1/jobs")
    expect(readme).toContain("CLOUD_RUNTIME_EXECUTION_MODE=simulate")
    expect(readme).toContain("CLOUD_RUNTIME_EXECUTION_MODE=opencode")
    expect(readme).toContain("Storage backend: sqlite")
    expect(readme).toContain("Worker execution: simulate")
    expect(readme).toContain("Artifact storage: minio/runtime-artifacts")
  })

  test("renders a PostgreSQL opencode Docker profile for local E2E runs", () => {
    const result = CloudLocalDocker.files({ storageBackend: "postgres", workerExecutionMode: "opencode" })

    expect(JSON.parse(result["runtime-profile.json"])).toMatchObject({
      storageBackend: "postgres",
      workerExecutionMode: "opencode",
      artifactStorage: "minio",
      objectEndpoint: "http://minio:9000",
      objectBucket: "runtime-artifacts",
    })
    expect(result["README.md"]).toContain("Storage backend: postgres")
    expect(result["README.md"]).toContain("Worker execution: opencode")
  })

  test("documents real Docker smoke execution and failure diagnostics", () => {
    const readme = CloudLocalDocker.files({ workerExecutionMode: "opencode" })["README.md"]

    expect(readme).toContain("bun run cloud:docker:smoke")
    expect(readme).toContain("bun run cloud:docker:smoke:run")
    expect(readme).toContain("bun run cloud:verify --audit")
    expect(readme).toContain("CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1")
    expect(readme).toContain("CLOUD_RUNTIME_MODEL_PROVIDER")
    expect(readme).toContain("CLOUD_RUNTIME_MODEL")
    expect(readme).toContain("OPENAI_API_KEY")
    expect(readme).toContain("attempts")
    expect(readme).toContain("stdout")
    expect(readme).toContain("stderr")
    expect(readme).toContain("docker compose logs -f api worker")
    expect(readme).toContain("POST /v1/workspaces")
  })

  test("documents the one-command PostgreSQL shared-session Docker profile", () => {
    const readme = CloudLocalDocker.files({ storageBackend: "postgres", workerExecutionMode: "shared-session" })["README.md"]

    expect(readme).toContain("bun run cloud:docker:shared")
    expect(readme).toContain("bun run cloud:docker:shared:check")
    expect(readme).toContain("bun run cloud:docker:shared:smoke")
    expect(readme).toContain("CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run")
    expect(readme).toContain("bun run cloud:docker:e2e")
    expect(readme).toContain("CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e")
    expect(readme).toContain("CLOUD_RUNTIME_DOCKER_SKIP_BUILD=1")
    expect(readme).toContain("Production-install shared-session E2E path:")
    expect(readme).toContain("bun run cloud:docker:e2e:production")
    expect(readme).toContain("CLOUD_RUNTIME_CAPABILITY_PROFILE=minimal CLOUD_RUNTIME_DOCKER_SKIP_BUILD=1 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e:production")
    expect(readme).toContain("copy that directory plus pushed or loaded images to another Docker host")
    expect(readme).toContain(".cloud-runtime-shared")
  })

  test("generates a remote Docker runbook with save/load and registry transfer paths", () => {
    const result = CloudLocalDocker.files({
      imageProfile: "production-install",
      runtimeCapabilityProfile: "minimal",
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })

    expect(result["REMOTE_DOCKER.md"]).toContain("Cloud Runtime Remote Docker Runbook")
    expect(result["REMOTE_DOCKER.md"]).toContain("mkdir -p image-archive && docker save cloud-runtime-api:production-install cloud-runtime-worker:production-install cloud-runtime-opencode:1.14.28-minimal-production-install -o image-archive/cloud-runtime-images.tar")
    expect(result["REMOTE_DOCKER.md"]).toContain("docker load -i image-archive/cloud-runtime-images.tar")
    expect(result["REMOTE_DOCKER.md"]).toContain("CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_DOCKER_BUNDLE_VERIFY=1 bun run ./src/cloud/local-docker.ts --bundle-verify .")
    expect(result["REMOTE_DOCKER.md"]).toContain("loads images, starts Compose, checks `/health`, runs the smoke API workflow")
    expect(result["REMOTE_DOCKER.md"]).toContain("docker tag cloud-runtime-opencode:1.14.28-minimal-production-install registry.example.com/cloud-runtime-opencode:1.14.28-minimal-production-install")
    expect(result["REMOTE_DOCKER.md"]).toContain("docker compose logs -f api worker runtime-worker")
  })

  test("documents model credential setup and shared-session troubleshooting", () => {
    const readme = CloudLocalDocker.files({ storageBackend: "postgres", workerExecutionMode: "shared-session" })["README.md"]

    expect(readme).toContain("Model configuration:")
    expect(readme).toContain("ANTHROPIC_API_KEY=sk-ant-...")
    expect(readme).toContain("CLOUD_RUNTIME_MODEL_PROVIDER=anthropic")
    expect(readme).toContain("CLOUD_RUNTIME_MODEL=claude-sonnet-4-5")
    expect(readme).toContain("CLOUD_RUNTIME_MODEL_ENV_KEYS=CUSTOM_LLM_API_KEY")
    expect(readme).toContain("CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1")
    expect(readme).toContain("docker compose logs -f api worker runtime-worker")
    expect(readme).toContain("If model preflight fails")
  })

  test("writes local Docker deployment files to disk", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-"))
    const result = await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })

    expect(result.files.map((item) => path.basename(item))).toEqual([
      "docker-compose.yml",
      "api.env",
      "worker.env",
      "Dockerfile.cloud-api",
      "Dockerfile.cloud-api.dockerignore",
      "Dockerfile.cloud-worker",
      "Dockerfile.cloud-worker.dockerignore",
      "Dockerfile.cloud-opencode-runtime",
      "Dockerfile.cloud-opencode-runtime.dockerignore",
      "smoke-api-workflow.ts",
      "runtime-profile.json",
      "REMOTE_DOCKER.md",
      "README.md",
    ])
    expect(await Bun.file(path.join(directory, "worker.env")).text()).toContain("CLOUD_RUNTIME_EXECUTION_MODE=simulate")
    expect(await Bun.file(path.join(directory, "docker-compose.yml")).exists()).toBe(true)
  })

  test("runs the generated smoke API workflow against a local Cloud API app", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-smoke-script-"))
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    const api = CloudSQLiteServer.create({ now: () => 100, serviceVersion: "docker-smoke-test" })
    const workflow = await import(path.join(directory, "smoke-api-workflow.ts")) as {
      run(input: { baseURL: string; fetch: (request: RequestInfo | URL, init?: RequestInit) => Promise<Response> }): Promise<Record<string, unknown>>
    }
    const result = await workflow.run({
      baseURL: "http://cloud-runtime.local",
      fetch: async (request, init) => {
        const url = new URL(String(request))
        return await api.app.request(`${url.pathname}${url.search}`, init)
      },
    })

    expect(result).toMatchObject({
      workspaceID: "workspace_1",
      sessionID: "session_1",
      jobID: "job_1",
      events: 1,
    })
  })

  test("can run the generated smoke API workflow with a BYOK credential", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-smoke-byok-"))
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    const api = CloudSQLiteServer.create({ now: () => 100, serviceVersion: "docker-smoke-test" })
    const workflow = await import(path.join(directory, "smoke-api-workflow.ts")) as {
      run(input: {
        baseURL: string
        fetch: (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
        useBYOK: true
      }): Promise<Record<string, unknown>>
    }
    const result = await workflow.run({
      baseURL: "http://cloud-runtime.local",
      useBYOK: true,
      fetch: async (request, init) => {
        const url = new URL(String(request))
        return await api.app.request(`${url.pathname}${url.search}`, init)
      },
    })
    const job = CloudSQLiteRepository.getJob({ db: api.db, tenantID: "tenant_local", id: `${result.jobID}` })

    expect(result).toMatchObject({
      workspaceID: "workspace_1",
      sessionID: "session_1",
      credentialID: "llmcred_1",
      jobID: "job_1",
    })
    expect(job?.modelConfigSnapshot).toMatchObject({
      credentialID: "llmcred_1",
      credentialVersion: 1,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    })
  })

  test("waits for the generated smoke API workflow to observe worker artifacts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-smoke-artifacts-"))
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    const api = CloudSQLiteServer.create({ now: () => 100, serviceVersion: "docker-smoke-test" })
    const workflow = await import(path.join(directory, "smoke-api-workflow.ts")) as {
      run(input: {
        baseURL: string
        fetch: (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
        waitForArtifacts: true
        pollIntervalMS: number
        maxPolls: number
        onPoll: () => Promise<void>
      }): Promise<Record<string, unknown>>
    }
    const result = await workflow.run({
      baseURL: "http://cloud-runtime.local",
      waitForArtifacts: true,
      pollIntervalMS: 0,
      maxPolls: 3,
      fetch: async (request, init) => {
        const url = new URL(String(request))
        return await api.app.request(`${url.pathname}${url.search}`, init)
      },
      onPoll: async () => {
        await runOnce({
          db: api.db,
          now: () => 200,
          workerID: "worker_docker_smoke",
          tenantID: "tenant_local",
          leaseTTLMS: 1000,
          sandboxRoot: "/sandbox",
          bucket: "runtime",
          namespace: "cloud-runtime",
          executionMode: "simulate",
        })
      },
    })

    expect(result).toMatchObject({
      jobID: "job_1",
      jobStatus: "succeeded",
      artifacts: 1,
    })
  })

  test("runs a second Docker smoke job in the same session to verify shared-session continuity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-smoke-followup-"))
    await CloudLocalDocker.writeFiles({ directory })
    const api = CloudSQLiteServer.create({ now: () => 100, serviceVersion: "docker-smoke-test" })
    const workflow = await import(path.join(directory, "smoke-api-workflow.ts")) as {
      run(input: {
        baseURL: string
        fetch: (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
        waitForArtifacts: true
        pollIntervalMS: number
        maxPolls: number
        onPoll: () => Promise<void>
      }): Promise<Record<string, unknown>>
    }
    const result = await workflow.run({
      baseURL: "http://cloud-runtime.local",
      waitForArtifacts: true,
      pollIntervalMS: 0,
      maxPolls: 3,
      fetch: async (request, init) => {
        const url = new URL(String(request))
        return await api.app.request(`${url.pathname}${url.search}`, init)
      },
      onPoll: async () => {
        await runOnce({
          db: api.db,
          now: () => 200,
          workerID: "worker_docker_smoke",
          tenantID: "tenant_local",
          leaseTTLMS: 1000,
          sandboxRoot: "/sandbox",
          bucket: "runtime",
          namespace: "cloud-runtime",
          executionMode: "simulate",
        })
      },
    })

    expect(result).toMatchObject({
      jobID: "job_1",
      followupJobID: "job_2",
      followupJobStatus: "succeeded",
      followupArtifacts: 1,
    })
  })

  test("instructs real opencode smoke jobs to write an artifact manifest", () => {
    const script = CloudLocalDocker.files({ workerExecutionMode: "opencode" })["smoke-api-workflow.ts"]

    expect(script).toContain(".opencode-cloud/artifacts.json")
    expect(script).toContain("OPENCODE_RUNTIME_JOB_ID")
    expect(script).toContain("docker-smoke-report.md")
  })

  test("creates the local Docker deployment directory when writing files", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-parent-"))
    const directory = path.join(parent, "runtime")
    const result = await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })

    expect(result.directory).toBe(directory)
    expect(await Bun.file(path.join(directory, "docker-compose.yml")).exists()).toBe(true)
  })

  test("builds CLI config for writing local Docker files", () => {
    expect(
      CloudLocalDocker.cliConfig({
        argv: ["bun", "src/cloud/local-docker.ts", "/tmp/cloud-runtime-dev"],
        env: {
          CLOUD_RUNTIME_EXECUTION_MODE: "kubernetes",
          CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example",
          CLOUD_RUNTIME_K8S_TOKEN: "token_123",
          CLOUD_RUNTIME_K8S_POLL_INTERVAL_MS: "250",
          CLOUD_RUNTIME_K8S_MAX_POLLS: "10",
          CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "900000",
          CLOUD_RUNTIME_RETRY_MAX_ATTEMPTS: "3",
          CLOUD_RUNTIME_RETRY_BASE_DELAY_MS: "1000",
          CLOUD_RUNTIME_RETRY_MAX_DELAY_MS: "30000",
        },
      }),
    ).toEqual({
      directory: "/tmp/cloud-runtime-dev",
      workerExecutionMode: "kubernetes",
      workerKubernetes: {
        serverURL: "https://kubernetes.example",
        token: "token_123",
        pollIntervalMS: 250,
        maxPolls: 10,
      },
      workerExecutionTimeoutMS: 900000,
      workerRetry: { maxAttempts: 3, baseDelayMS: 1000, maxDelayMS: 30000 },
    })
  })

  test("builds CLI check mode without treating the flag as a directory", () => {
    expect(
      CloudLocalDocker.cliConfig({
        argv: ["bun", "src/cloud/local-docker.ts", "--check"],
        env: {
          CLOUD_RUNTIME_DOCKER_DIR: ".cloud-runtime",
        },
      }),
    ).toEqual({ directory: ".cloud-runtime" })
    expect(CloudLocalDocker.cliMode({ argv: ["bun", "src/cloud/local-docker.ts", "--check"] })).toBe("check")
    expect(CloudLocalDocker.cliMode({ argv: ["bun", "src/cloud/local-docker.ts", "--bundle"] })).toBe("bundle")
    expect(CloudLocalDocker.cliMode({ argv: ["bun", "src/cloud/local-docker.ts", "--bundle-verify"] })).toBe("bundle-verify")
    expect(CloudLocalDocker.cliMode({ argv: ["bun", "src/cloud/local-docker.ts", "--smoke"] })).toBe("smoke")
    expect(CloudLocalDocker.cliMode({ argv: ["bun", "src/cloud/local-docker.ts", "--smoke-run"] })).toBe("smoke-run")
    expect(CloudLocalDocker.cliMode({ argv: ["bun", "src/cloud/local-docker.ts", ".cloud-runtime"] })).toBe("write")
  })

  test("returns build commands from file generation for CLI output", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-commands-"))
    const result = await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })

    expect(result.commands.buildAPI).toBe("docker build -f Dockerfile.cloud-api -t cloud-runtime-api:dev ../../..")
    expect(result.commands.buildWorker).toBe("docker build -f Dockerfile.cloud-worker -t cloud-runtime-worker:dev ../../..")
    expect(result.commands.buildRuntime).toBe(
      "docker build -f Dockerfile.cloud-opencode-runtime -t cloud-runtime-opencode:1.14.28 ../../..",
    )
  })

  test("renders an experimental production-install image profile without changing defaults", () => {
    const result = CloudLocalDocker.files({ imageProfile: "production-install", workerExecutionMode: "simulate" })

    expect(result["docker-compose.yml"]).toContain("image: cloud-runtime-api:production-install")
    expect(result["docker-compose.yml"]).toContain("image: cloud-runtime-worker:production-install")
    expect(result["docker-compose.yml"]).toContain("CLOUD_RUNTIME_SANDBOX_IMAGE: cloud-runtime-opencode:1.14.28-standard-production-install")
    expect(result["Dockerfile.cloud-api"]).toContain("FROM oven/bun:1.3.14-alpine AS deps")
    expect(result["Dockerfile.cloud-api"]).toContain("apk add --no-cache python3 make g++")
    expect(result["Dockerfile.cloud-api"]).toContain("for attempt in 1 2 3")
    expect(result["Dockerfile.cloud-api"]).toContain("bun install --production --no-save")
    expect(result["Dockerfile.cloud-api"]).toContain("const workspaces = [\"packages/core\", \"packages/plugin\", \"packages/script\", \"packages/sdk/js\"]")
    expect(result["Dockerfile.cloud-api"]).toContain("ln -sfn ${target} ${link}")
    expect(result["Dockerfile.cloud-api"]).toContain("dep === \"zod\" ? \"zod@4.\"")
    expect(result["Dockerfile.cloud-api"]).toContain("for dir in /app/node_modules/.bun /app/node_modules")
    expect(result["Dockerfile.cloud-api"]).toContain("-name '*.d.ts'")
    expect(result["Dockerfile.cloud-api"]).toContain("-name docs")
    expect(result["Dockerfile.cloud-api"]).toContain("\"@opencode-ai/core\": \"workspace:*\"")
    expect(result["Dockerfile.cloud-api"]).toContain("\"packages/core\", \"packages/opencode\", \"packages/plugin\", \"packages/script\", \"packages/sdk/js\"")
    expect(result["Dockerfile.cloud-api"]).toContain("RUN rm -f /app/bun.lock /app/bun.lockb")
    expect(result["Dockerfile.cloud-api"]).toContain("/app/packages/console")
    expect(result["Dockerfile.cloud-api"]).toContain("RUN bun build ./packages/opencode/src/cloud/local-api.ts --target=bun --outfile=/app/dist/local-api.js")
    expect(result["Dockerfile.cloud-api"]).toContain("COPY --from=build --chown=bun:bun /app/dist /app/dist")
    expect(result["Dockerfile.cloud-api"]).not.toContain("COPY --from=deps --chown=bun:bun /app/node_modules /app/node_modules")
    expect(result["Dockerfile.cloud-api"]).not.toContain("COPY --from=deps --chown=bun:bun /app/packages/opencode/node_modules /app/packages/opencode/node_modules")
    expect(result["Dockerfile.cloud-opencode-runtime"]).toContain("RUN bun build ./src/cloud/opencode-run.ts --target=bun --conditions=browser --outdir=/app/dist")
    expect(result["Dockerfile.cloud-opencode-runtime"]).toContain("COPY --from=build --chown=bun:bun /app/dist /app/dist")
    expect(result["Dockerfile.cloud-opencode-runtime"]).toContain("COPY --from=source --chown=bun:bun /app/packages/opencode/migration /migration")
    expect(result["Dockerfile.cloud-opencode-runtime"]).not.toContain("COPY --from=deps --chown=bun:bun /app/node_modules /app/node_modules")
    expect(result["Dockerfile.cloud-opencode-runtime"]).not.toContain("COPY --from=deps --chown=bun:bun /app/packages/opencode/node_modules /app/packages/opencode/node_modules")
    expect(result["Dockerfile.cloud-worker"]).toContain("RUN bun build ./packages/opencode/src/cloud/local-worker.ts --target=bun --outfile=/app/dist/local-worker.js")
    expect(result["Dockerfile.cloud-worker"]).toContain("RUN bun build ./packages/opencode/src/cloud/postgres-worker.ts --target=bun --outfile=/app/dist/postgres-worker.js")
    expect(result["Dockerfile.cloud-worker"]).toContain("RUN bun build ./packages/opencode/src/cloud/runtime-worker-server.ts --target=bun --outfile=/app/dist/runtime-worker-server.js")
    expect(result["Dockerfile.cloud-api.dockerignore"]).toContain("node_modules")
    expect(result["Dockerfile.cloud-api.dockerignore"]).toContain("**/node_modules")
    expect(result["Dockerfile.cloud-api.dockerignore"]).toContain("packages/console")
    expect(result["Dockerfile.cloud-api.dockerignore"]).toContain("packages/app")
    expect(result["Dockerfile.cloud-api.dockerignore"]).not.toContain("packages/opencode")
    expect(result["Dockerfile.cloud-api.dockerignore"]).not.toContain("packages/core")
    expect(result["Dockerfile.cloud-api"]).not.toContain("RUN test -d node_modules && test -d packages/opencode/node_modules")
    expect(result["Dockerfile.cloud-api"]).toContain("CMD [\"bun\", \"./dist/local-api.js\"]")
    expect(result["Dockerfile.cloud-worker"]).toContain("CMD [\"bun\", \"./dist/local-worker.js\"]")
    expect(result["runtime-profile.json"]).toContain("\"imageProfile\": \"production-install\"")
    expect(result["README.md"]).toContain("Image profile: production-install")
  })

  test("uses bundled service commands for production-install Docker Compose", () => {
    const sqlite = CloudLocalDocker.compose({ imageProfile: "production-install", workerExecutionMode: "simulate" })
    const postgres = CloudLocalDocker.compose({
      imageProfile: "production-install",
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })

    expect(sqlite.services.api.command).toBe("bun ./dist/local-api.js")
    expect(sqlite.services.worker.command).toBe("bun ./dist/local-worker.js")
    expect(postgres.services.worker.command).toBe("bun ./dist/postgres-worker.js")
    expect(postgres.services["runtime-worker"]?.command).toBe("bun ./dist/runtime-worker-server.js")
    expect(JSON.parse(CloudLocalDocker.files({ imageProfile: "production-install" })["runtime-profile.json"])).toMatchObject({
      apiCommand: "bun ./dist/local-api.js",
      workerCommand: "bun ./dist/local-worker.js",
    })
  })

  test("returns production-install build commands and summary for experimental image profile", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-production-install-"))
    const result = await CloudLocalDocker.writeFiles({
      directory,
      workerExecutionMode: "simulate",
      imageProfile: "production-install",
    })
    const summary = CloudLocalDocker.cliSummary(result)

    expect(result.commands.buildAPI).toBe("docker build -f Dockerfile.cloud-api -t cloud-runtime-api:production-install ../../..")
    expect(result.commands.buildWorker).toBe("docker build -f Dockerfile.cloud-worker -t cloud-runtime-worker:production-install ../../..")
    expect(result.commands.buildRuntime).toBe(
      "docker build -f Dockerfile.cloud-opencode-runtime -t cloud-runtime-opencode:1.14.28-standard-production-install ../../..",
    )
    expect(summary).toContain("Image Profile: production-install")
    expect(summary).toContain("Build API:     docker build -f Dockerfile.cloud-api -t cloud-runtime-api:production-install ../../..")
  })

  test("passes static checks for the experimental production-install image profile", async () => {
    const result = await CloudLocalDocker.writeFiles({
      directory: await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-production-install-check-")),
      workerExecutionMode: "simulate",
      imageProfile: "production-install",
    })

    expect(result.staticCheck.ok).toBe(true)
    expect(result.staticCheck.checks.find((item) => item.name === "compose-api-image")).toMatchObject({
      status: "passed",
      detail: "docker-compose.yml uses cloud-runtime-api:production-install",
    })
    expect(result.staticCheck.checks.find((item) => item.name === "compose-runtime-image")).toMatchObject({
      status: "passed",
      detail: "worker uses cloud-runtime-opencode:1.14.28-standard-production-install",
    })
  })

  test("renders minimal, standard, and heavy opencode runtime capability profiles", () => {
    const minimal = CloudLocalDocker.files({
      imageProfile: "production-install",
      runtimeCapabilityProfile: "minimal",
      workerExecutionMode: "simulate",
    })
    const standard = CloudLocalDocker.files({
      imageProfile: "production-install",
      runtimeCapabilityProfile: "standard",
      workerExecutionMode: "simulate",
    })
    const heavy = CloudLocalDocker.files({
      imageProfile: "production-install",
      runtimeCapabilityProfile: "heavy",
      workerExecutionMode: "simulate",
    })

    expect(minimal["docker-compose.yml"]).toContain("CLOUD_RUNTIME_SANDBOX_IMAGE: cloud-runtime-opencode:1.14.28-minimal-production-install")
    expect(minimal["Dockerfile.cloud-opencode-runtime"]).toContain("apk add --no-cache git ripgrep")
    expect(minimal["Dockerfile.cloud-opencode-runtime"]).not.toContain("RUN apk add --no-cache git ripgrep python3")
    expect(minimal["runtime-profile.json"]).toContain("\"runtimeCapabilityProfile\": \"minimal\"")

    expect(standard["docker-compose.yml"]).toContain("CLOUD_RUNTIME_SANDBOX_IMAGE: cloud-runtime-opencode:1.14.28-standard-production-install")
    expect(standard["Dockerfile.cloud-opencode-runtime"]).toContain("apk add --no-cache git ripgrep python3")
    expect(standard["runtime-profile.json"]).toContain("\"runtimeCapabilityProfile\": \"standard\"")

    expect(heavy["docker-compose.yml"]).toContain("CLOUD_RUNTIME_SANDBOX_IMAGE: cloud-runtime-opencode:1.14.28-heavy-production-install")
    expect(heavy["Dockerfile.cloud-opencode-runtime"]).toContain("apk add --no-cache git ripgrep python3 chromium chromium-chromedriver libreoffice tesseract-ocr poppler-utils font-noto")
    expect(heavy["runtime-profile.json"]).toContain("\"runtimeCapabilityProfile\": \"heavy\"")
  })

  test("renders role-aware production install Dockerfiles for service and runtime images", () => {
    const result = CloudLocalDocker.files({ imageProfile: "production-install", workerExecutionMode: "simulate" })

    expect(result["Dockerfile.cloud-api"]).not.toContain('ENTRYPOINT ["opencode"]')
    expect(result["Dockerfile.cloud-api"]).not.toContain("/usr/local/bin/opencode")
    expect(result["Dockerfile.cloud-api"]).not.toContain("RUN apk add --no-cache git ripgrep python3")
    expect(result["Dockerfile.cloud-api"]).not.toContain("WORKDIR /workspace")
    expect(result["Dockerfile.cloud-api"]).toContain("CMD [\"bun\", \"./dist/local-api.js\"]")

    expect(result["Dockerfile.cloud-worker"]).not.toContain('ENTRYPOINT ["opencode"]')
    expect(result["Dockerfile.cloud-worker"]).not.toContain("/usr/local/bin/opencode")
    expect(result["Dockerfile.cloud-worker"]).not.toContain("chromium")
    expect(result["Dockerfile.cloud-worker"]).not.toContain("libreoffice")
    expect(result["Dockerfile.cloud-worker"]).not.toContain("tesseract-ocr")
    expect(result["Dockerfile.cloud-worker"]).toContain("CMD [\"bun\", \"./dist/local-worker.js\"]")

    expect(result["Dockerfile.cloud-opencode-runtime"]).toContain('ENTRYPOINT ["opencode"]')
    expect(result["Dockerfile.cloud-opencode-runtime"]).toContain("/usr/local/bin/opencode")
    expect(result["Dockerfile.cloud-opencode-runtime"]).toContain("WORKDIR /workspace")
    expect(result["Dockerfile.cloud-opencode-runtime"]).toContain("apk add --no-cache git ripgrep python3")
    expect(result["Dockerfile.cloud-opencode-runtime"]).toContain("RUN bun build ./src/cloud/opencode-run.ts --target=bun --conditions=browser --outdir=/app/dist")
    expect(result["Dockerfile.cloud-opencode-runtime"]).toContain("exec bun /app/dist/opencode-run.js")
    expect(result["Dockerfile.cloud-opencode-runtime"]).not.toContain("ln -sfn ../../packages/core /app/node_modules/@opencode-ai/core")
  })

  test("returns static checks from file generation for CLI output", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-checks-"))
    const result = await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    const summary = CloudLocalDocker.cliSummary(result)

    expect(result.staticCheck.ok).toBe(true)
    expect(result.staticCheck.checks.map((item) => item.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
    ])
    expect(summary).toContain("Static Check:  passed")
    expect(summary).toContain("Check:         bun run cloud:docker:check")
    expect(summary).toContain("Smoke Plan:    bun run cloud:docker:smoke")
  })

  test("returns profile-aware static checks from shared-session file generation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-shared-write-"))
    const result = await CloudLocalDocker.writeFiles({
      directory,
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })

    expect(result.staticCheck.ok).toBe(true)
    expect(result.commands.logs).toBe("docker compose logs -f api worker runtime-worker")
    expect(CloudLocalDocker.cliSummary(result)).toContain("Logs:          docker compose logs -f api worker runtime-worker")
  })

  test("renders CLI summary with build and run commands", () => {
    const summary = CloudLocalDocker.cliSummary({
      directory: ".cloud-runtime",
      commands: CloudLocalDocker.commands(),
      staticCheck: CloudLocalDocker.smokePlan({
        files: CloudLocalDocker.files({ workerExecutionMode: "simulate" }),
        commands: CloudLocalDocker.commands(),
      }),
    })

    expect(summary).toContain("Wrote Cloud Runtime Docker files to .cloud-runtime")
    expect(summary).toContain("Storage:       sqlite")
    expect(summary).toContain("Execution:     simulate")
    expect(summary).toContain("Artifacts:     minio/runtime-artifacts")
    expect(summary).toContain("Build API:     docker build -f Dockerfile.cloud-api -t cloud-runtime-api:dev ../../..")
    expect(summary).toContain("Build Worker:  docker build -f Dockerfile.cloud-worker -t cloud-runtime-worker:dev ../../..")
    expect(summary).toContain("Build Runtime: docker build -f Dockerfile.cloud-opencode-runtime -t cloud-runtime-opencode:1.14.28 ../../..")
    expect(summary).toContain("Start:         docker compose --env-file api.env --env-file worker.env up -d")
  })

  test("renders smoke check summary for CLI output", () => {
    const summary = CloudLocalDocker.checkSummary(
      CloudLocalDocker.smokePlan({
        files: CloudLocalDocker.files({ workerExecutionMode: "simulate" }),
        commands: CloudLocalDocker.commands(),
      }),
    )

    expect(summary).toContain("Cloud Runtime Docker static check: passed")
    expect(summary).toContain("[passed] build-api-image")
    expect(summary).toContain("[passed] compose-runtime-image")
    expect(summary).toContain("Next commands:")
    expect(summary).toContain("docker compose --env-file api.env --env-file worker.env up -d")
  })

  test("checks Docker files from an existing generated directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-existing-check-"))
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    await Bun.write(path.join(directory, "Dockerfile.cloud-opencode-runtime"), "FROM scratch\n")
    const result = await CloudLocalDocker.checkDirectory({ directory })

    expect(result.ok).toBe(false)
    expect(result.checks.find((item) => item.name === "build-runtime-image")).toMatchObject({
      status: "failed",
    })
  })

  test("checks generated PostgreSQL shared-session Docker files with runtime worker diagnostics", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-shared-check-"))
    await CloudLocalDocker.writeFiles({
      directory,
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })
    const result = await CloudLocalDocker.checkDirectory({ directory })

    expect(result.ok).toBe(true)
    expect(result.commands).toContain("docker compose logs -f api worker runtime-worker")
    expect(result.checks.find((item) => item.name === "runtime-worker-service")).toMatchObject({
      status: "passed",
    })
  })

  test("runs the Docker check CLI path against an existing generated directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-cli-check-"))
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    await Bun.write(path.join(directory, "Dockerfile.cloud-opencode-runtime"), "FROM scratch\n")
    const result = await CloudLocalDocker.checkCLI({ directory })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Cloud Runtime Docker static check: failed")
    expect(result.output).toContain("[failed] build-runtime-image")
  })

  test("reports missing generated Docker files as static check failures", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-missing-check-"))
    const result = await CloudLocalDocker.checkCLI({ directory })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Cloud Runtime Docker static check: failed")
    expect(result.output).toContain("[failed] generated-files")
    expect(result.output).toContain("missing docker-compose.yml")
  })

  test("builds a local Docker smoke plan from generated files", () => {
    const result = CloudLocalDocker.smokePlan({
      files: CloudLocalDocker.files({ workerExecutionMode: "simulate" }),
      commands: CloudLocalDocker.commands(),
    })

    expect(result.ok).toBe(true)
    expect(result.checks.map((item) => item.name)).toEqual([
      "build-api-image",
      "build-worker-image",
      "build-runtime-image",
      "api-role-pruning",
      "worker-role-pruning",
      "runtime-role-tools",
      "runtime-skill-directory",
      "compose-skill-volume",
      "compose-api-image",
      "compose-worker-image",
      "compose-runtime-image",
      "api-health",
      "api-workflow",
      "artifact-workflow",
      "postgres-storage-env",
      "byok-smoke-workflow",
      "minio-bucket-init",
      "runtime-worker-service",
      "runtime-profile",
    ])
    expect(result.checks.filter((item) => item.status === "failed")).toEqual([])
    expect(result.commands).toEqual([
      "docker build -f Dockerfile.cloud-api -t cloud-runtime-api:dev ../../..",
      "docker build -f Dockerfile.cloud-worker -t cloud-runtime-worker:dev ../../..",
      "docker build -f Dockerfile.cloud-opencode-runtime -t cloud-runtime-opencode:1.14.28 ../../..",
      "docker compose --env-file api.env --env-file worker.env up -d",
      "curl -fsS http://localhost:8787/health",
      "docker compose logs -f api worker",
    ])
  })

  test("builds an ordered real Docker smoke run plan with cleanup", () => {
    const result = CloudLocalDocker.smokeRunPlan({
      directory: ".cloud-runtime",
      timeoutMS: 120_000,
      healthRetries: 20,
      healthIntervalMS: 1_000,
      commands: CloudLocalDocker.commands(),
    })

    expect(result.directory).toBe(".cloud-runtime")
    expect(result.timeoutMS).toBe(120_000)
    expect(result.steps.map((item) => item.name)).toEqual([
      "check-docker",
      "check-docker-compose",
      "check-api-port",
      "check-build-context",
      "build-api-image",
      "build-worker-image",
      "build-runtime-image",
      "start-compose",
      "wait-api-health",
      "verify-api-workflow",
      "print-logs-on-failure",
      "cleanup-compose",
    ])
    expect(result.steps.find((item) => item.name === "check-docker")).toMatchObject({
      phase: "preflight",
      command: "docker info",
    })
    expect(result.steps.find((item) => item.name === "check-docker-compose")).toMatchObject({
      phase: "preflight",
      command: "docker compose version",
    })
    expect(result.steps.find((item) => item.name === "check-api-port")).toMatchObject({
      phase: "preflight",
      command: "sh -lc '! lsof -iTCP:8787 -sTCP:LISTEN'",
      args: ["sh", "-lc", "! lsof -iTCP:8787 -sTCP:LISTEN"],
    })
    expect(result.steps.find((item) => item.name === "check-build-context")).toMatchObject({
      phase: "preflight",
      command: "test -d ../../..",
      args: ["test", "-d", "../../.."],
    })
    expect(result.steps.find((item) => item.name === "cleanup-compose")).toMatchObject({
      phase: "cleanup",
      alwaysRun: true,
      command: "docker compose down -v",
    })
    expect(result.steps.find((item) => item.name === "wait-api-health")).toMatchObject({
      phase: "verify",
      retries: 20,
      intervalMS: 1_000,
      command: "curl -fsS http://localhost:8787/health",
    })
    expect(result.steps.find((item) => item.name === "verify-api-workflow")).toMatchObject({
      phase: "verify",
      command: "bun run ./smoke-api-workflow.ts",
      args: ["bun", "run", "./smoke-api-workflow.ts"],
    })
  })

  test("adds runtime worker service preflight for PostgreSQL shared-session smoke runs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-shared-preflight-"))
    await CloudLocalDocker.writeFiles({
      directory,
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })
    const plan = await CloudLocalDocker.smokeRunPlanForDirectory({
      directory,
      healthRetries: 1,
    })

    expect(plan.steps.map((item) => item.name)).toContain("check-runtime-worker-service")
    expect(plan.steps.find((item) => item.name === "check-runtime-worker-service")).toMatchObject({
      phase: "preflight",
      command: "docker compose config --services | grep -qx runtime-worker",
      args: ["sh", "-lc", "docker compose config --services | grep -qx runtime-worker"],
    })
    expect(plan.steps.findIndex((item) => item.name === "check-runtime-worker-service")).toBeLessThan(
      plan.steps.findIndex((item) => item.name === "build-api-image"),
    )
  })

  test("renders real Docker smoke run plan summary for CLI output", () => {
    const summary = CloudLocalDocker.smokeRunSummary(
      CloudLocalDocker.smokeRunPlan({
        directory: ".cloud-runtime",
        commands: CloudLocalDocker.commands(),
      }),
    )

    expect(summary).toContain("Cloud Runtime Docker smoke run plan for .cloud-runtime")
    expect(summary).toContain("[preflight] check-docker: docker info")
    expect(summary).toContain("[preflight] check-docker-compose: docker compose version")
    expect(summary).toContain("[preflight] check-api-port: sh -lc '! lsof -iTCP:8787 -sTCP:LISTEN'")
    expect(summary).toContain("[preflight] check-build-context: test -d ../../..")
    expect(summary).toContain("[build] build-api-image: docker build -f Dockerfile.cloud-api -t cloud-runtime-api:dev ../../..")
    expect(summary).toContain("[verify] wait-api-health: curl -fsS http://localhost:8787/health")
    expect(summary).toContain("[verify] verify-api-workflow: bun run ./smoke-api-workflow.ts")
    expect(summary).toContain("[cleanup] cleanup-compose: docker compose down -v")
    expect(summary).toContain("Cleanup always runs after start.")
  })

  test("renders a profile-aware Docker smoke plan summary from a generated directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-shared-smoke-summary-"))
    await CloudLocalDocker.writeFiles({
      directory,
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })
    const result = await CloudLocalDocker.smokeCLI({ directory })

    expect(result.output).toContain("[preflight] check-runtime-worker-service")
    expect(result.output).toContain("[diagnose] print-logs-on-failure: docker compose logs --tail=240 api worker runtime-worker")
  })

  test("runs a Docker smoke plan through an injected executor", async () => {
    const executed: string[] = []
    const result = await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({ directory: ".cloud-runtime", commands: CloudLocalDocker.commands() }),
      run: async (step) => {
        executed.push(step.name)
        return { ok: true, stdout: step.command, stderr: "" }
      },
    })

    expect(result.ok).toBe(true)
    expect(executed).toEqual([
      "check-docker",
      "check-docker-compose",
      "check-api-port",
      "check-build-context",
      "build-api-image",
      "build-worker-image",
      "build-runtime-image",
      "start-compose",
      "wait-api-health",
      "verify-api-workflow",
      "cleanup-compose",
    ])
    expect(result.steps.map((item) => item.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "skipped",
      "passed",
    ])
  })

  test("reports Docker smoke progress while steps are running", async () => {
    const progress: string[] = []
    await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({ directory: ".cloud-runtime", commands: CloudLocalDocker.commands() }),
      run: async () => ({ ok: true, stdout: "", stderr: "" }),
      progress: (line) => progress.push(line),
    })

    expect(progress.slice(0, 4)).toEqual([
      "start check-docker: docker info",
      "passed check-docker attempts=1",
      "start check-docker-compose: docker compose version",
      "passed check-docker-compose attempts=1",
    ])
    expect(progress).toContain("skipped print-logs-on-failure")
    expect(progress.at(-1)).toBe("passed cleanup-compose attempts=1")
  })

  test("retries Docker smoke health checks before succeeding", async () => {
    const attempts: string[] = []
    const result = await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({
        directory: ".cloud-runtime",
        healthRetries: 3,
        healthIntervalMS: 0,
        commands: CloudLocalDocker.commands(),
      }),
      run: async (step) => {
        attempts.push(step.name)
        if (step.name === "wait-api-health" && attempts.filter((item) => item === "wait-api-health").length < 2) {
          return { ok: false, stdout: "", stderr: "connection refused" }
        }
        return { ok: true, stdout: "", stderr: "" }
      },
      sleep: async () => undefined,
    })

    expect(result.ok).toBe(true)
    expect(attempts.filter((item) => item === "wait-api-health")).toHaveLength(2)
    expect(result.steps.find((item) => item.name === "wait-api-health")).toMatchObject({
      status: "passed",
      attempts: 2,
    })
  })

  test("runs diagnostics and cleanup when Docker smoke execution fails", async () => {
    const executed: string[] = []
    const result = await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({ directory: ".cloud-runtime", commands: CloudLocalDocker.commands() }),
      run: async (step) => {
        executed.push(step.name)
        if (step.name === "build-worker-image") return { ok: false, stdout: "", stderr: "build failed" }
        return { ok: true, stdout: "", stderr: "" }
      },
    })

    expect(result.ok).toBe(false)
    expect(executed).toEqual([
      "check-docker",
      "check-docker-compose",
      "check-api-port",
      "check-build-context",
      "build-api-image",
      "build-worker-image",
      "print-logs-on-failure",
      "cleanup-compose",
    ])
    expect(result.steps.map((item) => [item.name, item.status])).toEqual([
      ["check-docker", "passed"],
      ["check-docker-compose", "passed"],
      ["check-api-port", "passed"],
      ["check-build-context", "passed"],
      ["build-api-image", "passed"],
      ["build-worker-image", "failed"],
      ["build-runtime-image", "skipped"],
      ["start-compose", "skipped"],
      ["wait-api-health", "skipped"],
      ["verify-api-workflow", "skipped"],
      ["print-logs-on-failure", "passed"],
      ["cleanup-compose", "passed"],
    ])
  })

  test("renders Docker smoke execution results with stdout and stderr summaries", async () => {
    const result = await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({ directory: ".cloud-runtime", commands: CloudLocalDocker.commands() }),
      run: async (step) => {
        if (step.name === "build-worker-image") {
          return {
            ok: false,
            stdout: "building worker image\nstill building worker image",
            stderr: "docker prelude\nerror: failed to resolve base image\nmore details",
          }
        }
        return { ok: true, stdout: `${step.name} ok`, stderr: "" }
      },
    })
    const summary = CloudLocalDocker.smokeRunResultSummary(result)

    expect(summary).toContain("Cloud Runtime Docker smoke run: failed")
    expect(summary).toContain("[passed] check-docker attempts=1")
    expect(summary).toContain("[passed] check-docker-compose attempts=1")
    expect(summary).toContain("[passed] check-api-port attempts=1")
    expect(summary).toContain("[passed] check-build-context attempts=1")
    expect(summary).toContain("[passed] build-api-image attempts=1")
    expect(summary).toContain("[failed] build-worker-image attempts=1")
    expect(summary).toContain("stdout: building worker image")
    expect(summary).toContain("stderr: error: failed to resolve base image")
    expect(summary).toContain("stderr: more details")
    expect(summary).toContain("next: inspect Dockerfile.cloud-worker, Bun dependency install output, and build context ../../..")
    expect(summary).toContain("[skipped] build-runtime-image attempts=0")
    expect(summary).toContain("[passed] cleanup-compose attempts=1")
  })

  test("renders step-specific Docker smoke build failure suggestions", async () => {
    const result = async (name: string) => CloudLocalDocker.smokeRunResultSummary(
      await CloudLocalDocker.runSmokePlan({
        plan: CloudLocalDocker.smokeRunPlan({ directory: ".cloud-runtime", commands: CloudLocalDocker.commands() }),
        run: async (step) => step.name === name
          ? { ok: false, stdout: "", stderr: "build failed" }
          : { ok: true, stdout: "", stderr: "" },
      }),
    )

    expect(await result("build-api-image")).toContain("next: inspect Dockerfile.cloud-api, Bun dependency install output, and build context ../../..")
    expect(await result("build-worker-image")).toContain("next: inspect Dockerfile.cloud-worker, Bun dependency install output, and build context ../../..")
    expect(await result("build-runtime-image")).toContain("next: inspect Dockerfile.cloud-opencode-runtime, opencode entrypoint generation, and build context ../../..")
  })

  test("renders actionable Docker smoke failure suggestions for common preflight and health failures", async () => {
    const port = await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({ directory: ".cloud-runtime", commands: CloudLocalDocker.commands() }),
      run: async (step) => step.name === "check-api-port"
        ? { ok: false, stdout: "", stderr: "port 8787 is already in use" }
        : { ok: true, stdout: "", stderr: "" },
    })
    const health = await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({ directory: ".cloud-runtime", healthRetries: 1, commands: CloudLocalDocker.commands() }),
      run: async (step) => step.name === "wait-api-health"
        ? { ok: false, stdout: "", stderr: "connection refused" }
        : { ok: true, stdout: "", stderr: "" },
    })

    expect(CloudLocalDocker.smokeRunResultSummary(port)).toContain("next: stop the process listening on port 8787 or change the generated API port before running smoke")
    expect(CloudLocalDocker.smokeRunResultSummary(health)).toContain("next: inspect docker compose logs for api and worker; verify the API service bound port 8787")
  })

  test("renders runtime worker diagnostics when shared-session Docker workflow fails", async () => {
    const result = await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({
        directory: ".cloud-runtime",
        commands: CloudLocalDocker.commands({ includeRuntimeWorker: true }),
      }),
      run: async (step) => step.name === "verify-api-workflow"
        ? { ok: false, stdout: "", stderr: "runtime endpoint unavailable" }
        : { ok: true, stdout: "", stderr: "" },
    })

    expect(CloudLocalDocker.smokeRunResultSummary(result)).toContain(
      "next: inspect the API workflow output, worker logs, runtime-worker logs, and artifact manifest generation",
    )
  })

  test("renders Docker smoke API workflow evidence from JSON stdout", async () => {
    const result = await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({ directory: ".cloud-runtime", commands: CloudLocalDocker.commands() }),
      run: async (step) => {
        if (step.name === "verify-api-workflow") {
          return {
            ok: true,
            stdout: JSON.stringify({
              workspaceID: "workspace_1",
              sessionID: "session_1",
              jobID: "job_1",
              jobStatus: "succeeded",
              artifacts: 1,
              events: 5,
            }),
            stderr: "",
          }
        }
        return { ok: true, stdout: "", stderr: "" }
      },
    })

    expect(CloudLocalDocker.smokeRunResultSummary(result)).toContain(
      "evidence: workspace=workspace_1 session=session_1 job=job_1 status=succeeded artifacts=1 events=5",
    )
  })

  test("renders Docker smoke follow-up job evidence from JSON stdout", async () => {
    const result = await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({ directory: ".cloud-runtime", commands: CloudLocalDocker.commands() }),
      run: async (step) => {
        if (step.name === "verify-api-workflow") {
          return {
            ok: true,
            stdout: JSON.stringify({
              workspaceID: "workspace_1",
              sessionID: "session_1",
              jobID: "job_1",
              jobStatus: "succeeded",
              artifacts: 1,
              events: 5,
              followupJobID: "job_2",
              followupJobStatus: "succeeded",
              followupArtifacts: 1,
              followupEvents: 4,
            }),
            stderr: "",
          }
        }
        return { ok: true, stdout: "", stderr: "" }
      },
    })

    expect(CloudLocalDocker.smokeRunResultSummary(result)).toContain(
      "followup: job=job_2 status=succeeded artifacts=1 events=4",
    )
  })

  test("runs the Docker smoke CLI path with an injected executor", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-smoke-cli-"))
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    const result = await CloudLocalDocker.smokeRunCLI({
      directory,
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
      },
      run: async (step) => {
        if (step.name === "wait-api-health") return { ok: false, stdout: "", stderr: "health failed" }
        return { ok: true, stdout: "", stderr: "" }
      },
      healthRetries: 1,
    })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Cloud Runtime Docker smoke run: failed")
    expect(result.output).toContain("[failed] wait-api-health attempts=1")
    expect(result.output).toContain("stderr: health failed")
    expect(result.output).toContain("[passed] cleanup-compose attempts=1")
  })

  test("streams Docker smoke CLI progress for real non-evidence runs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-smoke-cli-progress-"))
    const progress: string[] = []
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    const result = await CloudLocalDocker.smokeRunCLI({
      directory,
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
      },
      progress: (line) => progress.push(line),
      run: async () => ({ ok: true, stdout: "", stderr: "" }),
    })

    expect(result.exitCode).toBe(0)
    expect(progress[0]).toBe("start check-docker: docker info")
    expect(progress).toContain("start verify-api-workflow: bun run ./smoke-api-workflow.ts")
    expect(progress.at(-1)).toBe("passed cleanup-compose attempts=1")
  })

  test("can skip Docker image build steps for local E2E when images already exist", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-smoke-skip-build-"))
    const executed: string[] = []
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    const result = await CloudLocalDocker.smokeRunCLI({
      directory,
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
        CLOUD_RUNTIME_DOCKER_SKIP_BUILD: "1",
      },
      run: async (step) => {
        executed.push(step.name)
        return { ok: true, stdout: "", stderr: "" }
      },
    })

    expect(result.exitCode).toBe(0)
    expect(executed).not.toContain("build-api-image")
    expect(executed).not.toContain("build-worker-image")
    expect(executed).not.toContain("build-runtime-image")
    expect(executed).toContain("start-compose")
    expect(executed).toContain("verify-api-workflow")
    expect(executed).toContain("cleanup-compose")
  })

  test("renders Docker smoke evidence without running commands when unconfirmed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-smoke-evidence-"))
    const calls: string[] = []
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    const result = await CloudLocalDocker.smokeRunCLI({
      directory,
      evidence: true,
      run: async (step) => {
        calls.push(step.name)
        return { ok: true, stdout: "", stderr: "" }
      },
    })
    const evidence = JSON.parse(result.output) as { status: string; confirmed: boolean; staticCheck: { ok: boolean }; plan: { steps: Array<{ name: string }> } }

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([])
    expect(evidence.status).toBe("docker_smoke_preflight_evidence")
    expect(evidence.confirmed).toBe(false)
    expect(evidence.staticCheck.ok).toBe(true)
    expect(evidence.plan.steps.map((item) => item.name)).toContain("verify-api-workflow")
  })

  test("renders Docker smoke run evidence after confirmation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-smoke-run-evidence-"))
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    const result = await CloudLocalDocker.smokeRunCLI({
      directory,
      evidence: true,
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
      },
      run: async (step) => step.name === "verify-api-workflow"
        ? {
            ok: true,
            stdout: JSON.stringify({
              workspaceID: "workspace_1",
              sessionID: "session_1",
              jobID: "job_1",
              jobStatus: "succeeded",
              artifacts: 1,
              events: 5,
            }),
            stderr: "",
          }
        : { ok: true, stdout: "", stderr: "" },
    })
    const evidence = JSON.parse(result.output) as { status: string; confirmed: boolean; smoke: { ok: boolean; steps: Array<{ name: string; status: string; stdout: string }> } }

    expect(result.exitCode).toBe(0)
    expect(evidence.status).toBe("docker_smoke_run_evidence")
    expect(evidence.confirmed).toBe(true)
    expect(evidence.smoke.ok).toBe(true)
    expect(evidence.smoke.steps.find((item) => item.name === "verify-api-workflow")).toMatchObject({
      status: "passed",
      stdout: JSON.stringify({
        workspaceID: "workspace_1",
        sessionID: "session_1",
        jobID: "job_1",
        jobStatus: "succeeded",
        artifacts: 1,
        events: 5,
      }),
    })
  })

  test("plans the shared-session Docker E2E path without running Docker when unconfirmed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-e2e-plan-"))
    const result = await CloudLocalDocker.e2eCLI({
      directory,
      env: {},
      run: async () => {
        throw new Error("should not execute Docker smoke without confirmation")
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain(`Wrote Cloud Runtime Docker files to ${directory}`)
    expect(result.output).toContain("Execution:     shared-session")
    expect(result.output).toContain("Cloud Runtime Docker smoke run plan")
    expect(result.output).toContain("CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e")
    expect(await Bun.file(path.join(directory, "docker-compose.yml")).exists()).toBe(true)
  })

  test("passes production image profile environment into shared-session Docker E2E generation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-e2e-production-"))
    const result = await CloudLocalDocker.e2eCLI({
      directory,
      env: {
        CLOUD_RUNTIME_IMAGE_PROFILE: "production-install",
        CLOUD_RUNTIME_CAPABILITY_PROFILE: "minimal",
      },
      run: async () => {
        throw new Error("should not execute Docker smoke without confirmation")
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Image Profile: production-install")
    expect(result.output).toContain("Runtime Profile: minimal")
    expect(await Bun.file(path.join(directory, "docker-compose.yml")).text()).toContain("cloud-runtime-opencode:1.14.28-minimal-production-install")
  })

  test("runs the shared-session Docker E2E smoke after explicit confirmation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-e2e-run-"))
    const calls: string[] = []
    const result = await CloudLocalDocker.e2eCLI({
      directory,
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
        CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE: "1",
      },
      run: async (step) => {
        calls.push(step.name)
        return step.name === "verify-api-workflow"
          ? { ok: true, stdout: JSON.stringify({ workspaceID: "workspace_1", sessionID: "session_1", jobID: "job_1", jobStatus: "succeeded", artifacts: 1, events: 4 }), stderr: "" }
          : { ok: true, stdout: `${step.name} ok`, stderr: "" }
      },
    })

    expect(result.exitCode).toBe(0)
    expect(calls).toContain("check-runtime-worker-service")
    expect(calls).toContain("verify-api-workflow")
    expect(result.output).toContain("Cloud Runtime Docker smoke run: passed")
    expect(result.output).toContain("evidence: workspace=workspace_1 session=session_1 job=job_1 status=succeeded artifacts=1 events=4")
  })

  test("uses runtime worker logs when running PostgreSQL shared-session Docker smoke from generated files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-shared-smoke-cli-"))
    const executed: string[] = []
    await CloudLocalDocker.writeFiles({
      directory,
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })
    const result = await CloudLocalDocker.smokeRunCLI({
      directory,
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
        ANTHROPIC_API_KEY: "test-key",
      },
      run: async (step) => {
        executed.push(`${step.name}:${step.command}`)
        if (step.name === "verify-api-workflow") return { ok: false, stdout: "", stderr: "runtime endpoint unavailable" }
        return { ok: true, stdout: "", stderr: "" }
      },
    })

    expect(result.exitCode).toBe(1)
    expect(executed).toContain("print-logs-on-failure:docker compose logs --tail=240 api worker runtime-worker")
    expect(result.output).toContain("runtime-worker logs")
  })

  test("stops shared-session Docker smoke before builds when runtime-worker service is missing", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-shared-runtime-missing-"))
    const executed: string[] = []
    await CloudLocalDocker.writeFiles({
      directory,
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })
    const result = await CloudLocalDocker.smokeRunCLI({
      directory,
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
        ANTHROPIC_API_KEY: "test-key",
      },
      run: async (step) => {
        executed.push(step.name)
        if (step.name === "check-runtime-worker-service") return { ok: false, stdout: "", stderr: "no runtime-worker" }
        return { ok: true, stdout: "", stderr: "" }
      },
    })

    expect(result.exitCode).toBe(1)
    expect(executed).toEqual([
      "check-docker",
      "check-docker-compose",
      "check-api-port",
      "check-build-context",
      "check-runtime-worker-service",
      "print-logs-on-failure",
      "cleanup-compose",
    ])
    expect(result.output).toContain("next: regenerate .cloud-runtime-shared with bun run cloud:docker:shared so docker compose includes runtime-worker")
  })

  test("requires explicit confirmation before running real Docker smoke commands", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-smoke-confirm-"))
    const calls: string[] = []
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    const result = await CloudLocalDocker.smokeRunCLI({
      directory,
      run: async (step) => {
        calls.push(step.name)
        return { ok: true, stdout: "", stderr: "" }
      },
    })

    expect(result.exitCode).toBe(1)
    expect(calls).toEqual([])
    expect(result.output).toContain("Cloud Runtime Docker smoke confirmation: failed")
    expect(result.output).toContain(
      "[failed] real-docker-confirmation: set CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 to run real Docker smoke",
    )
  })

  test("runs real Docker smoke commands after explicit confirmation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-smoke-confirmed-"))
    const calls: string[] = []
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    const result = await CloudLocalDocker.smokeRunCLI({
      directory,
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
      },
      run: async (step) => {
        calls.push(step.name)
        return { ok: true, stdout: "", stderr: "" }
      },
    })

    expect(result.exitCode).toBe(0)
    expect(calls).toContain("check-docker")
    expect(calls).toContain("check-docker-compose")
    expect(calls).toContain("check-api-port")
    expect(calls).toContain("check-build-context")
    expect(calls).toContain("verify-api-workflow")
  })

  test("fails Docker smoke run before builds when local preflight detects a busy API port", async () => {
    const result = await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({ directory: ".cloud-runtime", commands: CloudLocalDocker.commands() }),
      run: async (step) => {
        if (step.name === "check-api-port") return { ok: false, stdout: "", stderr: "port 8787 is already in use" }
        return { ok: true, stdout: "", stderr: "" }
      },
    })

    expect(result.ok).toBe(false)
    expect(result.steps.map((item) => [item.name, item.status])).toEqual([
      ["check-docker", "passed"],
      ["check-docker-compose", "passed"],
      ["check-api-port", "failed"],
      ["check-build-context", "skipped"],
      ["build-api-image", "skipped"],
      ["build-worker-image", "skipped"],
      ["build-runtime-image", "skipped"],
      ["start-compose", "skipped"],
      ["wait-api-health", "skipped"],
      ["verify-api-workflow", "skipped"],
      ["print-logs-on-failure", "passed"],
      ["cleanup-compose", "passed"],
    ])
    expect(CloudLocalDocker.smokeRunResultSummary(result)).toContain("stderr: port 8787 is already in use")
  })

  test("stops the Docker smoke CLI path when static directory checks fail", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-smoke-preflight-"))
    const calls: string[] = []
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "simulate" })
    await Bun.write(path.join(directory, "Dockerfile.cloud-opencode-runtime"), "FROM scratch\n")
    const result = await CloudLocalDocker.smokeRunCLI({
      directory,
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
      },
      run: async (step) => {
        calls.push(step.name)
        return { ok: true, stdout: "", stderr: "" }
      },
    })

    expect(result.exitCode).toBe(1)
    expect(calls).toEqual([])
    expect(result.output).toContain("Cloud Runtime Docker static check: failed")
    expect(result.output).toContain("[failed] build-runtime-image")
  })

  test("stops real opencode Docker smoke before builds when no model credential is configured", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-model-preflight-"))
    const calls: string[] = []
    await CloudLocalDocker.writeFiles({ directory, workerExecutionMode: "opencode" })
    const result = await CloudLocalDocker.smokeRunCLI({
      directory,
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_DOCKER: "1",
      },
      run: async (step) => {
        calls.push(step.name)
        return { ok: true, stdout: "", stderr: "" }
      },
    })

    expect(result.exitCode).toBe(1)
    expect(calls).toEqual([])
    expect(result.output).toContain("Cloud Runtime Docker model preflight: failed")
    expect(result.output).toContain("[failed] model-credential")
    expect(result.output).toContain("set a provider API key env such as ANTHROPIC_API_KEY, OPENAI_API_KEY, or any *_API_KEY")
    expect(result.output).toContain("accepted keys: ANTHROPIC_API_KEY, OPENAI_API_KEY")
  })

  test("builds a Bun spawn adapter for real Docker smoke commands", async () => {
    const calls: Array<{ cmd: string[]; cwd: string }> = []
    const result = await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({
        directory: ".cloud-runtime",
        healthRetries: 1,
        commands: CloudLocalDocker.commands(),
      }),
      run: CloudLocalDocker.bunSmokeExecutor({
        directory: ".cloud-runtime",
        spawn: async (input) => {
          calls.push({ cmd: input.cmd, cwd: input.cwd })
          return { exitCode: 0, stdout: input.cmd.join(" "), stderr: "" }
        },
      }),
    })

    expect(result.ok).toBe(true)
    expect(calls[0]).toEqual({
      cmd: ["docker", "info"],
      cwd: ".cloud-runtime",
    })
    expect(calls[1]).toEqual({
      cmd: ["docker", "compose", "version"],
      cwd: ".cloud-runtime",
    })
    expect(calls[2]).toEqual({
      cmd: ["sh", "-lc", "! lsof -iTCP:8787 -sTCP:LISTEN"],
      cwd: ".cloud-runtime",
    })
    expect(calls[3]).toEqual({
      cmd: ["test", "-d", "../../.."],
      cwd: ".cloud-runtime",
    })
    expect(calls[4]).toEqual({
      cmd: ["docker", "build", "-f", "Dockerfile.cloud-api", "-t", "cloud-runtime-api:dev", "../../.."],
      cwd: ".cloud-runtime",
    })
    expect(calls.find((item) => item.cmd.includes("./smoke-api-workflow.ts"))?.cmd).toEqual(["bun", "run", "./smoke-api-workflow.ts"])
    expect(calls.at(-1)?.cmd).toEqual(["docker", "compose", "down", "-v"])
  })

  test("uses smoke plan directory for real Docker command execution", async () => {
    const calls: Array<{ cmd: string[]; cwd: string }> = []
    await CloudLocalDocker.runSmokePlan({
      plan: CloudLocalDocker.smokeRunPlan({
        directory: "/tmp/cloud-runtime",
        healthRetries: 1,
        commands: CloudLocalDocker.commands(),
      }),
      run: CloudLocalDocker.bunSmokeExecutor({
        directory: "/tmp/cloud-runtime",
        spawn: async (input) => {
          calls.push({ cmd: input.cmd, cwd: input.cwd })
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      }),
    })

    expect(calls.every((item) => item.cwd === "/tmp/cloud-runtime")).toBe(true)
  })

  test("plans a Docker compose bundle without confirmation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-bundle-plan-"))
    const result = await CloudLocalDocker.bundleCLI({
      directory,
      env: {
        CLOUD_RUNTIME_IMAGE_PROFILE: "production-install",
        CLOUD_RUNTIME_STORAGE_BACKEND: "postgres",
        CLOUD_RUNTIME_EXECUTION_MODE: "shared-session",
      },
      run: async () => {
        throw new Error("should not run bundle commands without confirmation")
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime Docker bundle plan")
    expect(result.output).toContain("docker image inspect cloud-runtime-api:production-install cloud-runtime-worker:production-install cloud-runtime-opencode:1.14.28-standard-production-install")
    expect(result.output).toContain("Set CLOUD_RUNTIME_CONFIRM_DOCKER_BUNDLE=1")
    expect(await Bun.file(path.join(directory, "REMOTE_DOCKER.md")).exists()).toBe(true)
  })

  test("runs Docker compose bundle after explicit confirmation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-bundle-run-"))
    const calls: string[] = []
    const result = await CloudLocalDocker.bundleCLI({
      directory,
      env: {
        CLOUD_RUNTIME_CONFIRM_DOCKER_BUNDLE: "1",
        CLOUD_RUNTIME_IMAGE_PROFILE: "production-install",
        CLOUD_RUNTIME_STORAGE_BACKEND: "postgres",
        CLOUD_RUNTIME_EXECUTION_MODE: "shared-session",
      },
      run: async (step) => {
        calls.push(`${step.name}:${"args" in step && Array.isArray(step.args) ? step.args.join(" ") : step.command}`)
        return { ok: true, stdout: `${step.name} ok`, stderr: "" }
      },
    })

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([
      "check-docker:docker info",
      "check-images:docker image inspect cloud-runtime-api:production-install cloud-runtime-worker:production-install cloud-runtime-opencode:1.14.28-standard-production-install",
      "save-images:sh -lc mkdir -p image-archive && docker save cloud-runtime-api:production-install cloud-runtime-worker:production-install cloud-runtime-opencode:1.14.28-standard-production-install -o image-archive/cloud-runtime-images.tar",
      "create-compose-bundle:sh -lc tar -czf cloud-runtime-compose-bundle.tgz docker-compose.yml api.env worker.env runtime-profile.json smoke-api-workflow.ts REMOTE_DOCKER.md image-archive",
    ])
    expect(result.output).toContain("Cloud Runtime Docker bundle: passed")
    expect(result.output).toContain("Bundle artifact: cloud-runtime-compose-bundle.tgz")
  })

  test("plans Docker compose bundle verification without confirmation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-bundle-verify-plan-"))
    await CloudLocalDocker.writeFiles({
      directory,
      imageProfile: "production-install",
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })
    const result = await CloudLocalDocker.bundleVerifyCLI({
      directory,
      env: {
        CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE: "1",
      },
      run: async () => {
        throw new Error("should not verify bundle without confirmation")
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Cloud Runtime Docker model preflight: passed")
    expect(result.output).toContain("Cloud Runtime Docker bundle verify plan")
    expect(result.output).toContain("docker load -i image-archive/cloud-runtime-images.tar")
    expect(result.output).toContain("Set CLOUD_RUNTIME_CONFIRM_DOCKER_BUNDLE_VERIFY=1")
  })

  test("runs Docker compose bundle verification after explicit confirmation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cloud-docker-bundle-verify-run-"))
    const calls: string[] = []
    await CloudLocalDocker.writeFiles({
      directory,
      imageProfile: "production-install",
      storageBackend: "postgres",
      workerExecutionMode: "shared-session",
    })
    const result = await CloudLocalDocker.bundleVerifyCLI({
      directory,
      env: {
        CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE: "1",
        CLOUD_RUNTIME_CONFIRM_DOCKER_BUNDLE_VERIFY: "1",
      },
      run: async (step) => {
        calls.push(step.name)
        return step.name === "verify-api-workflow"
          ? { ok: true, stdout: JSON.stringify({ workspaceID: "workspace_1", sessionID: "session_1", jobID: "job_1", jobStatus: "succeeded", artifacts: 1, events: 4 }), stderr: "" }
          : { ok: true, stdout: `${step.name} ok`, stderr: "" }
      },
    })

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([
      "check-docker",
      "check-docker-compose",
      "check-api-port",
      "check-image-archive",
      "load-images",
      "start-compose",
      "wait-api-health",
      "verify-api-workflow",
      "cleanup-compose",
    ])
    expect(result.output).toContain("Cloud Runtime Docker bundle verify: passed")
    expect(result.output).toContain("evidence: workspace=workspace_1 session=session_1 job=job_1 status=succeeded artifacts=1 events=4")
  })

  test("exposes a package script for static Docker checks", async () => {
    expect((await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts["cloud:docker:check"]).toBe(
      "bun run ./src/cloud/local-docker.ts --check",
    )
  })

  test("exposes a package script for planned real Docker smoke runs", async () => {
    expect((await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts["cloud:docker:smoke"]).toBe(
      "bun run ./src/cloud/local-docker.ts --smoke",
    )
  })

  test("exposes a package script for explicit real Docker smoke execution", async () => {
    expect((await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts["cloud:docker:smoke:run"]).toBe(
      "bun run ./src/cloud/local-docker.ts --smoke-run",
    )
  })

  test("exposes a package script for Docker smoke evidence", async () => {
    expect((await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts["cloud:docker:smoke:evidence"]).toBe(
      "bun run ./src/cloud/local-docker.ts --smoke-evidence",
    )
  })

  test("exposes package scripts for Docker compose bundle generation", async () => {
    const scripts = (await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts

    expect(scripts["cloud:docker:bundle"]).toBe("bun run ./src/cloud/local-docker.ts --bundle")
    expect(scripts["cloud:docker:bundle:production"]).toBe(
      "CLOUD_RUNTIME_IMAGE_PROFILE=production-install CLOUD_RUNTIME_STORAGE_BACKEND=postgres CLOUD_RUNTIME_EXECUTION_MODE=shared-session bun run ./src/cloud/local-docker.ts --bundle .cloud-runtime-shared-production",
    )
    expect(scripts["cloud:docker:bundle:verify"]).toBe("bun run ./src/cloud/local-docker.ts --bundle-verify")
    expect(scripts["cloud:docker:bundle:production:verify"]).toBe(
      "CLOUD_RUNTIME_IMAGE_PROFILE=production-install CLOUD_RUNTIME_STORAGE_BACKEND=postgres CLOUD_RUNTIME_EXECUTION_MODE=shared-session bun run ./src/cloud/local-docker.ts --bundle-verify .cloud-runtime-shared-production",
    )
  })

  test("exposes package scripts for the PostgreSQL shared-session Docker profile", async () => {
    const scripts = (await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts

    expect(scripts["cloud:docker:shared"]).toBe(
      "CLOUD_RUNTIME_STORAGE_BACKEND=postgres CLOUD_RUNTIME_EXECUTION_MODE=shared-session bun run ./src/cloud/local-docker.ts .cloud-runtime-shared",
    )
    expect(scripts["cloud:docker:shared:check"]).toBe(
      "bun run ./src/cloud/local-docker.ts --check .cloud-runtime-shared",
    )
    expect(scripts["cloud:docker:shared:smoke"]).toBe(
      "bun run ./src/cloud/local-docker.ts --smoke .cloud-runtime-shared",
    )
    expect(scripts["cloud:docker:shared:smoke:run"]).toBe(
      "bun run ./src/cloud/local-docker.ts --smoke-run .cloud-runtime-shared",
    )
    expect(scripts["cloud:docker:shared:smoke:evidence"]).toBe(
      "bun run ./src/cloud/local-docker.ts --smoke-evidence .cloud-runtime-shared",
    )
    expect(scripts["cloud:docker:e2e"]).toBe(
      "bun run ./src/cloud/local-docker.ts --e2e .cloud-runtime-shared",
    )
    expect(scripts["cloud:docker:e2e:evidence"]).toBe(
      "bun run ./src/cloud/local-docker.ts --e2e-evidence .cloud-runtime-shared",
    )
    expect(scripts["cloud:docker:e2e:production"]).toBe(
      "CLOUD_RUNTIME_IMAGE_PROFILE=production-install bun run ./src/cloud/local-docker.ts --e2e .cloud-runtime-shared-production",
    )
    expect(scripts["cloud:docker:e2e:production:evidence"]).toBe(
      "CLOUD_RUNTIME_IMAGE_PROFILE=production-install bun run ./src/cloud/local-docker.ts --e2e-evidence .cloud-runtime-shared-production",
    )
  })

  test("exposes a package script for the experimental production-install Docker profile", async () => {
    expect((await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts["cloud:docker:production-install"]).toBe(
      "CLOUD_RUNTIME_IMAGE_PROFILE=production-install bun run ./src/cloud/local-docker.ts .cloud-runtime-production-install",
    )
    expect((await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts["cloud:docker:roles"]).toBe(
      "CLOUD_RUNTIME_IMAGE_PROFILE=production-install bun run ./src/cloud/local-docker.ts .cloud-runtime-roles",
    )
  })

  test("exposes package scripts for minimal, standard, and heavy runtime image profiles", async () => {
    const scripts = (await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts

    expect(scripts["cloud:docker:runtime:minimal"]).toBe(
      "CLOUD_RUNTIME_IMAGE_PROFILE=production-install CLOUD_RUNTIME_CAPABILITY_PROFILE=minimal bun run ./src/cloud/local-docker.ts .cloud-runtime-minimal",
    )
    expect(scripts["cloud:docker:runtime:standard"]).toBe(
      "CLOUD_RUNTIME_IMAGE_PROFILE=production-install CLOUD_RUNTIME_CAPABILITY_PROFILE=standard bun run ./src/cloud/local-docker.ts .cloud-runtime-standard",
    )
    expect(scripts["cloud:docker:runtime:heavy"]).toBe(
      "CLOUD_RUNTIME_IMAGE_PROFILE=production-install CLOUD_RUNTIME_CAPABILITY_PROFILE=heavy bun run ./src/cloud/local-docker.ts .cloud-runtime-heavy",
    )
  })

  test("plans a PostgreSQL Kubernetes worker Docker E2E profile", async () => {
    const result = await CloudLocalDocker.kubernetesE2ECLI({
      directory: ".cloud-runtime-k8s-worker",
      env: {
        CLOUD_RUNTIME_K8S_SERVER_URL: "http://host.docker.internal:18001",
        CLOUD_RUNTIME_K8S_ALLOW_LOCAL_PROXY: "1",
        CLOUD_RUNTIME_K8S_MAX_POLLS: "60",
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Storage:       postgres")
    expect(result.output).toContain("Execution:     kubernetes")
    expect(result.output).toContain("CLOUD_RUNTIME_K8S_SERVER_URL=http://host.docker.internal:18001")
    expect(result.output).toContain("Real run:")
    expect(result.output).toContain("CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:k8s:e2e")
  })

  test("renders Kubernetes E2E evidence without starting Docker", async () => {
    const result = await CloudLocalDocker.kubernetesE2ECLI({
      directory: ".cloud-runtime-k8s-worker",
      evidence: true,
      env: {
        CLOUD_RUNTIME_K8S_SERVER_URL: "http://host.docker.internal:18001",
        CLOUD_RUNTIME_K8S_ALLOW_LOCAL_PROXY: "1",
      },
    })
    const evidence = JSON.parse(result.output) as {
      status: string
      directory: string
      staticCheck: { ok: boolean }
      plan: { steps: Array<{ name: string }> }
    }

    expect(result.exitCode).toBe(0)
    expect(evidence.status).toBe("docker_kubernetes_e2e_plan")
    expect(evidence.directory).toBe(".cloud-runtime-k8s-worker")
    expect(evidence.staticCheck.ok).toBe(true)
    expect(evidence.plan.steps.map((item) => item.name)).toContain("verify-api-workflow")
  })

  test("renders Kubernetes E2E evidence without build steps when Docker skip build is enabled", async () => {
    const result = await CloudLocalDocker.kubernetesE2ECLI({
      directory: ".cloud-runtime-k8s-worker",
      evidence: true,
      env: {
        CLOUD_RUNTIME_DOCKER_SKIP_BUILD: "1",
        CLOUD_RUNTIME_K8S_SERVER_URL: "http://host.docker.internal:18001",
        CLOUD_RUNTIME_K8S_ALLOW_LOCAL_PROXY: "1",
      },
    })
    const evidence = JSON.parse(result.output) as {
      plan: { steps: Array<{ name: string }> }
    }

    expect(evidence.plan.steps.map((item) => item.name)).not.toContain("build-api-image")
    expect(evidence.plan.steps.map((item) => item.name)).not.toContain("build-worker-image")
    expect(evidence.plan.steps.map((item) => item.name)).not.toContain("build-runtime-image")
    expect(evidence.plan.steps.map((item) => item.name)).toContain("start-compose")
  })

  test("exposes package scripts for the PostgreSQL Kubernetes Docker profile", async () => {
    const scripts = (await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts

    expect(scripts["cloud:docker:k8s"]).toBe(
      "CLOUD_RUNTIME_STORAGE_BACKEND=postgres CLOUD_RUNTIME_EXECUTION_MODE=kubernetes bun run ./src/cloud/local-docker.ts .cloud-runtime-k8s-worker",
    )
    expect(scripts["cloud:docker:k8s:e2e"]).toBe(
      "bun run ./src/cloud/local-docker.ts --k8s-e2e .cloud-runtime-k8s-worker",
    )
    expect(scripts["cloud:docker:k8s:e2e:evidence"]).toBe(
      "bun run ./src/cloud/local-docker.ts --k8s-e2e-evidence .cloud-runtime-k8s-worker",
    )
  })
})
