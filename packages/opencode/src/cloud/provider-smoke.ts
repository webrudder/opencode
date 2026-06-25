import type { QueryClient } from "./postgres-runner"
import type { CloudS3StorageRunner } from "./s3-storage-runner"
import { CloudPostgresClient } from "./postgres-client"
import { CloudPostgresQueue } from "./postgres-queue"
import { CloudPostgresSchema } from "./postgres-schema"
import { CloudProviderReadiness } from "./provider-readiness"
import { CloudS3Client } from "./s3-client"

type Env = Record<string, string | undefined>
type Step = {
  name: string
  status: "passed" | "failed" | "skipped"
  detail: string
}
export type Clients = {
  postgres: QueryClient
  objectStorage: CloudS3StorageRunner.Client
}

function message(input: unknown) {
  if (input instanceof Error) return input.message
  return String(input)
}

function passed(input: { name: string; detail: string }): Step {
  return { name: input.name, status: "passed", detail: input.detail }
}

function failed(input: { name: string; detail: string }): Step {
  return { name: input.name, status: "failed", detail: input.detail }
}

async function checked(input: { name: string; run: () => Promise<string> }) {
  return input.run().then(
    (detail) => passed({ name: input.name, detail }),
    (error) => failed({ name: input.name, detail: message(error) }),
  )
}

function cfg(input: { env: Env }) {
  const readiness = CloudProviderReadiness.fromEnv(input.env)
  return {
    readiness,
    env: readiness.env,
    confirmed: input.env.CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE === "1",
    queue: readiness.env.CLOUD_RUNTIME_QUEUE ?? "cloud-runtime-jobs",
    bucket: readiness.env.CLOUD_RUNTIME_OBJECT_BUCKET ?? "runtime-artifacts",
    prefix: input.env.CLOUD_RUNTIME_PROVIDER_SMOKE_PREFIX ?? `cloud-runtime-smoke/${Date.now()}`,
  }
}

function createClients(input: { env: Env }): Clients {
  const postgres = CloudPostgresClient.create({ url: input.env.CLOUD_RUNTIME_DATABASE_URL })
  return {
    postgres,
    objectStorage: CloudS3Client.create({
      endpoint: input.env.CLOUD_RUNTIME_OBJECT_ENDPOINT,
      region: input.env.CLOUD_RUNTIME_OBJECT_REGION,
      accessKeyID: input.env.CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID,
      secretAccessKey: input.env.CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY,
      forcePathStyle: input.env.CLOUD_RUNTIME_OBJECT_FORCE_PATH_STYLE !== "false",
    }),
  }
}

function requireMethod<T>(input: T | undefined, name: string): T {
  if (input) return input
  throw new Error(`Provider smoke object storage client ${name} is not configured`)
}

async function text(input: Awaited<ReturnType<NonNullable<CloudS3StorageRunner.Client["getObject"]>>>) {
  if (typeof input === "string") return input
  if (input instanceof Blob) return input.text()
  return new TextDecoder().decode(input instanceof ArrayBuffer ? new Uint8Array(input) : input)
}

async function smokeQueue(input: {
  postgres: QueryClient
  queue: string
  now: number
}) {
  const client = CloudPostgresQueue.client({ client: input.postgres, now: () => input.now })
  const jobID = `provider_smoke_${input.now}`
  await input.postgres.query(
    `insert into cloud_tenant (
      id, name, default_runtime_version, allowed_models, budget, time_created, time_updated
    ) values ($1, $2, $3, $4, $5, $6, $7)
    on conflict(id) do update set time_updated = excluded.time_updated`,
    ["provider_smoke", "Provider Smoke", "provider-smoke", [], {}, input.now, input.now],
  )
  await input.postgres.query(
    `insert into cloud_user (id, tenant_id, external_id, time_created, time_updated)
    values ($1, $2, $3, $4, $5)
    on conflict(id) do update set time_updated = excluded.time_updated`,
    ["provider_smoke_user", "provider_smoke", "provider_smoke_user", input.now, input.now],
  )
  await input.postgres.query(
    `insert into cloud_workspace (id, tenant_id, external_id, name, time_created, time_updated)
    values ($1, $2, $3, $4, $5, $6)
    on conflict(id) do update set time_updated = excluded.time_updated`,
    ["provider_smoke_workspace", "provider_smoke", "provider_smoke_workspace", "Provider Smoke", input.now, input.now],
  )
  await input.postgres.query(
    `insert into cloud_session (id, tenant_id, workspace_id, user_id, title, model, summary, time_created, time_updated)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    on conflict(id) do update set time_updated = excluded.time_updated`,
    [
      "provider_smoke_session",
      "provider_smoke",
      "provider_smoke_workspace",
      "provider_smoke_user",
      "Provider Smoke",
      null,
      null,
      input.now,
      input.now,
    ],
  )
  await input.postgres.query(
    `insert into cloud_job (
      id, tenant_id, workspace_id, session_id, status, execution_mode, runtime, job_spec, cost, error, time_created, time_updated
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    on conflict(id) do update set status = excluded.status, time_updated = excluded.time_updated`,
    [
      jobID,
      "provider_smoke",
      "provider_smoke_workspace",
      "provider_smoke_session",
      "queued",
      "provider_smoke",
      {},
      {},
      {},
      null,
      input.now,
      input.now,
    ],
  )
  await client.enqueue?.({
    queue: input.queue,
    tenantID: "provider_smoke",
    jobID,
    runAt: input.now,
    priority: 0,
  })
  const lease = await client.lease?.({
    queue: input.queue,
    tenantID: "provider_smoke",
    jobID,
    workerID: "provider_smoke_worker",
    leaseTTLMS: 30_000,
  })
  if (!lease?.leased) throw new Error(`queue lease failed: ${lease?.reason ?? "missing lease result"}`)
  const ack = await client.ack?.({
    jobID,
    workerID: "provider_smoke_worker",
    terminalStatus: "succeeded",
    time: input.now + 1,
  })
  if (!ack?.acknowledged) throw new Error("queue ack failed")
  return `queue ${input.queue} enqueue/lease/ack succeeded`
}

