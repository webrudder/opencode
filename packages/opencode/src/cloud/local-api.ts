import { Database } from "bun:sqlite"
import { CloudLocalRuntime } from "./local-runtime"
import { CloudPostgresClient } from "./postgres-client"
import { CloudPostgresSchema } from "./postgres-schema"
import { CloudPostgresServer } from "./postgres-server"
import type { QueryClient } from "./postgres-runner"
import { CloudS3Client } from "./s3-client"
import type { CloudS3StorageRunner } from "./s3-storage-runner"
import { CloudSQLiteLocalRuntime } from "./sqlite-local-runtime"

type ServeInput = Parameters<typeof Bun.serve>[0]
type ServeResult = Pick<ReturnType<typeof Bun.serve>, "hostname" | "port" | "stop">

function tenant(input: { env: Record<string, string | undefined> }) {
  const provider = input.env.CLOUD_RUNTIME_MODEL_PROVIDER ?? "anthropic"
  const model = input.env.CLOUD_RUNTIME_MODEL ?? "claude-sonnet-4-5"
  return {
    id: "tenant_local",
    defaultRuntimeVersion: "1.14.28",
    defaultRuntimeImage: "cloud-runtime-opencode:1.14.28",
    defaultModel: { provider, model },
    allowedModels: [`${provider}/${model}`],
  }
}

export function config(input?: {
  env?: Record<string, string | undefined>
}) {
  const env = input?.env ?? Bun.env
  const storage = env.CLOUD_RUNTIME_STORAGE === "sqlite" ? "sqlite" : env.CLOUD_RUNTIME_STORAGE === "postgres" ? "postgres" : "memory"
  return {
    hostname: env.CLOUD_RUNTIME_HTTP_HOSTNAME,
    port: Number(env.CLOUD_RUNTIME_HTTP_PORT ?? 8787),
    serviceVersion: env.CLOUD_RUNTIME_SERVICE_VERSION ?? "dev",
    storage,
    sqlitePath: storage === "sqlite" ? env.CLOUD_RUNTIME_SQLITE_PATH : undefined,
    databaseURL: storage === "postgres" ? env.CLOUD_RUNTIME_DATABASE_URL : undefined,
    bucket: env.CLOUD_RUNTIME_OBJECT_BUCKET,
    objectEndpoint: env.CLOUD_RUNTIME_OBJECT_ENDPOINT,
    objectRegion: env.CLOUD_RUNTIME_OBJECT_REGION,
    objectAccessKeyID: env.CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID,
    objectSecretAccessKey: env.CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY,
    tenant: tenant({ env }),
  }
}

export async function serve(input?: {
  env?: Record<string, string | undefined>
  client?: QueryClient
  storageClientFactory?: (input: Parameters<typeof CloudS3Client.create>[0]) => CloudS3StorageRunner.Client
  serve?: (input: ServeInput) => ServeResult
}) {
  const cfg = config(input)
  const runtime =
    cfg.storage === "postgres"
      ? await (async () => {
          const client = input?.client ?? CloudPostgresClient.create({ url: cfg.databaseURL })
          await CloudPostgresSchema.apply({ client })
          return CloudPostgresServer.create({
            client,
            tenant: cfg.tenant,
            serviceVersion: cfg.serviceVersion,
            bucket: cfg.bucket,
            storageClient: cfg.objectEndpoint
              ? (input?.storageClientFactory ?? CloudS3Client.create)({
                  endpoint: cfg.objectEndpoint,
                  region: cfg.objectRegion,
                  accessKeyID: cfg.objectAccessKeyID,
                  secretAccessKey: cfg.objectSecretAccessKey,
                })
              : undefined,
          })
        })()
      : cfg.storage === "sqlite"
      ? CloudSQLiteLocalRuntime.create({
          server: {
            serviceVersion: cfg.serviceVersion,
            tenant: cfg.tenant,
            db: cfg.sqlitePath ? new Database(cfg.sqlitePath) : undefined,
          },
        })
      : CloudLocalRuntime.create({
          server: {
            serviceVersion: cfg.serviceVersion,
            tenant: cfg.tenant,
          },
        })
  return {
    runtime,
    server: (input?.serve ?? Bun.serve)({
      hostname: cfg.hostname,
      port: cfg.port,
      fetch: runtime.app.fetch,
    }),
  }
}

if (import.meta.main) {
  const result = await serve()
  console.log(`cloud opencode runtime api listening on http://${result.server.hostname}:${result.server.port}`)
}
