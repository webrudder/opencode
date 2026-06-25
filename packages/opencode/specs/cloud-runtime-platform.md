# Cloud OpenCode Runtime Platform

This document describes a low-intrusion path for using opencode as the execution kernel inside a cloud runtime
platform.

The platform is external to opencode. It owns SaaS tenancy, job scheduling, sandboxing, files, artifacts, billing,
monitoring, and connectors. opencode runs inside a sandbox as a worker runtime and should not become the SaaS control
plane.

## Goal

Expose opencode-like agentic execution to SaaS products without asking end users to install opencode locally.

The public contract is a Cloud Runtime API:

- create logical workspaces and sessions
- upload files or structured context
- create asynchronous jobs
- query and cancel jobs
- stream job events
- download artifacts
- list and configure tools, MCP servers, skills, and connectors

opencode remains an internal runtime engine selected by the orchestrator.

## Public API Surface

- `POST /v1/workspaces`
- `POST /v1/sessions`
- `POST /v1/files`
- `GET /v1/files`
- `POST /v1/jobs`
- `GET /v1/jobs/:id`
- `POST /v1/jobs/:id/cancel`
- `GET /v1/jobs/:id/events`
- `GET /v1/jobs/:id/events/stream`
- `POST /v1/sessions/:id/messages`
- `GET /v1/sessions/:id/messages`
- `GET /v1/artifacts`
- `GET /v1/artifacts/:id/download`
- `GET /v1/tools`
- `POST /v1/webhooks`
- `GET /v1/webhooks`
- `PATCH /v1/webhooks/:id`
- `DELETE /v1/webhooks/:id`

`GET /v1/jobs/:id/events/stream` returns Server-Sent Events using the existing job event JSON as each `data` payload.
Without `follow=true`, it returns the current event page as an SSE snapshot. With `follow=true`, it polls for additional
events until a terminal job status (`succeeded`, `failed`, `canceled`, or `expired`) is observed or `timeoutMS` is
reached. `cursor`, `limit`, `pollMS`, and `timeoutMS` are query parameters so SDK consumers can resume streams without
replaying older events.

Errors use a stable JSON envelope:

```json
{
  "error": {
    "code": "not_found",
    "message": "Cloud job not found"
  }
}
```

## Non-goals

- Do not make the existing opencode server directly multi-tenant.
- Do not store tenant, user, billing, and artifact state in opencode's local session database.
- Do not let sandboxed opencode processes self-update.
- Do not let runtimes install arbitrary MCP servers, plugins, or skills from the public internet.

## Architecture

```text
SaaS Product
  -> Cloud Runtime API / SDK
    -> API Gateway
      -> Orchestrator
        -> Job Queue
          -> Worker Adapter
            -> Sandbox Runtime
              -> opencode
                -> Built-in Tools / MCP / Skills / Web / Shell
```

The control plane is stateless and horizontally scalable. Durable state lives in Postgres, object storage, a queue, and
an event stream.

The execution plane scales as a worker pool. Each job gets a short-lived sandbox by default.

## Runtime Contract

The Cloud Runtime orchestrator produces a job spec before a worker starts opencode. The first in-repo contract lives in
`src/cloud/runtime.ts`.

The contract intentionally contains only cloud-runtime adapter data:

- tenant, workspace, session, and job identifiers
- runtime engine, version, image, image digest, and profile
- final model selection and budget
- resolved MCP configuration and skill bundle paths
- tool policy
- file inputs and desired output kinds

The worker adapter converts that spec into:

- opencode config
- opencode environment variables
- OpenTelemetry resource attributes

The adapter always disables opencode local autoupdate.

## Runtime Lifecycle

1. API creates a job in `queued`.
2. Scheduler leases the job.
3. Worker creates a sandbox and downloads input files.
4. Worker writes opencode config from the job spec.
5. Worker injects short-lived credentials and telemetry attributes.
6. Sandbox starts fixed-version opencode.
7. opencode executes prompts and tools.
8. Worker captures messages, tool calls, usage, and artifacts.
9. Worker uploads artifacts to object storage.
10. Job finishes and the sandbox is destroyed.

Job states:

```text
queued -> leasing -> starting -> running -> uploading -> succeeded
                                  -> failed
                                  -> canceled
                                  -> expired
```

## Tools, MCP, and Skills

Cloud Runtime tools are controlled by the platform, not by arbitrary runtime-side installation.

Supported categories:

- built-in opencode tools
- platform-managed remote MCP servers
- audited local MCP servers
- tenant connectors mediated by a connector gateway
- versioned skill bundles

Production should prefer remote MCP because it centralizes auth, audit, rate limiting, and upgrades.

OAuth belongs in the connector gateway. A runtime receives short-lived scoped tokens or connector proxy headers, never
long-lived tenant credentials.

Skill bundles are mounted read-only by version. A job records the exact skill versions it used.

## Versioning and Upgrades

opencode is versioned as part of the runtime image.

Rules:

- set `OPENCODE_DISABLE_AUTOUPDATE=true`
- record opencode version and image digest on each job
- roll out images through staging, canary, and production
- support tenant version pinning
- rollback by changing orchestrator version selection
- do not hot-upgrade running jobs

## Product 0.5 Packaging Decision

For the 0.5 product release, Cloud Runtime should move out of this additive in-tree implementation and become an
independent Cloud Runtime repository or deployable package. opencode should not be copied into that product repository as
source code. Instead, opencode should be consumed as a fixed-version runtime image dependency.

Target product shape:

```text
cloud-runtime-platform/
  api/
  worker/
  orchestrator/
  sdk/
  deploy/
  runtime-images/
    opencode/
      Dockerfile
```

The runtime image pins the opencode version and image digest. Upgrades happen by building a new runtime image, running
compatibility tests, publishing to staging, canarying selected tenants or cohorts, and rolling back through orchestrator
runtime-version selection when needed.

The current in-tree `packages/opencode/src/cloud` implementation remains valid for the 0.5 development branch because it
keeps the adapter close to opencode internals while the runtime contract is still being proven. The release boundary is:
Cloud Runtime owns the SaaS control plane; opencode remains the fixed-version execution kernel inside the runtime image.

## Observability

All runtime processes should emit OpenTelemetry logs and traces with:

- `tenant.id`
- `workspace.id`
- `session.id`
- `job.id`
- `runtime.engine`
- `runtime.version`
- `runtime.profile`
- `container.image.digest`

The platform should separately track:

- API latency and error rate
- queue depth and oldest queued job age
- sandbox start latency
- job duration and failure rate
- tool call duration and failure rate
- model tokens, retries, and estimated cost
- artifact upload and download failures

## Delivery Phases

1. Land the low-intrusion runtime contract and worker-adapter helpers.
2. Build the external API, database schema, object storage, and job queue.
3. Build a local worker adapter that can run one opencode job.
4. Add artifact upload/download and event streaming.
5. Add tenant/user auth, API keys, and audit events.
6. Move execution into Kubernetes sandboxes with resource limits.
7. Add managed MCP, versioned skills, and connector gateway integration.
8. Add worker leases, heartbeat, cancellation, timeout, and autoscaling.
9. Add production dashboards, alerts, and cost attribution.
10. Add runtime image canary and rollback.
11. Publish the TypeScript SDK and example SaaS integration.
12. For product 0.5, split Cloud Runtime into an independent repository/package and consume opencode only as a
    fixed-version runtime image dependency.

## Completion Audit

Current implementation status is based on files in `src/cloud`, tests in `test/cloud`, package scripts, and the safe
verification chain. This is an implementation audit, not proof that a real production environment has been operated.

Status categories:

- `implemented`: code paths, tests, and local/CI-safe commands exist in this branch.
- `implemented, needs real run`: code paths and preflight/audit commands exist, but completion requires credentials,
  Docker, or provider infrastructure outside the repository.
- `planned adapter`: pure plans or injected adapters exist, but no concrete production client is intentionally wired yet.