async function smokeObjectStorage(input: {
  client: CloudS3StorageRunner.Client
  bucket: string
  prefix: string
  now: number
}) {
  const objectKey = `${input.prefix}/probe.txt`
  const body = `cloud-runtime-provider-smoke:${input.now}`
  await requireMethod(input.client.putObject, "putObject")({
    bucket: input.bucket,
    objectKey,
    body,
    contentType: "text/plain",
    contentLength: body.length,
    metadata: {
      "smoke-test": "provider",
    },
  })
  const listed = await requireMethod(input.client.listObjects, "listObjects")({ bucket: input.bucket, prefix: input.prefix, notBefore: 0 })
  if (!listed.some((item) => item.objectKey === objectKey)) throw new Error(`object ${objectKey} was not listed`)
  const downloaded = await text(await requireMethod(input.client.getObject, "getObject")({ bucket: input.bucket, objectKey }))
  if (downloaded !== body) throw new Error(`downloaded object mismatch for ${objectKey}`)
  const url = await requireMethod(input.client.signDownload, "signDownload")({ bucket: input.bucket, objectKey, expiresAt: input.now + 900_000 })
  if (!url) throw new Error(`signed download URL was not returned for ${objectKey}`)
  const deleted = await requireMethod(input.client.deleteObjects, "deleteObjects")({ bucket: input.bucket, objectKeys: [objectKey] })
  if (!deleted?.deleted) throw new Error(`object ${objectKey} was not deleted`)
  return `object storage ${input.bucket}/${objectKey} put/list/get/sign/delete succeeded`
}

export async function run(input?: {
  env?: Env
  clients?: Clients
  now?: () => number
  confirmed?: boolean
}) {
  const config = cfg({ env: input?.env ?? Bun.env })
  if (!config.readiness.ok) {
    return {
      schemaVersion: 1,
      status: "failed" as const,
      confirmed: input?.confirmed ?? config.confirmed,
      profile: config.readiness.profile,
      readiness: config.readiness.checks,
      steps: [failed({ name: "provider-readiness", detail: "provider readiness failed; run bun run cloud:providers:check" })],
    }
  }
  if (!(input?.confirmed ?? (input?.clients !== undefined || config.confirmed))) {
    return {
      schemaVersion: 1,
      status: "failed" as const,
      confirmed: false,
      profile: config.readiness.profile,
      readiness: config.readiness.checks,
      steps: [failed({ name: "confirmation", detail: "set CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 before writing to real providers" })],
    }
  }
  const now = input?.now?.() ?? Date.now()
  const clients = input?.clients ?? createClients({ env: config.env })
  try {
    const steps = [
      await checked({
        name: "postgres-schema",
        run: async () => {
          const result = await CloudPostgresSchema.apply({ client: clients.postgres })
          return `schema applied (${result.tables.length} tables, ${result.indexes.length} indexes)`
        },
      }),
      await checked({
        name: "postgres-query",
        run: async () => {
          await clients.postgres.query("select 1", [])
          return "postgres select 1 succeeded"
        },
      }),
      await checked({
        name: "queue-roundtrip",
        run: async () => smokeQueue({ postgres: clients.postgres, queue: config.queue, now }),
      }),
      await checked({
        name: "object-storage-roundtrip",
        run: async () => smokeObjectStorage({ client: clients.objectStorage, bucket: config.bucket, prefix: config.prefix, now }),
      }),
    ]
    return {
      schemaVersion: 1,
      status: steps.every((item) => item.status === "passed") ? "passed" as const : "failed" as const,
      confirmed: true,
      profile: config.readiness.profile,
      readiness: config.readiness.checks,
      target: {
        queue: config.queue,
        bucket: config.bucket,
        prefix: config.prefix,
      },
      steps,
    }
  } finally {
    if (!input?.clients) await clients.postgres.close?.()
  }
}

export function summary(input: Awaited<ReturnType<typeof run>>) {
  return [
    `Cloud Runtime provider smoke: ${input.status}`,
    `Confirmed: ${input.confirmed ? "yes" : "no"}`,
    ...input.readiness.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
    ...input.steps.map((item) => `[${item.status}] ${item.name}: ${item.detail}`),
  ].join("\n")
}

export function evidence(input: Awaited<ReturnType<typeof run>>) {
  return `${JSON.stringify(input, undefined, 2)}\n`
}

export async function runCLI(input?: {
  env?: Env
  clients?: Clients
  now?: () => number
  confirmed?: boolean
  json?: boolean
}) {
  const result = await run(input)
  return {
    exitCode: result.status === "passed" ? 0 : 1,
    output: input?.json ? evidence(result) : `${summary(result)}\n`,
  }
}

if (import.meta.main) {
  const result = await runCLI({ json: Bun.argv.includes("--json") })
  console.log(result.output)
  process.exit(result.exitCode)
}

export * as CloudProviderSmoke from "./provider-smoke"
