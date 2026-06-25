import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { CloudAPIMount } from "./api-mount"
import { CloudAPIKey } from "./api-key"
import { CloudGateway } from "./gateway"
import { CloudObjectStorage } from "./object-storage"
import { CloudOpenAPI } from "./openapi"
import { CloudQueueAdapter } from "./queue-adapter"
import { CloudQueueRunner, type Client as QueueClient } from "./queue-runner"
import { CloudRoutes } from "./routes"
import { CloudS3StorageRunner, type Client as S3StorageClient } from "./s3-storage-runner"
import { CloudSkillRegistry } from "./skill-registry"
import { CloudSQLiteSchema } from "./sqlite-schema"
import { CloudSQLiteService } from "./sqlite-service"
import { CloudStorageService } from "./storage-service"
import { CloudModelSecretStore, type Store as ModelSecretStore } from "./model-secret-store"

type Tenant = Parameters<typeof CloudSQLiteService.create>[0]["tenant"]
type Tools = Parameters<typeof CloudSQLiteService.create>[0]["tools"]
type ToolCatalog = Parameters<typeof CloudRoutes.create>[0]["toolCatalog"]

const DefaultTenant = {
  id: "tenant_local",
  defaultRuntimeVersion: "1.14.28",
  defaultRuntimeImage: "cloud-runtime-opencode:1.14.28",
  defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
  allowedModels: ["anthropic/claude-sonnet-4-5"],
}

const DefaultTools = {
  mcp: {},
  skills: {},
}

const DefaultToolCatalog = {
  catalog: { mcp: {}, skills: {}, connectors: {} },
  policy: {
    webfetch: { enabled: false, allowDomains: [] },
    websearch: { enabled: false, providers: [] },
    mcp: [],
    skills: [],
    connectors: [],
  },
}

function ids() {
  const next = new Map<string, number>()
  return (prefix: string) => {
    const value = (next.get(prefix) ?? 0) + 1
    next.set(prefix, value)
    return `${prefix}_${value}`
  }
}

export function create(input?: {
  tenant?: Tenant
  tools?: Tools
  toolCatalog?: ToolCatalog
  db?: Database
  now?: () => number
  apiKeys?: ReturnType<typeof CloudAPIKey.issue>["record"][]
  corsOrigins?: string[]
  requestID?: () => string
  bucket?: string
  storageClient?: S3StorageClient
  queueClient?: QueueClient
  serviceVersion?: string
  modelSecretStore?: ModelSecretStore
  env?: Record<string, string | undefined>
}) {
  const now = input?.now ?? Date.now
  const tenant = input?.tenant ?? DefaultTenant
  const db = input?.db ?? new Database(":memory:")
  const modelSecretStore = input?.modelSecretStore ?? CloudModelSecretStore.memory()
  const registry = CloudSkillRegistry.merge({
    tools: input?.tools ?? DefaultTools,
    toolCatalog: input?.toolCatalog ?? DefaultToolCatalog,
    registry: CloudSkillRegistry.fromEnv(input?.env ?? process.env),
  })
  CloudSQLiteSchema.apply({ db })
  const service = CloudSQLiteService.create({
    db,
    tenant,
    tools: registry.tools,
    now,
    id: ids(),
    stageFile: (request) =>
      input?.storageClient
        ? CloudStorageService.stageFile({
            bucket: input?.bucket ?? "runtime-artifacts",
            fileID: request.fileID,
            request,
            run: (operation) => CloudS3StorageRunner.run({ ...operation, client: input.storageClient! }),
          })
        : {
            objectKey: CloudObjectStorage.fileKey({
              tenantID: request.tenantID,
              workspaceID: request.workspaceID,
              sessionID: request.sessionID,
              fileID: request.fileID,
              name: request.name,
            }),
            size: request.contentBase64 ? Buffer.from(request.contentBase64, "base64").byteLength : 0,
          },
    signArtifactDownload: (request) =>
      input?.storageClient
        ? CloudStorageService.signArtifactDownload({
            bucket: input?.bucket ?? "runtime-artifacts",
            artifact: request.artifact,
            expiresAt: request.expiresAt,
            run: (operation) => CloudS3StorageRunner.run({ ...operation, client: input.storageClient! }),
          })
        : CloudObjectStorage.downloadPlan({
            bucket: input?.bucket ?? "runtime-artifacts",
            objectKey: request.artifact.objectKey,
            expiresAt: request.expiresAt,
            sign: (target) => `http://localhost:9000/${target.bucket}/${target.objectKey}?expires=${target.expiresAt}`,
          }).url,
    modelSecretStore,
  })
  const routes = CloudRoutes.create({
    service: {
      ...service,
      createJob: async (request) => {
        const job = service.createJob(request)
        if (input?.queueClient) {
          await CloudQueueRunner.run({
            client: input.queueClient,
            operations: [
              CloudQueueAdapter.enqueue({
                tenantID: job.tenantID,
                jobID: job.id,
                now: job.time.created,
                profile: job.runtime.profile,
              }),
            ],
          })
        }
        return job
      },
      cancelJob: async (request) => {
        const job = service.cancelJob(request)
        if (input?.queueClient) {
          await CloudQueueRunner.run({
            client: input.queueClient,
            operations: [
              CloudQueueAdapter.cancel({
                tenantID: job.tenantID,
                jobID: job.id,
                requestedBy: "api",
                time: job.time.updated,
              }),
            ],
          })
        }
        return job
      },
      getIntegratorRuntimePolicy: service.getIntegratorRuntimePolicy,
      updateIntegratorRuntimePolicy: service.updateIntegratorRuntimePolicy,
    },
    toolCatalog: registry.toolCatalog,
    beforeRequest: CloudGateway.apiKeyGuard({ apiKeys: input?.apiKeys }),
  })
  const cors = CloudGateway.cors({ origins: input?.corsOrigins })

  return {
    db,
    modelSecretStore,
    service,
    app: new Hono()
      .use("*", async (c, next) => {
        const requestID = CloudGateway.requestID({ request: c.req.raw, id: input?.requestID ?? (() => crypto.randomUUID()) })
        const preflight = cors?.(c.req.raw)
        if (preflight) return CloudGateway.withRequestID({ response: preflight, requestID })
        await next()
        c.res = CloudGateway.withRequestID({
          response: CloudGateway.withCORS({ request: c.req.raw, response: c.res, origins: input?.corsOrigins }),
          requestID,
        })
      })
      .get("/health", (c) =>
        c.json(
          CloudAPIMount.health({
            version: input?.serviceVersion ?? "dev",
            runtimeDefaultVersion: tenant.defaultRuntimeVersion,
            time: now(),
          }),
        ),
      )
      .get("/openapi.json", (c) => c.json(CloudOpenAPI.document({ version: input?.serviceVersion ?? "dev" })))
      .route("/", routes),
  }
}

export * as CloudSQLiteServer from "./sqlite-server"