| Requirement | Status | Evidence | Remaining proof |
| --- | --- | --- | --- |
| Low-intrusion OpenCode kernel, not SaaS control plane | implemented | `src/cloud/*` is separate from existing opencode server/session storage; runtime config disables autoupdate | code review before merge |
| Public Cloud Runtime API for workspaces, sessions, files, jobs, events, messages, artifacts, tools, and webhooks | implemented | `src/cloud/routes.ts`, `src/cloud/api.ts`, `src/cloud/openapi.ts`, `test/cloud/routes.test.ts`, `test/cloud/openapi.test.ts` | real server deployment smoke |
| Tenant/auth/gateway boundaries | implemented | `src/cloud/api-key.ts`, `src/cloud/gateway.ts`, `src/cloud/access.ts`, `src/cloud/rate-limit.ts`, route guard tests | production tenant onboarding flow |
| Session history and platform-owned messages | implemented | memory, SQLite, and PostgreSQL services persist/list messages | real DB migration in target environment |
| Artifact manifest, signed download, and object storage upload path | implemented | `src/cloud/artifact.ts`, `src/cloud/storage-service.ts`, `src/cloud/s3-storage-runner.ts`, SQLite/Postgres server tests | real S3/R2/GCS bucket run |
| SQLite local MVP | implemented | SQLite schema/service/server/worker-loop/local runtime tests | optional local manual run |
| Real local OpenCode executor mode | implemented, real-run verified | `src/cloud/local-executor.ts`, `src/cloud/local-worker.ts`, `src/cloud/local-opencode-smoke.ts`, `cloud:opencode:plan`, tests with injected executor, DashScope Anthropic proxy smoke with `glm-5.1` | additional provider/model combinations as needed |
| Local Docker API/worker/runtime topology | implemented, shared-session E2E real-run verified | `src/cloud/local-docker.ts`, generated `.cloud-runtime-shared`, `cloud:docker:e2e`, `cloud:docker:shared:check`, `cloud:docker:shared:smoke`, Docker tests, modeless shared-session E2E run, modeless shared-session smoke run, modeless BYOK shared-session smoke run; local Docker images run as numeric non-root user for Kubernetes `runAsNonRoot` compatibility | run real model-backed Docker smoke when provider credentials are available |
| PostgreSQL durable control plane | implemented | `src/cloud/postgres-runner.ts`, schema/repository/service/server/worker-loop tests | run against target Postgres and apply schema |
| PostgreSQL durable queue | implemented, local provider real-run verified | `src/cloud/postgres-queue.ts`, queue runner, API enqueue/cancel, worker lease/ack/retry tests, local Docker provider smoke enqueue/lease/ack | load/visibility tests on production DB |
| S3-compatible object storage client | implemented, local provider real-run verified | `src/cloud/s3-client.ts`, `src/cloud/s3-storage-runner.ts`, storage service/server tests, local Docker provider smoke put/list/get/sign/delete | artifact upload/download workload on target S3/R2/GCS bucket |
| Kubernetes sandbox executor | implemented, kind local real-run verified | `src/cloud/kubernetes.ts`, `src/cloud/kubernetes-executor.ts`, `src/cloud/kubernetes-smoke.ts`, `src/cloud/production-worker.ts`, K8s executor tests, local kind smoke with `cloud-runtime-opencode:1.14.28` | run against staging/production Kubernetes namespace |
| Production worker composition | implemented, needs real run | `src/cloud/production-worker.ts`, PostgreSQL worker, Kubernetes, queue, S3 writeback tests | end-to-end Postgres + queue + S3 + K8s job |
| MCP, skills, connectors, and tool policy | implemented as control-plane policy | `src/cloud/tool-policy.ts`, `src/cloud/tool-catalog.ts`, `src/cloud/connector.ts`, orchestrator tests | connect real managed MCP/connector gateway |
| Monitoring, metrics, alerts, and cost attribution helpers | implemented | `src/cloud/metrics.ts`, `src/cloud/alert.ts`, `src/cloud/usage.ts`, `src/cloud/budget.ts`, tests | wire real OTEL collector/dashboard and billing sink |
| Runtime version, canary, release, rollback | implemented | `src/cloud/runtime-version.ts`, `src/cloud/release.ts`, release tests, `cloud:release:check` | CI image build/push and staged rollout job |
| Provider readiness and real-environment audit | implemented, local provider real-run verified | `src/cloud/provider-readiness.ts`, `src/cloud/provider-smoke.ts`, `src/cloud/verification.ts`, `cloud:verify --check`, `cloud:verify --audit`, local Docker provider health/smoke | run provider health/smoke against target production providers |
| TypeScript SDK and example SaaS flow | implemented | `src/cloud/sdk.ts`, `src/cloud/example-saas.ts`, SDK/example tests | publish/package and run against deployed API |
| Existing opencode source package relationship | implemented as additive package-local cloud modules for development; product 0.5 split is required | package scripts and cloud modules live inside `packages/opencode`; generated Docker/K8s artifacts are ignored; `Product 0.5 Packaging Decision` records the release boundary | before product 0.5, move Cloud Runtime into an independent repository/package and consume opencode only as a fixed-version runtime image dependency |

Safe verification currently passes with:

```bash
bun test test/cloud
bun typecheck
bun run cloud:verify --check
bun run cloud:verify --report
bun run cloud:verify --runbook
bun run cloud:verify --evidence
bun run cloud:local:acceptance
bun run cloud:local:acceptance:json
bun run cloud:docker:k8s:e2e
bun run cloud:docker:k8s:e2e:evidence
```

The goal should not be considered production-complete until at least one real run succeeds for:

```bash
CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 bun run cloud:opencode:smoke
CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:run .cloud-runtime-opencode
CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e
CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_SMOKE_BYOK_SECRET=$ANTHROPIC_API_KEY CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e
CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run
CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run
CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 CLOUD_RUNTIME_K8S_SERVER_URL=http://127.0.0.1:18001 CLOUD_RUNTIME_K8S_ALLOW_LOCAL_PROXY=1 bun run cloud:k8s:smoke:json
CLOUD_RUNTIME_K8S_SERVER_URL=http://host.docker.internal:18001 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:k8s:e2e
CLOUD_RUNTIME_DOCKER_SKIP_BUILD=1 CLOUD_RUNTIME_K8S_SERVER_URL=http://host.docker.internal:18001 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:k8s:e2e
bun run cloud:providers:check --health
```

Use Docker evidence mode to produce machine-readable JSON for operator logs or CI artifacts:

```bash
bun run cloud:docker:smoke:evidence
CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:smoke:evidence
```

Use API smoke mode to verify the public SaaS-facing API. The default command uses the same Hono app in-process so it can
run inside restricted CI sandboxes; server mode starts a temporary local listener when the environment allows binding a
port; `CLOUD_RUNTIME_API_SMOKE_BASE_URL` targets an already deployed API:

```bash
bun run cloud:api:smoke
bun run cloud:api:smoke:json
CLOUD_RUNTIME_API_SMOKE_REAL_SERVER=1 bun run cloud:api:smoke
CLOUD_RUNTIME_API_SMOKE_BASE_URL=https://runtime.example.com CLOUD_RUNTIME_API_KEY=... bun run cloud:api:smoke
```

Current real-run evidence:

- `CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e` passed
  locally: Docker built API/worker/runtime images, started Postgres/MinIO/API/worker/runtime-worker, `/health` passed
  after two attempts, the smoke workflow completed `workspace_1` / `session_1` / `job_1` with `status=succeeded`,
  `artifacts=1`, `events=7`, then completed same-session follow-up `job_2` with `status=succeeded`, `artifacts=1`,
  `events=7`, and `docker compose down -v` removed containers, network, and volumes.
- `CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_SMOKE_BYOK_SECRET=sk-smoke-byok-test CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1
  CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:e2e` passed locally and returned `credentialID:
  "llmcred_1"` in the smoke API workflow evidence, while both `job_1` and same-session follow-up `job_2` completed
  with `status=succeeded`, `artifacts=1`, and `events=7`, proving the scoped BYOK credential path reaches job creation
  and shared-session runtime execution without exposing the raw secret in the summarized evidence.
- `CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run cloud:docker:shared:smoke:run`
  passed locally: Docker built API/worker/runtime images, started Postgres/MinIO/API/worker/runtime-worker, completed a
  job and same-session follow-up job, observed artifacts, and cleaned up Compose volumes.
- `CLOUD_RUNTIME_SMOKE_BYOK=1 CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE=1 CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1 bun run
  cloud:docker:shared:smoke:run` passed locally and returned `credentialID: "llmcred_1"` in the generated smoke API
  workflow evidence, proving the scoped BYOK credential path reaches job creation and runtime execution.
- `CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 CLOUD_RUNTIME_K8S_SERVER_URL=http://127.0.0.1:18001
  CLOUD_RUNTIME_K8S_ALLOW_LOCAL_PROXY=1 CLOUD_RUNTIME_NAMESPACE=cloud-runtime
  CLOUD_RUNTIME_K8S_SMOKE_IMAGE=cloud-runtime-opencode:1.14.28 bun run cloud:k8s:smoke:json` passed locally against
  a `kind` cluster named `cloud-runtime-local` after loading the local runtime image. The smoke created a NetworkPolicy
  and pod in the `cloud-runtime` namespace, ran `/bin/sh -lc "echo cloud-runtime-k8s-smoke"` inside the runtime image,
  observed `phase=Succeeded`, `exitCode=0`, log output `cloud-runtime-k8s-smoke`, and cleaned up the sandbox resources.
- `CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker bun run cloud:providers:check --health` passed locally against the generated
  Docker provider profile: Postgres `select 1` succeeded, the MinIO `runtime-artifacts` bucket was reachable, and the
  Postgres-backed queue health plan was reachable while Kubernetes was intentionally skipped for `local-docker`.
- `CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke`
  passed locally after applying the Postgres schema with 22 tables and 40 indexes, creating the smoke tenant/user/
  workspace/session/job fixture required by the queue foreign keys, enqueueing/leasing/acking `cloud-runtime-jobs`, and
  writing/listing/reading/signing/deleting a probe object under `runtime-artifacts/cloud-runtime-smoke/...`.
- `bun run cloud:local:acceptance` now prints the local acceptance sequence that was verified on the developer machine:
  modeless shared-session Docker E2E passed, local provider stack startup passed, provider smoke bootstrapped Postgres
  schema and verified queue/object storage, provider health passed after schema bootstrap, provider stack cleanup passed,
  and kind Kubernetes smoke passed through a temporary `kubectl proxy`.
- `CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 CLOUD_RUNTIME_OPENCODE_COMMAND=/Users/simontu/.opencode/bin/opencode
  CLOUD_RUNTIME_MODEL_PROVIDER=anthropic CLOUD_RUNTIME_MODEL=glm-5.1 CLOUD_RUNTIME_MODEL_CREDENTIAL_ENV=ANTHROPIC_API_KEY
  CLOUD_RUNTIME_MODEL_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic/v1 bun run cloud:opencode:smoke` passed
  locally with a DashScope Anthropic-compatible proxy: preflight passed, opencode executed the real model-backed job,
  `workspace_1/session_1/job_1` finished `status=succeeded`, produced `local-opencode-smoke-report.md`, registered
  `artifacts=1`, and emitted `events=7`. The secret value was supplied only through a temporary environment variable and
  was not written to repository files.

Use `bun run cloud:verify --audit` first to see missing real-environment confirmation flags, model credentials, provider
credentials, and Kubernetes settings without starting Docker, invoking opencode, or connecting to providers. Failed audit
checks include remediation hints for the exact environment variable or confirmation flag to set next.

Use `bun run cloud:verify --preflight` after the audit passes to probe the local operator machine for the opencode
binary, writable smoke paths, Docker daemon, Docker Compose, free API port, and provider environment before starting real
smoke jobs.

Use `bun run cloud:opencode:preflight` when only the local non-Docker opencode smoke prerequisites need to be checked.
This command does not require `CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1` and does not invoke a model-backed job; it reports
missing executable, model credential, timeout, SQLite path, and sandbox path issues with remediation hints.

Use `CLOUD_RUNTIME_MODEL_PROVIDER`, `CLOUD_RUNTIME_MODEL`, optionally `CLOUD_RUNTIME_MODEL_CREDENTIAL_ENV`, and optionally
`CLOUD_RUNTIME_MODEL_BASE_URL` when the real local opencode smoke should verify a customer-owned provider proxy or
OpenAI-compatible model credential. For example, `CLOUD_RUNTIME_MODEL_PROVIDER=anthropic CLOUD_RUNTIME_MODEL=glm-5.1
CLOUD_RUNTIME_MODEL_CREDENTIAL_ENV=ANTHROPIC_API_KEY CLOUD_RUNTIME_MODEL_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic
ANTHROPIC_API_KEY=... bun run cloud:opencode:preflight` checks the customer key and proxy base URL without writing the
secret to repository files.

Use `bun run cloud:opencode:evidence` to emit machine-readable local opencode plan/preflight evidence without running a
model-backed job. Use `CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 bun run cloud:opencode:evidence` after a model key is
configured to capture the real local opencode smoke result as JSON evidence.

Use `bun run cloud:providers:env` to print a production provider environment template for Postgres, S3-compatible object
storage, queue, and Kubernetes. Use `CLOUD_RUNTIME_PROVIDER_PROFILE=local-docker bun run cloud:providers:env` for the
local Docker Postgres/MinIO defaults.

Use `bun run cloud:providers:evidence` to emit machine-readable provider readiness evidence, and
`bun run cloud:providers:evidence --health` to capture per-provider real health results for Postgres, object storage,
queue, and Kubernetes after real credentials are configured.

Use provider smoke after health checks pass to verify real provider write/read behavior. It applies the Postgres schema,
enqueues/leases/acks a queue message, and writes/lists/reads/signs/deletes an object storage probe under a smoke prefix:

```bash
CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke
CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 bun run cloud:providers:smoke:json
```

Use Kubernetes smoke after Kubernetes credentials are configured to verify the sandbox executor against a real namespace.
It creates a NetworkPolicy and short-lived smoke Pod, waits for terminal status, reads logs, and deletes the resources:

```bash
CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 bun run cloud:k8s:smoke
CLOUD_RUNTIME_CONFIRM_K8S_SMOKE=1 bun run cloud:k8s:smoke:json
```

Use `bun run cloud:real-runbook:check` as the safe pre-real-run gate. It aggregates the real-environment audit, local
opencode preflight, and provider readiness without invoking a model-backed job or connecting to provider health
endpoints.

Use `bun run cloud:verify --report` when a reviewer or operator needs a human-readable implementation status, including
implemented requirements, requirements that still need real-run proof, and the exact next verification commands.

Use `bun run cloud:verify --runbook` when an operator is ready to run the real-environment proof; it prints the
preflight audit, local opencode smoke, Docker smoke, provider health, and release gate sequence with success evidence
and failure triage for each step.

Use `bun run cloud:verify --evidence` when CI, PRs, or technical reviews need a stable JSON summary of implemented
requirements, evidence files, safe/audit/preflight/real verification commands, runbook entrypoints, and remaining
real-run proof.

Use `bun run cloud:local:acceptance` for the local developer-machine acceptance route. It prints the exact sequence for
safe code verification, shared-session Docker E2E, starting a local provider stack, local Docker provider smoke/health,
provider stack cleanup, kind Kubernetes sandbox smoke, and the PostgreSQL-backed Kubernetes worker Docker E2E route. Use
`bun run cloud:local:acceptance:json` when CI or a technical review needs the same local acceptance plan as
machine-readable evidence.

Use `bun run cloud:docker:k8s:e2e` to generate the local production-composition profile: Postgres-backed API and worker
run in Docker, the worker uses `CLOUD_RUNTIME_EXECUTION_MODE=kubernetes`, artifacts are written to MinIO, and sandbox
execution is delegated to the configured Kubernetes API. For a local kind cluster through `kubectl proxy`, set
`CLOUD_RUNTIME_K8S_SERVER_URL=http://host.docker.internal:18001` so the Docker worker can reach the host proxy. This path
is model-backed unless a future dedicated Kubernetes modeless smoke command is added.

For local provider checks, run provider smoke before provider health on a fresh stack: smoke applies the Postgres schema
that the queue health check expects. When running these commands from Codex or another restricted shell, commands that
connect to localhost Docker services or `kubectl proxy` may need to run outside the tool sandbox.

## First In-repo Slice

The first in-repo implementation should stay small:

- add a pure runtime contract module
- add pure platform domain schemas and job transition validation
- add a pure worker launch plan helper for the future sandbox worker
- add a pure artifact manifest contract for collecting sandbox outputs
- add a pure orchestrator planner that turns API requests into runtime job specs
- add pure lease and heartbeat rules for future queue workers
- add pure tenant and user access helpers for future API and storage boundaries
- add pure tenant policy normalization helpers for model allowlists, runtime defaults, tool policy, budget, and rate limits
- add pure API key issue, hash, and bearer authentication helpers for future SaaS API gateway adapters
- add reusable gateway guard helpers for API key authentication, stable JSON unauthorized errors, and allowlist CORS
  preflight/response headers
- add reusable request ID helpers so API responses can echo caller-provided `x-request-id` or generate one for tracing
- add pure tenant/action rate limit helpers for future API gateway and quota enforcement
- add pure job event builders, cursor streaming, paginated event API responses, checkpoint, and tenant-scoped checkpoint storage helpers for worker/API/webhook event streams
- add a pure in-memory store contract for future API handlers and database adapters
- add a pure service layer that composes API requests, orchestration, store writes, job lookup, job cancellation, and initial job events
- add pure session message request, storage, and listing helpers for platform-owned conversation history
- add pure file metadata storage and service helpers behind an injected object-storage staging adapter
- add pure Drizzle table contract definitions for the external Cloud Runtime persistence model
- add pure repository row mapping and transaction plan helpers for future database adapters
- add pure database adapter operation helpers for transactional insert/update/delete execution planning
- add pure object storage key, upload plan, signed download plan, and tenant object boundary helpers
- add pure object storage adapter operation helpers for input upload, sandbox staging, artifact upload/copy, signed download, and retention cleanup
- add a generic S3-compatible object storage runner that executes provider-neutral put/get/copy/sign/delete-prefix
  operations through an injected client so AWS S3, R2, GCS S3 compatibility, or MinIO adapters can share the same
  runtime control-plane operation model
- add a storage service wiring helper and SQLite-backed API integration path so `/v1/files` can persist uploaded
  content through an injected S3-compatible client and `/v1/artifacts/:id/download` can return storage-signed URLs
- add local opencode worker artifact upload through the same S3-compatible runner, including a failure path that marks
  the job failed instead of recording artifact metadata when object storage upload fails
- add a generic queue runner for enqueue, lease, heartbeat, ack, retry, and cancel operations through injected queue
  clients, plus an in-memory queue client for local MVP execution with visibility timeout, priority, retry, and cancel
- add SQLite-backed API enqueue wiring so job creation can write durable DB state and dispatch the job to an injected
  queue client without exposing queue internals through the public API
- add SQLite-backed API cancellation queue wiring so local API cancel requests can update DB state and notify an injected
  queue client with the same public behavior as the PostgreSQL server adapter
- add local worker queue lease gating and terminal queue acknowledgement so workers can coordinate through an injected
  queue client before mutating SQLite state, and ack succeeded/failed terminal outcomes back to the queue
- add a PostgreSQL-backed queue client and `cloud_queue_message` schema so production deployments can run durable
  enqueue, lease, heartbeat, ack, retry, and cancel semantics through the same queue runner interface
- wire the PostgreSQL-backed API server to enqueue newly created jobs through the PostgreSQL queue client by default,
  preserving the public API surface while making the production control plane queue-backed
- wire the PostgreSQL-backed API server to cancel durable queue messages when jobs are canceled through the public API,
  preventing workers from leasing canceled jobs after the DB state has moved to `canceled`
- add PostgreSQL worker queue lease gating and terminal queue acknowledgement so production workers can coordinate
  through `cloud_queue_message` before mutating job state and ack succeeded/failed outcomes back to the durable queue
- add PostgreSQL worker heartbeat synchronization with durable queue visibility timeout so long-running jobs refresh both
  `cloud_job_lease` and `cloud_queue_message.lease_expires_at`
- add PostgreSQL worker failure retry integration so failed attempts can requeue through durable queue backoff until
  `maxAttempts`, then acknowledge the queue as terminally failed
- wire retry policy into the local worker entrypoint so `CLOUD_RUNTIME_RETRY_*` configuration can requeue failed local
  opencode executions through the queue while preserving terminal failed ack behavior when retry is disabled or exhausted
- add local worker execution timeout configuration so long-running local opencode executions can mark jobs `expired`,
  fail the active attempt with a timeout reason, remove the lease, and acknowledge the queue as `expired`
- add PostgreSQL worker expiration handling so production workers can mark timed-out jobs `expired`, fail the active
  attempt, remove the durable lease, and acknowledge `cloud_queue_message` as `expired`
- add worker-side cancellation finalization for SQLite/local and PostgreSQL workers so canceled jobs can mark active
  attempts `canceled`, remove leases, preserve the cancellation reason, and acknowledge queues as `canceled`
- expose local worker timeout and retry environment variables through the Docker Compose topology helper
- add local Docker deployment file generation and a `cloud:docker` package script so developers can write
  `docker-compose.yml`, `api.env`, `worker.env`, and start/stop commands into a target directory
- add local Docker README generation with API health checks, a minimal workspace/session/job workflow, and documented
  simulated versus real local opencode execution modes
- add explicit local Docker API and worker service commands so generated Compose files start the standalone Bun API and
  worker entrypoints without relying on image defaults
- configure generated local Docker files so the default API and worker containers share the same SQLite database volume,
  giving the local MVP a runnable API-to-worker job loop
- add a Postgres-backed local Docker topology option so generated API containers can use `CLOUD_RUNTIME_STORAGE=postgres`
  and generated worker containers can start the standalone PostgreSQL worker entrypoint against the shared Postgres
  service
- generate source-based local Dockerfiles and build commands for cloud API, cloud worker, and opencode runtime images so
  the default Compose image names can be built from the repository root during local development
- add a local Docker smoke plan that verifies generated Dockerfiles, build commands, Compose image references, runtime
  sandbox image configuration, health checks, and the sample API workflow before running real Docker commands
- expose the local Docker smoke plan through `bun run cloud:docker:check` and a `--check` CLI mode so developers can
  validate generated Docker wiring without starting Docker
- add a planned real Docker smoke run through `bun run cloud:docker:smoke` and `--smoke`, covering build, compose start,
  health verification, diagnostic logs on failure, and always-run cleanup without executing Docker yet
- add an injected Docker smoke runner abstraction that can execute the planned steps, retry health checks, skip normal
  steps after failure, run diagnostics on failure, and always run cleanup; tests use fake executors before real Docker
  execution is enabled
- expose explicit real Docker execution through `bun run cloud:docker:smoke:run` and `--smoke-run`; the default
  `cloud:docker:smoke` command remains plan-only to avoid accidental long-running Docker builds
- add Docker smoke execution result summaries with per-step attempt counts and compact stdout/stderr snippets so failed
  local Docker runs are diagnosable from CLI output
- add actionable `next:` suggestions to Docker smoke failure summaries for Docker daemon, Compose, API port, build context,
  API/worker/runtime image builds, Compose startup, health check, and API workflow failures
- route `cloud:docker:smoke:run` through a dependency-injected smoke-run CLI helper so the real Docker entrypoint can be
  tested without starting Docker
- expose `cloud:docker:smoke:evidence` for machine-readable Docker smoke evidence, including static checks, model
  preflight, planned commands, and real smoke step results when explicitly confirmed
- add `cloud:api:smoke`, `cloud:api:smoke:json`, and `cloud:api:smoke:server` to verify health, OpenAPI, workspace,
  session, file, job, events, tools, artifacts, and cancel endpoints against the in-process app, a temporary local HTTP
  server, or an existing deployment
- add Kubernetes deployment file generation and a `cloud:k8s` package script so production operators can render
  `cloud-runtime.k8s.yaml` plus an apply/rollout README from environment-driven deployment configuration
- add Kubernetes deployment preflight checks and a `cloud:k8s:check` package script so generated manifests can be
  validated for API/worker deployments, database secret refs, object storage, queue env, worker autoupdate disabling,
  HPA, and service wiring before `kubectl apply`
- add a release readiness summary that combines Kubernetes preflight checks, Docker smoke-plan checks, provider
  readiness, provider health checks, and runtime release gates into a single ready/blocked decision for CI or manual
  promotion reviews
- expose the same release readiness gate as `bun run cloud:release:check`, using environment-provided runtime metrics and
  safe generated Kubernetes/Docker/provider checks so CI can block promotion before any apply/push action
- add `bun run cloud:verify` as a side-effect-free verification plan that orders local Docker generation/checks, Docker
  smoke planning, local opencode planning, provider checks, Kubernetes manifest generation/checks, release readiness, and
  explicit real-environment smoke/health commands
- add `bun run cloud:verify --check` as an executable safe verification chain for local and CI use; it runs generated
  Docker/Kubernetes static checks and plan-only smoke/readiness gates with sample non-network provider/release env while
  leaving real opencode, Docker compose, and provider health checks behind explicit commands
- add `bun run cloud:verify --audit` as a side-effect-free real-environment prerequisite audit for opencode smoke, Docker
  smoke, and provider health; it reports missing confirmation flags, model credentials, provider env, and the exact
  explicit commands to run once prerequisites pass
- add `bun run cloud:verify --preflight` as an executable local operator-machine preflight that probes opencode
  availability, smoke path writability, Docker daemon/Compose availability, API port availability, and provider env
  before real smoke jobs are started
- add `bun run cloud:verify --report` as a side-effect-free human-readable implementation report for operators and
  reviewers; it summarizes implemented requirements, remaining real-run proof, and the next safe/audit/real commands
- add `bun run cloud:verify --runbook` as a side-effect-free real-run operator checklist; it orders the preflight audit,
  local opencode smoke, Docker smoke, provider health checks, and release gate with success evidence and failure triage
- add `bun run cloud:real-runbook:check` as a safe pre-real-run gate that aggregates audit, local opencode preflight,
  and provider readiness before operators run model-backed or provider-health commands
- add `bun run cloud:verify --evidence` as a side-effect-free machine-readable implementation evidence report for CI,
  PR descriptions, and technical reviews; it lists implemented requirements, evidence files, safe/audit/preflight/real
  commands, runbook entrypoints, and remaining real-run proof
- surface the same `cloud:verify --audit` command in generated Docker README files and release readiness summaries so
  local smoke runs and promotion gates both point operators at the real-environment prerequisite check first
- add provider readiness checks for Postgres, object storage, queue, and Kubernetes configuration, plus non-network health
  check plans and an injected health runner so real provider probes can be wired without changing the release gate
- add a default provider health adapter that maps health plans to Postgres `select 1`, S3-compatible bucket listing,
  queue dry-run lease, and Kubernetes namespace lookup calls through existing injected clients
- expose provider readiness as `bun run cloud:providers:check`, with a safe configuration/health-plan default and an
  explicit `--health` mode that wires real Postgres, S3-compatible object storage, PostgreSQL queue, and Kubernetes
  namespace probes from environment
- add `bun run cloud:providers:env` to print production or local-Docker provider environment templates before running
  readiness or health checks
- add `bun run cloud:providers:evidence` for machine-readable provider readiness/health evidence, including per-provider
  pass/fail results when `--health` is used against real infrastructure
- add `bun run cloud:providers:smoke` and `cloud:providers:smoke:json` for explicit-confirmation provider write/read
  validation: Postgres schema/query, PostgreSQL queue enqueue/lease/ack, and S3-compatible put/list/get/sign/delete
- add `bun run cloud:k8s:smoke` and `cloud:k8s:smoke:json` for explicit-confirmation Kubernetes sandbox validation:
  NetworkPolicy apply, Pod create/watch/logs/delete, and NetworkPolicy cleanup in a real namespace
- add a reusable Bun SQL PostgreSQL query client plus standalone Postgres API/worker entrypoint wiring so local Docker and
  production-like deployments can run the durable Postgres control plane without adding a new npm database dependency
- document local Docker smoke check, plan-only smoke, real smoke-run, and failure diagnostics in the generated README
- return static Docker wiring checks from local Docker file generation and include check/smoke next commands in the default
  `cloud:docker` summary
- make `cloud:docker:check <dir>` read the existing generated directory from disk so manual Dockerfile/Compose edits can
  be validated without regenerating files
- add a static-check preflight to `cloud:docker:smoke:run` so broken or incomplete generated directories fail before
  Docker build/compose commands start
- extend the real Docker smoke-run plan beyond `/health` with a generated `smoke-api-workflow.ts` verifier that creates a
  workspace, session, job, looks up the job, and verifies job events
- make the generated real-opencode smoke prompt write `docker-smoke-report.md` and `.opencode-cloud/artifacts.json` using
  `OPENCODE_RUNTIME_JOB_ID` so the local executor can validate artifacts and mark the job complete
- add a `minio-init` service to generated local Docker Compose files so the S3-compatible `runtime-artifacts` bucket exists
  before API and worker artifact flows run
- add a `docker info` preflight step to real local Docker smoke runs so Docker daemon issues fail before image builds start
  and show up as a dedicated smoke-run step
- extend real local Docker smoke preflight with Docker Compose availability, API port 8787 availability, and source build
  context checks so environment issues fail before image build or Compose startup
- generate `runtime-profile.json` plus README and CLI summary profile lines so local Docker directories clearly show
  storage backend, worker execution mode, artifact storage, object bucket, runtime image, and service entrypoints
- parse the generated `smoke-api-workflow.ts` JSON stdout in real Docker smoke-run summaries and print workspace, session,
  job, terminal status, artifact count, and event count as compact end-to-end evidence
- require `CLOUD_RUNTIME_CONFIRM_REAL_DOCKER=1` before `cloud:docker:smoke:run` can run real Docker build/compose/API
  workflow commands, while keeping `cloud:docker:smoke` as a safe plan-only command
- add a local non-Docker opencode smoke entrypoint exposed as `bun run cloud:opencode:smoke`; it creates a SQLite-backed
  workspace/session/job, runs the local worker in `opencode` execution mode, and prints workspace/session/job/status/
  artifact/event evidence from the resulting database state
- add preflight checks to `cloud:opencode:smoke` for the `opencode` executable, model provider credentials, and positive
  execution timeout so real local smoke runs fail before model execution when prerequisites are missing
- extend `cloud:opencode:smoke` preflight with SQLite parent and sandbox root writability checks, and print sqlite/sandbox
  paths in smoke evidence so local failures point at the exact runtime state location
- add `bun run cloud:opencode:plan` for a dry-run view of local opencode smoke configuration, including SQLite path,
  sandbox root, tenant, model, execution mode, timeout, required env vars, outputs, report name, and artifact manifest
- add `bun run cloud:opencode:preflight` for a confirmation-free diagnostic check of the local opencode executable,
  model credential, timeout, SQLite path, and sandbox writability before running a real model-backed job
- add `bun run cloud:opencode:evidence` for machine-readable local opencode plan/preflight evidence and confirmed real
  smoke evidence when `CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1` is set
- allow local opencode smoke model overrides through `CLOUD_RUNTIME_MODEL_PROVIDER` and `CLOUD_RUNTIME_MODEL` so real
  smoke runs can verify non-default providers while keeping the default Anthropic model unchanged
- allow local opencode smoke credential env overrides through `CLOUD_RUNTIME_MODEL_CREDENTIAL_ENV` so customer-owned or
  OpenAI-compatible model keys can be checked without renaming them to the platform default provider key
- allow local opencode smoke provider proxy overrides through `CLOUD_RUNTIME_MODEL_BASE_URL`; when set, the smoke creates
  a temporary BYOK credential snapshot so opencode receives provider options with the configured `baseURL`
- require `CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1` before `cloud:opencode:smoke` can run preflight or invoke the real
  opencode/model path, while keeping `cloud:opencode:plan` safe and side-effect free
- make the generated `smoke-api-workflow.ts` export a reusable `run()` function so tests can execute the same verifier
  against a local Cloud API app with an injected fetch implementation while CLI usage still runs the script directly
- add a pure worker service layer that leases jobs, heartbeats, cancels, expires, records worker events, returns sandbox launch plans, and collects artifacts from manifests
- add pure worker attempt helpers, worker-service attempt lifecycle recording, and tenant-scoped attempt storage for retries, audit, and recovery
- add pure usage and cost attribution helpers for model tokens, tool costs, and runtime resources
- add pure budget guardrail helpers for tenant and per-job cost limits
- add metrics helpers for job, event, lease, autoscaling observability points, OTLP HTTP export, and local worker job-completion metric emission
- add pure alert evaluation helpers for queue backlog, failure rate, sandbox latency, stale worker heartbeat, and tenant budget exhaustion
- add pure webhook delivery, subscription dispatch planning, signed SaaS callback, and retry scheduling helpers
- add pure public response view helpers so API and SDK responses do not expose internal storage fields
- add pure signed artifact download response helpers behind an injected object-storage signer
- add pure audit event helpers and tenant-scoped audit storage access
- add pure tool policy helpers for tenant-scoped web, MCP, skill, and search permissions
- add pure connector gateway grant helpers for scoped short-lived runtime tokens and remote MCP headers
- add pure file staging helpers for object storage inputs, sandbox workdirs, and artifact output prefixes
- add pure sandbox resource, isolation, security, timeout, and network planning helpers for future K8s/gVisor/Kata/Firecracker adapters
- add pure Kubernetes Pod and NetworkPolicy manifest helpers for future sandbox worker adapters
- add pure Kubernetes executor operation helpers for apply/create/watch/logs/delete and pod status mapping
- add pure cancellation planning helpers for sandbox deletion, lease-owner checks, and attempt cancellation
- add pure queue selection, queue depth, oldest queued age, and retry policy helpers
- add pure queue adapter operation helpers for enqueue, lease, heartbeat, ack, retry, and cancel actions
- add pure worker runner orchestration helpers that compose queue, database, object storage, and Kubernetes operation plans
- add pure operation runner helpers for provider task idempotency, execution result summaries, and retry planning
- add pure worker autoscaling decision helpers for queue depth, oldest queued age, worker utilization, and resource pressure
- add pure runtime version selection helpers for tenant pins, canary rollout, request overrides, and emergency rollback
- add runtime release gate helpers for staging, canary, production promotion, hold, rollback decisions, and executable image upgrade workflows
- add pure deployment topology helpers for API, orchestrator, worker, dependency, environment, and autoscale planning
- add pure local Docker Compose topology helpers for local API, worker, Postgres, MinIO, Redis, sandbox images, API/worker
  env rendering, and optional simulated worker execution
- add pure tool catalog public view helpers for GET /v1/tools without leaking internal connector or MCP config
- add an unmounted dependency-injected Hono route factory for the public Cloud Runtime API surface with an optional gateway guard hook
- add pure API mount planning helpers for base path, auth mode, CORS, health, OpenAPI, and public route exposure
- add a minimal OpenAPI document builder and expose `/openapi.json` from local in-memory and SQLite-backed API servers
- add a lightweight TypeScript SDK request/response helper for the public Cloud Runtime API contract
- add pure example SaaS integration flow helpers for workspace/session/file/job/events/artifact usage
- add tests for config conversion, environment injection, version pinning, and tool policy
- avoid existing opencode server route, database, and storage changes while allowing a separate dependency-injected
  Cloud Runtime Hono app factory for local API integration tests
- persist the planned runtime job spec and prompt in the platform store so API-created jobs can be consumed by worker
  loops without side-channel runtime configuration maps
- add a minimal worker loop helper that leases queued jobs from the store, reads stored job execution metadata, and
  returns provider operation plans for the runner
- add a local single-process runtime composition helper so the Hono API and worker loop can share the same in-memory
  store during local development
- add a standalone local Cloud Runtime API entrypoint that can listen with Bun without modifying the existing opencode
  CLI or server
- add a SQLite transaction runner for the provider-neutral database operation plan so local development can execute
  inserts, updates, deletes, JSON values, and transaction boundaries against a real SQLite database
- add an async PostgreSQL transaction runner for the same provider-neutral operation plan using parameterized SQL,
  generic query clients, JSON serialization, transaction boundaries, and identifier validation without adding a concrete
  Postgres package dependency
- add an async PostgreSQL schema bootstrap for the external control-plane tables and indexes so provider clients can
  initialize a durable Cloud Runtime database before wiring higher-level repositories and services
- add async PostgreSQL repository read helpers for queued jobs, job specs, prompts, events, and leases using generic
  `pg`-style or `postgres.js`-style query client results
- add an async PostgreSQL worker loop that leases queued jobs, persists lease/attempt/status/event state through the
  provider-neutral runner, returns opencode launch plans, and supports heartbeat updates against a durable Postgres
  control-plane database
- extend the PostgreSQL worker loop with completed and failed job finalization so executor results can persist terminal
  job state, attempt updates, artifact rows, terminal events, and lease cleanup in the durable control plane
- add a PostgreSQL-backed service write adapter for core API-created workspace, session, and job records so durable
  control-plane data can feed the PostgreSQL worker loop
- make the public route factory await sync or async service adapters so SQLite, in-memory, and PostgreSQL-backed
  services can share the same API surface
- add a PostgreSQL-backed Hono server factory that mounts core Cloud Runtime API routes on top of an injected query
  client, gateway guard, CORS, health, and OpenAPI endpoints
- extend the PostgreSQL-backed service and server with session message and file metadata routes so durable Postgres
  deployments can support multi-turn conversation history and SaaS-provided context files
- extend the PostgreSQL-backed service and server with job cancellation, artifact listing/download signing, and webhook
  subscription CRUD so the public API surface reaches SQLite parity for the core control-plane routes
- add an idempotent SQLite schema bootstrap for local development so API and worker processes can initialize the same
  Cloud Runtime control-plane tables before using the SQLite runner
- add SQLite-backed repository reads for queued jobs, job specs, job prompts, events, and leases so workers can consume
  persisted runtime state instead of relying only on in-memory stores
- add a SQLite-backed worker loop that leases queued jobs, persists lease/attempt/status/event state, returns opencode
  launch plans, and supports heartbeat updates against the local SQLite control-plane database
- add a SQLite-backed API/service write adapter for workspace, session, message, and job creation so local API writes can
  be consumed by the SQLite-backed worker loop
- add a SQLite-backed Hono server factory that mounts the public Cloud Runtime API on top of the SQLite service and
  schema bootstrap without changing the existing in-memory server factory
- add a SQLite-backed local API and worker integration path so API-created jobs can be leased, completed, surfaced as
  event streams, and returned as artifact downloads through the public routes
- add a SQLite-backed local runtime composition helper and local API storage switch so local development can run either
  the in-memory demo path or a persisted SQLite API/worker MVP from the same entrypoint
- add a local SQLite worker entrypoint with configurable worker ID, tenant, lease TTL, poll interval, bounded step mode,
  shared SQLite DB path, optional `CLOUD_RUNTIME_EXECUTION_MODE=simulate` completion, and
  `CLOUD_RUNTIME_EXECUTION_MODE=opencode` execution for single-machine API/worker development
- add a local opencode executor that creates the workdir, spawns the planned `opencode run` command, reads the
  existing artifact manifest contract, records artifact sizes, and maps process/manifest failures to failed jobs

This creates a stable seam for an external platform without pulling SaaS control-plane concerns into opencode core.

Current first-slice modules:

- `src/cloud/runtime.ts` - job spec to opencode config, env, telemetry, and network policy helpers
- `src/cloud/schema.ts` - external platform resource schemas and job status transition helper
- `src/cloud/api.ts` - public Cloud Runtime API request and response contracts, including session message, paginated file/artifact/job event responses, webhook, and stable error responses
- `src/cloud/worker.ts` - deterministic opencode launch plan for sandbox workers
- `src/cloud/artifact.ts` - artifact manifest validation for sandbox output collection
- `src/cloud/orchestrator.ts` - pure API request to runtime job spec planner
- `src/cloud/lease.ts` - job lease and heartbeat rules for future queue workers
- `src/cloud/access.ts` - tenant and user access boundary helpers for future API and storage layers
- `src/cloud/tenant-policy.ts` - pure tenant policy normalization helpers for models, runtime, tools, budget, and rate limits
- `src/cloud/api-key.ts` - pure API key issuing, hashing, and bearer authentication helpers for future API gateway adapters
- `src/cloud/gateway.ts` - reusable API gateway guard helpers for API key authentication, stable JSON unauthorized responses, allowlist CORS handling, and `x-request-id` response headers
- `src/cloud/rate-limit.ts` - pure fixed-window tenant/action rate limit helpers for future API gateway adapters
- `src/cloud/event.ts` - deterministic job event builders, cursor streaming, and checkpoint helpers
- `src/cloud/store.ts` - in-memory reference store for tenant-scoped workspace, session, file, message, job, job spec, job prompt, lease, cost, event, artifact, webhook, and audit access
- `src/cloud/service.ts` - pure application service layer for workspace, session, file, message, job creation, job lookup, job cancellation, webhook registration/listing/update/delete, stored job execution metadata, paginated file/event/artifact listing, and signed artifact download operations
- `src/cloud/cloud.sql.ts` - pure Drizzle table contract definitions for the external Cloud Runtime control-plane persistence model
- `src/cloud/repository.ts` - pure repository row mapping and transaction plan helpers for job creation, leasing, completion, cancellation, artifacts, events, and attempts
- `src/cloud/database-adapter.ts` - pure database adapter operation helpers for transactional insert/update/delete execution planning
- `src/cloud/sqlite-runner.ts` - Bun SQLite runner for executing provider-neutral database operation plans with JSON serialization and identifier validation
- `src/cloud/postgres-runner.ts` - async PostgreSQL runner for executing provider-neutral database operation plans with `$n` placeholders, generic query clients, JSON serialization, transaction boundaries, and identifier validation
- `src/cloud/postgres-client.ts` - Bun SQL backed PostgreSQL query client adapter for standalone Cloud Runtime API and worker entrypoints without introducing a separate npm Postgres client
- `src/cloud/postgres-schema.ts` - async PostgreSQL schema bootstrap for Cloud Runtime control-plane tables and indexes through a generic query client
- `src/cloud/postgres-repository.ts` - async PostgreSQL-backed read helpers for queued jobs, job execution metadata, job events, and active leases through generic query clients
- `src/cloud/postgres-worker-loop.ts` - async PostgreSQL-backed worker loop for queue-gated persisted job leasing, attempt creation, start launch planning, heartbeat persistence, durable queue heartbeat synchronization, artifact completion, Kubernetes sandbox result completion/failure writeback, failure recording, timeout expiration, cancellation finalization, retry/backoff requeue, terminal queue acknowledgement, and lease cleanup
- `src/cloud/production-worker.ts` - production worker composition helper that runs a Kubernetes sandbox, uploads artifacts to S3-compatible storage, writes PostgreSQL completion/failure state, marks object-storage upload failures as failed jobs, and acknowledges or retries queue messages through existing adapters
- `src/cloud/postgres-service.ts` - async PostgreSQL-backed service adapter for workspace, session, message, async file staging, file metadata, job creation/cancellation, job/event reads, cursor-paginated file/artifact listing, async artifact download signing, and webhook CRUD through generic query clients
- `src/cloud/postgres-server.ts` - PostgreSQL-backed Hono app factory for Cloud Runtime workspace, session, S3-compatible file staging, queue-enqueued job creation, queue-synchronized job cancellation, S3-compatible artifact download signing, webhook, health, reusable API key guard, allowlist CORS, request IDs, OpenAPI, and injected query/storage clients
- `src/cloud/postgres-worker.ts` - standalone PostgreSQL worker poll entrypoint with environment-driven durable database connection, schema bootstrap, tenant/lease/sandbox/object/Kubernetes configuration, bounded step mode, PostgreSQL worker-loop leasing, durable queue client wiring, S3-compatible storage client wiring, optional Kubernetes sandbox execution, and production completion writeback through the PostgreSQL worker loop
- `src/cloud/sqlite-schema.ts` - idempotent local SQLite schema bootstrap for Cloud Runtime control-plane tables and indexes
- `src/cloud/sqlite-repository.ts` - SQLite-backed read helpers for queued jobs, job execution metadata, job events, and active leases
- `src/cloud/sqlite-worker-loop.ts` - SQLite-backed worker loop for persisted job leasing, attempt creation, start launch planning, heartbeat persistence, artifact completion, failure recording, timeout expiration, cancellation finalization, and lease cleanup
- `src/cloud/sqlite-service.ts` - SQLite-backed service adapter for workspace, session, message, webhook registration/listing/update/delete, job creation, job lookup, job cancellation, prompt, and initial event writes
- `src/cloud/sqlite-server.ts` - SQLite-backed Hono app factory for local Cloud Runtime API routes, queue-enqueued job creation, queue-synchronized job cancellation, health, reusable API key guard, allowlist CORS, request IDs, OpenAPI, and shared DB access
- `src/cloud/sqlite-local-runtime.ts` - SQLite-backed local API and worker-loop composition helper using the same database
- `src/cloud/local-api.ts` - standalone Bun listen entrypoint with `CLOUD_RUNTIME_STORAGE=memory|sqlite` and optional `CLOUD_RUNTIME_SQLITE_PATH`
- `src/cloud/local-worker.ts` - standalone SQLite worker poll entrypoint with bounded test mode, continuous local polling, optional simulated job completion, local opencode execution mode, Kubernetes execution mode with fetch-based client configuration, Kubernetes artifact manifest/size writeback, execution timeout handling, post-execution cancellation detection, optional queue lease/ack/retry gating, retry policy configuration, optional S3-compatible artifact upload, and optional OTLP job metric export after terminal completion
- `src/cloud/local-opencode-smoke.ts` - local non-Docker smoke verifier for SQLite API plus local worker `opencode`
  execution mode, creating a workspace/session/job, requiring the runtime to write `local-opencode-smoke-report.md` and
  `.opencode-cloud/artifacts.json`, checking executable/model-key/timeout and SQLite/sandbox writability prerequisites
  before CLI execution, and returning compact workspace/session/job/status/artifact/event/path evidence; also exposes
  `cloud:opencode:plan` dry-run output for SQLite path, sandbox root, model, timeout, required env vars, outputs, report
  name, and artifact manifest, supports `CLOUD_RUNTIME_MODEL_PROVIDER`/`CLOUD_RUNTIME_MODEL` provider overrides,
  `CLOUD_RUNTIME_MODEL_CREDENTIAL_ENV` credential env overrides, and `CLOUD_RUNTIME_MODEL_BASE_URL` provider proxy
  overrides through a temporary BYOK credential snapshot, and requires explicit
  `CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1` confirmation before real smoke execution
- `src/cloud/local-executor.ts` - local opencode process executor for launch plans, artifact manifest reading, artifact file size collection, and execution failure summaries
- `src/cloud/object-storage.ts` - pure object key, upload plan, signed download plan, and tenant boundary helpers for future S3/R2/GCS adapters
- `src/cloud/object-storage-adapter.ts` - pure provider-neutral object storage operation helpers for input upload, sandbox staging, artifact upload/copy, signed download, and retention cleanup
- `src/cloud/s3-storage-runner.ts` - generic S3-compatible runner for executing provider-neutral object storage operations through injected put/get/copy/sign/list/delete client functions
- `src/cloud/s3-client.ts` - AWS SDK backed S3-compatible object storage client builder for worker artifact upload/download/copy/list/delete operations using endpoint, region, and optional access key configuration
- `src/cloud/storage-service.ts` - storage-backed service wiring for API file upload staging, worker artifact upload, and artifact signed download generation through S3-compatible runner operations
- `src/cloud/queue-runner.ts` - generic queue runner for executing provider-neutral enqueue, lease, heartbeat, ack, retry, and cancel operations through injected queue client functions
- `src/cloud/memory-queue.ts` - local in-memory queue client for MVP queue execution semantics, including priority, runAt visibility, lease TTL, heartbeat extension, ack, retry, and cancel
- `src/cloud/postgres-queue.ts` - PostgreSQL-backed queue client implementing the queue runner interface with durable queue rows, visibility timeout leasing, heartbeat extension, terminal ack, retry, and cancel
- `src/cloud/worker-service.ts` - pure worker service layer for leasing, attempt lifecycle recording, heartbeat, cancellation, expiration, opencode launch plans, artifact collection, and succeeded/failed job completion
- `src/cloud/attempt.ts` - pure worker attempt helpers for attempt numbering, runtime version attribution, completion, failure, cancellation, and retry planning
- `src/cloud/usage.ts` - pure model token, fixed tool, runtime resource, and total cost attribution helpers
- `src/cloud/budget.ts` - pure tenant and per-job budget guardrail helpers for projected cost checks
- `src/cloud/metrics.ts` - job, event, lease, autoscale metric point helpers plus OTLP JSON payload and HTTP exporter for collector/dashboard integration
- `src/cloud/alert.ts` - pure alert evaluation helpers for Cloud Runtime reliability, capacity, and budget signals
- `src/cloud/webhook.ts` - pure webhook subscription dispatch planning, signed delivery, and bounded retry schedule helpers for SaaS callbacks
- `src/cloud/view.ts` - pure public API and SDK response mappers for jobs, sessions, messages, artifacts, and events
- `src/cloud/audit.ts` - pure audit event builder and user/resource/action filter helpers
- `src/cloud/tool-policy.ts` - pure tenant tool policy checks for webfetch domains, websearch providers, MCP servers, and skills
- `src/cloud/connector.ts` - pure connector gateway grant helpers for scoped short-lived tokens and remote MCP headers
- `src/cloud/staging.ts` - pure input file staging and sandbox workdir path planning helpers
- `src/cloud/sandbox.ts` - pure sandbox resource, isolation, security, timeout, and network plan helpers for future execution adapters
- `src/cloud/kubernetes.ts` - pure Kubernetes Pod and NetworkPolicy manifest helpers for sandbox launch plans
- `src/cloud/kubernetes-executor.ts` - Kubernetes executor operation helpers plus an injected client runner, fetch-based REST client, sandbox lifecycle runner, failure cleanup, network policy apply, pod create/watch/logs/delete, and status mapping
- `src/cloud/kubernetes-smoke.ts` - explicit-confirmation Kubernetes smoke CLI that creates a short-lived sandbox Pod and NetworkPolicy, watches terminal status, collects logs, and cleans up resources with JSON evidence output
- `src/cloud/cancel.ts` - pure cancellation plan helper for deterministic sandbox deletion, lease-owner validation, and running attempt cancellation
- `src/cloud/queue.ts` - pure queued job selection, queue stats, and bounded retry policy helpers
- `src/cloud/queue-adapter.ts` - pure provider-neutral queue operation helpers for enqueue, lease, heartbeat, ack, retry, and cancel actions
- `src/cloud/worker-runner.ts` - worker runner orchestration helpers that compose queue, database, object storage, Kubernetes operation plans, and injected Kubernetes sandbox lifecycle execution
- `src/cloud/operation-runner.ts` - pure operation runner helpers for provider task idempotency, execution result summaries, and retry planning
- `src/cloud/autoscale.ts` - pure worker autoscaling decision helpers for queue, worker, and resource pressure inputs
- `src/cloud/runtime-version.ts` - pure runtime image selection helpers for request override, tenant pin, canary, default, and rollback
- `src/cloud/release.ts` - runtime release gate helpers for staging, canary, production promotion, hold, rollback decisions, executable Docker/kubectl image upgrade workflows, release readiness summaries that combine Kubernetes preflight, Docker smoke-plan, provider readiness, provider health, runtime gate results, and a real-environment audit reminder, plus a `bun run cloud:release:check` CI gate backed by environment-provided runtime metrics
- `src/cloud/provider-readiness.ts` - production provider configuration readiness helpers for Postgres, S3-compatible object storage, queue, and Kubernetes, including health-check plan descriptions, default injected-client probe adapter, injected health-check execution, failure isolation, health summaries, real environment-backed CLI health probes, and `bun run cloud:providers:check` support
- `src/cloud/provider-smoke.ts` - explicit-confirmation provider smoke CLI for real Postgres schema/query, queue enqueue/lease/ack, and S3-compatible object storage put/list/get/sign/delete evidence
- `src/cloud/verification.ts` - local and CI verification plan CLI exposed as `bun run cloud:verify`, ordering safe Docker/Kubernetes/provider/release checks, documenting explicit real opencode, Docker, and provider-health follow-up commands, supporting `--check` to execute only the safe chain through an injectable runner, supporting `--audit` to inspect real-environment prerequisites without starting Docker, invoking opencode, or connecting to providers, supporting `--preflight` to probe local operator-machine readiness before real smoke jobs, supporting `--report` to emit a human-readable implementation status report, supporting `--runbook` to emit a real-run operator checklist with success evidence and triage, and supporting `--evidence` to emit a stable JSON implementation evidence report
- `src/cloud/model-secret-store.ts` - low-intrusion BYOK secret boundary for storing, resolving, rotating, and deleting model API keys by tenant and secret ref; local memory implementation is used by API/server tests and can be replaced by KMS or a cloud secrets manager in production
- `src/cloud/model-secret-adapter.ts` - provider-neutral BYOK secret operations for put, resolve, delete, rotate, and redacted audit views so KMS, Vault, or cloud secrets managers can share the same control-plane contract
- `src/cloud/model-secret-runner.ts` - injected-client runner for executing model secret operations against a real secrets backend without leaking secret values in operation results, plus a synchronous store wrapper for deployments that expose a local secrets cache
- `src/cloud/deployment.ts` - pure deployment topology helpers for API, orchestrator, worker, dependency, environment, autoscale planning, Kubernetes Deployment/Service/HPA manifest generation, multi-document YAML rendering, Kubernetes deployment file writing, README generation, env/argv CLI configuration, manifest preflight checks, directory check summaries, and `bun run cloud:k8s` / `bun run cloud:k8s:check` entrypoint support
- `src/cloud/local-docker.ts` - local Docker Compose topology helpers for local API, worker, shared SQLite state, optional PostgreSQL-backed API/worker storage topology, Postgres, MinIO, Redis, sandbox images, env files, MinIO/S3 endpoint/region/access-key/secret env wiring for both API and worker, Kubernetes execution env, OTEL endpoint/header/service-name wiring, explicit API and worker service commands, generated cloud API/worker/runtime Dockerfiles and build commands, generated `smoke-api-workflow.ts` with reusable `run()`, optional artifact polling, local Docker smoke plan checks exposed through `cloud:docker:check` for existing generated directories, static S3 storage env checks for PostgreSQL Docker mode, stable missing-file check failures, static check results returned from file generation, planned real Docker smoke run output exposed through `cloud:docker:smoke`, explicit Docker execution exposed through `cloud:docker:smoke:run` with static-check, Docker/Compose/port/build-context preflight and a workspace/session/job/events/completion/artifact API workflow verifier, testable smoke-run CLI execution, injected smoke runner abstraction with retries, diagnostics, cleanup, explicit process args for generated scripts, stdout/stderr result summaries, and actionable failure suggestions, simulated local worker execution, local opencode execution mode, worker timeout/retry environment, deployment README generation with health checks, sample API workflow, smoke-run usage, and failure diagnostics, and CLI writing via `bun run cloud:docker`
- `src/cloud/local-runtime.ts` - local single-process API and worker-loop composition helper using the same in-memory platform store
- `src/cloud/local-api.ts` - standalone Bun listen entrypoint for the Cloud Runtime API app with memory, SQLite, or PostgreSQL-backed storage selection, S3-compatible object storage client construction from environment, and injectable server/query/storage-client boundaries for local and Docker deployments
- `src/cloud/api-smoke.ts` - local/deployed Cloud Runtime API smoke CLI that verifies the SaaS-facing HTTP API flow,
  BYOK LLM credential CRUD/test without leaking the API key, admin runtime pool and integrator runtime policy endpoints,
  job creation with an external-user scoped credential, and emits text or JSON evidence for operator logs
- `src/cloud/tool-catalog.ts` - pure public tool catalog helpers for web, MCP, skills, and connectors
- `src/cloud/routes.ts` - unmounted Hono route factory for Cloud Runtime API adapters using injected service, stable JSON errors, paginated files/artifacts/job events, server-sent job event streams, webhook registration/listing/update/delete, job lookup/cancel, tool catalog, and optional gateway guard dependencies
- `src/cloud/api-mount.ts` - pure API mount planning helpers for base path, auth mode, CORS, health, OpenAPI, and public route exposure
- `src/cloud/openapi.ts` - minimal OpenAPI 3.1 document builder for public Cloud Runtime paths, LLM credential routes, admin runtime pool routes, operation IDs, tags, and bearer auth metadata
- `src/cloud/server.ts` - separate dependency-injected Hono app factory for local Cloud Runtime API usage, reusable API key guard, allowlist CORS, request IDs, health, and OpenAPI without modifying the existing opencode server
- `src/cloud/sdk.ts` - lightweight TypeScript SDK helper for Cloud Runtime API requests, response decoding, standard error messages, file/artifact listing with cursor page helpers, paginated job events, server-sent job event stream parsing, webhook registration/listing/update/delete, LLM credential CRUD/test, admin runtime pool inspection/drain/restart/reconcile/session-release/runtime-policy helpers, job lookup, and job cancellation
- `src/cloud/example-saas.ts` - pure example SaaS integration flow helpers for workspace/session/file/webhook/job status/cancel/events/artifact usage
- `src/cloud/worker-loop.ts` - minimal worker loop helper that leases queued jobs, reads stored job specs and prompts, and returns runner start and heartbeat plans
