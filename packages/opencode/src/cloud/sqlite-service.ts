import type { Database } from "bun:sqlite"
import type { CloudAPI } from "./api"
import { CloudDatabaseAdapter } from "./database-adapter"
import { CloudEvent } from "./event"
import { CloudOrchestrator } from "./orchestrator"
import { CloudRepository } from "./repository"
import { CloudRuntimeExecutor } from "./runtime-executor"
import { CloudRuntimePool, type RuntimeWorker } from "./runtime-pool"
import { CloudRuntimePoolScaler } from "./runtime-pool-scaler"
import type { Artifact, File, LLMCredential, Message, Session, WebhookSubscription, Workspace } from "./schema"
import { CloudSchema } from "./schema"
import { CloudSQLiteRepository } from "./sqlite-repository"
import { CloudSQLiteRunner } from "./sqlite-runner"
import { CloudTenantPolicy, type ExecutionMode, type IntegratorRuntimePolicyUpdate } from "./tenant-policy"
import type { Store as ModelSecretStore } from "./model-secret-store"

type Tenant = Parameters<typeof CloudOrchestrator.planJob>[0]["tenant"]
type ToolCatalog = Parameters<typeof CloudOrchestrator.planJob>[0]["tools"]
type ApplyRuntimePoolPlanRequest = {
  target?: "local" | "kubernetes"
  currentRuntimes?: number
  namespace?: string
  deploymentName?: string
}

const emptyCost = {
  estimatedUSD: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
}

const emptyRuntimeMetrics = {
  activeJobs: 0,
  busySessions: 0,
  idleSessions: 0,
  cpuPercent: 0,
  memoryPercent: 0,
  diskPercent: 0,
  recentErrorRate: 0,
  heartbeatDelayMS: 0,
}

function stringify(input: unknown) {
  return JSON.stringify(input)
}

function parseJSON(input: unknown) {
  if (typeof input !== "string") return input
  return JSON.parse(input)
}

function workspace(input: Record<string, unknown>): Workspace {
  return CloudSchema.decodeWorkspace({
    id: input.id,
    tenantID: input.tenant_id,
    externalID: input.external_id ?? undefined,
    name: input.name ?? undefined,
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function session(input: Record<string, unknown>): Session {
  return CloudSchema.decodeSession({
    id: input.id,
    tenantID: input.tenant_id,
    workspaceID: input.workspace_id,
    userID: input.user_id,
    title: input.title,
    model: typeof input.model === "string" ? JSON.parse(input.model) : undefined,
    summary: input.summary ?? undefined,
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function file(input: Record<string, unknown>): File {
  return CloudSchema.decodeFile({
    id: input.id,
    tenantID: input.tenant_id,
    workspaceID: input.workspace_id,
    sessionID: input.session_id ?? undefined,
    name: input.name,
    mime: input.mime ?? undefined,
    size: input.size,
    objectKey: input.object_key,
    sha256: input.sha256 ?? undefined,
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function message(input: Record<string, unknown>): Message {
  return CloudSchema.decodeMessage({
    id: input.id,
    tenantID: input.tenant_id,
    workspaceID: input.workspace_id,
    sessionID: input.session_id,
    jobID: input.job_id ?? undefined,
    role: input.role,
    content: input.content,
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function artifact(input: Record<string, unknown>): Artifact {
  return CloudSchema.decodeArtifact({
    id: input.id,
    tenantID: input.tenant_id,
    workspaceID: input.workspace_id,
    sessionID: input.session_id,
    jobID: input.job_id,
    name: input.name,
    kind: input.kind,
    mime: input.mime ?? undefined,
    size: input.size,
    objectKey: input.object_key,
    sha256: input.sha256 ?? undefined,
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function webhook(input: Record<string, unknown>): WebhookSubscription {
  return CloudSchema.decodeWebhookSubscription({
    id: input.id,
    tenantID: input.tenant_id,
    url: input.url,
    secretRef: input.secret_ref,
    events: parseJSON(input.events),
    enabled: input.enabled === 1,
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function llmCredential(input: Record<string, unknown>): LLMCredential {
  return CloudSchema.decodeLLMCredential({
    id: input.id,
    tenantID: input.tenant_id,
    scope: input.scope,
    ownerKey: input.owner_key,
    name: input.name,
    providerType: input.provider_type,
    provider: input.provider,
    baseURL: input.base_url ?? undefined,
    secretRef: input.secret_ref,
    allowedModels: parseJSON(input.allowed_models),
    defaultModel: input.default_model,
    enabled: input.enabled === 1,
    version: input.version,
    lastUsedAt: input.last_used_at ?? undefined,
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function runtimeWorker(input: Record<string, unknown>) {
  return CloudRuntimePool.decodeRuntimeWorker({
    id: input.id,
    tenantID: input.tenant_id,
    executionMode: input.execution_mode,
    status: input.status,
    version: input.version,
    profile: input.profile,
    maxActiveJobs: input.max_active_jobs,
    maxSessions: input.max_sessions,
    metrics: parseJSON(input.metrics),
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function sessionRuntimeBinding(input: Record<string, unknown>) {
  return CloudRuntimePool.decodeSessionBinding({
    tenantID: input.tenant_id,
    sessionID: input.session_id,
    runtimeID: input.runtime_id,
    time: {
      created: input.time_created,
      updated: input.time_updated,
    },
  })
}

function integratorRuntimePolicy(input: Record<string, unknown>) {
  return CloudTenantPolicy.integratorRuntimePolicy({
    tenantID: `${input.tenant_id}`,
    integratorID: `${input.integrator_id}`,
    defaultExecutionMode: input.default_execution_mode as ExecutionMode,
    allowedExecutionModes: parseJSON(input.allowed_execution_modes) as ExecutionMode[],
    maxActiveJobs: Number(input.max_active_jobs),
    maxSessions: Number(input.max_sessions),
    maxConcurrentJobsPerSession: Number(input.max_concurrent_jobs_per_session),
  })
}

function getWorkspace(input: { db: Database; tenantID: string; id: string }) {
  const row = input.db.query("select * from cloud_workspace where tenant_id = ? and id = ?").get(input.tenantID, input.id)
  if (!row) return undefined
  return workspace(row as Record<string, unknown>)
}

function getSession(input: { db: Database; tenantID: string; id: string }) {
  const row = input.db.query("select * from cloud_session where tenant_id = ? and id = ?").get(input.tenantID, input.id)
  if (!row) return undefined
  return session(row as Record<string, unknown>)
}

function getArtifact(input: { db: Database; tenantID: string; id: string }) {
  const row = input.db.query("select * from cloud_artifact where tenant_id = ? and id = ?").get(input.tenantID, input.id)
  if (!row) return undefined
  return artifact(row as Record<string, unknown>)
}

function ensureTenant(input: { db: Database; tenant: Tenant; now: number }) {
  input.db
    .query(
      `insert into cloud_tenant (
        id, name, default_runtime_version, allowed_models, budget, time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        default_runtime_version = excluded.default_runtime_version,
        allowed_models = excluded.allowed_models,
        time_updated = excluded.time_updated`,
    )
    .run(
      input.tenant.id,
      input.tenant.id,
      input.tenant.defaultRuntimeVersion,
      stringify(input.tenant.allowedModels),
      stringify({}),
      input.now,
      input.now,
    )
}

function ensureUser(input: { db: Database; tenantID: string; userID: string; now: number }) {
  input.db
    .query(
      `insert into cloud_user (id, tenant_id, external_id, time_created, time_updated)
      values (?, ?, ?, ?, ?)
      on conflict(id) do update set time_updated = excluded.time_updated`,
    )
    .run(input.userID, input.tenantID, input.userID, input.now, input.now)
}

export function create(input: {
  db: Database
  tenant: Tenant
  tools: ToolCatalog
  now: () => number
  id: (prefix: string) => string
  signArtifactDownload?: (input: { artifact: Artifact; expiresAt: number }) => string | Promise<string>
  stageFile?: (input: CloudAPI.CreateFileRequest & { tenantID: string; fileID: string }) => {
    objectKey: string
    size: number
    sha256?: string
  } | Promise<{
    objectKey: string
    size: number
    sha256?: string
  }>
  modelSecretStore?: ModelSecretStore
}) {
  return {
    createWorkspace(request: CloudAPI.CreateWorkspaceRequest) {
      const result = CloudSchema.decodeWorkspace({
        id: input.id("workspace"),
        tenantID: input.tenant.id,
        externalID: request.externalID,
        name: request.name,
        time: {
          created: input.now(),
          updated: input.now(),
        },
      })
      ensureTenant({ db: input.db, tenant: input.tenant, now: input.now() })
      CloudSQLiteRunner.run({
        db: input.db,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            {
              action: "insert",
              table: "cloud_workspace",
              key: { id: result.id },
              values: CloudRepository.workspaceRow(result),
            },
          ],
        }),
      })
      return result
    },
    createSession(request: CloudAPI.CreateSessionRequest) {
      const found = getWorkspace({ db: input.db, tenantID: input.tenant.id, id: request.workspaceID })
      if (!found) throw new Error("Cloud workspace not found")
      const result = CloudSchema.decodeSession({
        id: input.id("session"),
        tenantID: input.tenant.id,
        workspaceID: found.id,
        userID: request.userID,
        title: request.title ?? "Untitled",
        model: request.model,
        time: {
          created: input.now(),
          updated: input.now(),
        },
      })
      ensureUser({ db: input.db, tenantID: input.tenant.id, userID: request.userID, now: input.now() })
      CloudSQLiteRunner.run({
        db: input.db,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            {
              action: "insert",
              table: "cloud_session",
              key: { id: result.id },
              values: CloudRepository.sessionRow(result),
            },
          ],
        }),
      })
      return result
    },
    createSessionMessage(sessionID: string, request: CloudAPI.CreateSessionMessageRequest) {
      const found = getSession({ db: input.db, tenantID: input.tenant.id, id: sessionID })
      if (!found) throw new Error("Cloud session not found")
      const result = CloudSchema.decodeMessage({
        id: input.id("message"),
        tenantID: input.tenant.id,
        workspaceID: found.workspaceID,
        sessionID: found.id,
        role: request.role ?? "user",
        content: request.content,
        time: {
          created: input.now(),
          updated: input.now(),
        },
      })
      CloudSQLiteRunner.run({
        db: input.db,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            {
              action: "insert",
              table: "cloud_message",
              key: { id: result.id },
              values: CloudRepository.messageRow(result),
            },
          ],
        }),
      })
      return result
    },
    listSessionMessages(request: { sessionID: string }) {
      const found = getSession({ db: input.db, tenantID: input.tenant.id, id: request.sessionID })
      if (!found) throw new Error("Cloud session not found")
      return input.db
        .query("select * from cloud_message where tenant_id = ? and session_id = ? order by time_created, id")
        .all(input.tenant.id, found.id)
        .map((row) => message(row as Record<string, unknown>))
    },
    async createFile(request: CloudAPI.CreateFileRequest) {
      const found = getWorkspace({ db: input.db, tenantID: input.tenant.id, id: request.workspaceID })
      if (!found) throw new Error("Cloud workspace not found")
      const foundSession = request.sessionID
        ? getSession({ db: input.db, tenantID: input.tenant.id, id: request.sessionID })
        : undefined
      if (request.sessionID && !foundSession) throw new Error("Cloud session not found")
      if (foundSession && foundSession.workspaceID !== found.id) throw new Error("Cloud session workspace mismatch")
      if (!input.stageFile) throw new Error("Cloud file staging adapter not configured")
      const fileID = input.id("file")
      const staged = await input.stageFile({ ...request, tenantID: input.tenant.id, fileID })
      const result = CloudSchema.decodeFile({
        id: fileID,
        tenantID: input.tenant.id,
        workspaceID: found.id,
        sessionID: foundSession?.id,
        name: request.name,
        mime: request.mime,
        size: staged.size,
        objectKey: staged.objectKey,
        sha256: staged.sha256,
        time: {
          created: input.now(),
          updated: input.now(),
        },
      })
      CloudSQLiteRunner.run({
        db: input.db,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            {
              action: "insert",
              table: "cloud_file",
              key: { id: result.id },
              values: CloudRepository.fileRow(result),
            },
          ],
        }),
      })
      return result
    },
    listFiles(request: { workspaceID?: string; sessionID?: string; cursor?: string; limit?: number }) {
      return input.db
        .query(
          `select * from cloud_file
          where tenant_id = ?
            and (? is null or workspace_id = ?)
            and (? is null or session_id = ?)
            and (? is null or id > ?)
          order by time_created, id
          limit ?`,
        )
        .all(
          input.tenant.id,
          request.workspaceID ?? null,
          request.workspaceID ?? null,
          request.sessionID ?? null,
          request.sessionID ?? null,
          request.cursor ?? null,
          request.cursor ?? null,
          request.limit ?? -1,
        )
        .map((row) => file(row as Record<string, unknown>))
    },
    createJob(request: CloudAPI.CreateJobRequest) {
      const found = getSession({ db: input.db, tenantID: input.tenant.id, id: request.sessionID })
      if (!found) throw new Error("Cloud session not found")
      const spec = CloudOrchestrator.planJob({
        id: input.id("job"),
        tenant: input.tenant,
        session: found,
        request,
        tools: input.tools,
        modelCredentials: this.listLLMCredentials(),
        modelContext: {
          integratorID: request.integratorID,
          externalTenantID: request.externalTenantID,
          externalUserID: request.externalUserID,
          workspaceID: found.workspaceID,
          sessionID: found.id,
        },
      })
      const policy = request.integratorID
        ? this.getIntegratorRuntimePolicy({ integratorID: request.integratorID })
        : undefined
      const job = CloudSchema.decodeJob({
        id: spec.id,
        tenantID: spec.tenantID,
        workspaceID: spec.workspaceID,
        sessionID: spec.sessionID,
        status: "queued",
        executionMode: policy?.defaultExecutionMode ?? CloudRuntimeExecutor.mode(process.env),
        runtime: spec.runtime,
        modelConfigSnapshot: spec.modelConfigSnapshot,
        cost: emptyCost,
        time: {
          created: input.now(),
          updated: input.now(),
        },
      })
      const message = CloudSchema.decodeMessage({
        id: input.id("message"),
        tenantID: input.tenant.id,
        workspaceID: found.workspaceID,
        sessionID: found.id,
        jobID: job.id,
        role: "user",
        content: request.prompt,
        time: {
          created: input.now(),
          updated: input.now(),
        },
      })
      const event = CloudEvent.status({ jobID: job.id, sequence: 1, status: job.status, time: job.time.created })
      CloudSQLiteRunner.run({
        db: input.db,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            ...CloudRepository.createJobTransaction({ job, spec, event }),
            {
              action: "insert",
              table: "cloud_message",
              key: { id: message.id },
              values: CloudRepository.messageRow(message),
            },
          ],
        }),
      })
      return job
    },
    getJob(request: { jobID: string }) {
      const job = CloudSQLiteRepository.getJob({ db: input.db, tenantID: input.tenant.id, id: request.jobID })
      if (!job) throw new Error("Cloud job not found")
      return job
    },
    cancelJob(request: { jobID: string }) {
      const job = CloudSQLiteRepository.getJob({ db: input.db, tenantID: input.tenant.id, id: request.jobID })
      if (!job) throw new Error("Cloud job not found")
      const canceled = CloudSchema.decodeJob({
        ...job,
        status: CloudSchema.transitionJobStatus(job.status, "canceled"),
        time: {
          ...job.time,
          updated: input.now(),
        },
      })
      CloudSQLiteRunner.run({
        db: input.db,
        operations: CloudDatabaseAdapter.transaction({
          mutations: CloudRepository.cancelJobTransaction({
            job: canceled,
            event: CloudEvent.status({
              jobID: canceled.id,
              sequence: CloudSQLiteRepository.listEvents({ db: input.db, jobID: canceled.id }).length + 1,
              status: canceled.status,
              time: canceled.time.updated,
            }),
          }),
        }),
      })
      return canceled
    },
    listJobEvents(request: { jobID: string; cursor?: string; limit?: number }) {
      return CloudSQLiteRepository.listEvents({ db: input.db, ...request })
    },
    listArtifacts(request: { jobID?: string; cursor?: string; limit?: number }) {
      return input.db
        .query(
          `select * from cloud_artifact
          where tenant_id = ? and (? is null or job_id = ?) and (? is null or id > ?)
          order by time_created, id
          limit ?`,
        )
        .all(input.tenant.id, request.jobID ?? null, request.jobID ?? null, request.cursor ?? null, request.cursor ?? null, request.limit ?? -1)
        .map((row) => artifact(row as Record<string, unknown>))
    },
    async getArtifactDownload(request: { artifactID: string; ttlMS: number }): Promise<CloudAPI.ArtifactDownloadResponse> {
      const found = getArtifact({ db: input.db, tenantID: input.tenant.id, id: request.artifactID })
      if (!found) throw new Error("Cloud artifact not found")
      if (!input.signArtifactDownload) throw new Error("Cloud artifact download signer not configured")
      const expiresAt = input.now() + request.ttlMS
      return {
        artifactID: found.id,
        url: await input.signArtifactDownload({ artifact: found, expiresAt }),
        expiresAt,
      }
    },
    createWebhook(request: CloudAPI.CreateWebhookRequest) {
      const id = input.id("webhook")
      const result = CloudSchema.decodeWebhookSubscription({
        id,
        tenantID: input.tenant.id,
        url: request.url,
        secretRef: `secret/webhook/${id}`,
        events: request.events,
        enabled: request.enabled ?? true,
        time: {
          created: input.now(),
          updated: input.now(),
        },
      })
      ensureTenant({ db: input.db, tenant: input.tenant, now: input.now() })
      CloudSQLiteRunner.run({
        db: input.db,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            {
              action: "insert",
              table: "cloud_webhook_subscription",
              key: { id: result.id },
              values: CloudRepository.webhookRow(result),
            },
          ],
        }),
      })
      return result
    },
    listWebhooks() {
      return input.db
        .query("select * from cloud_webhook_subscription where tenant_id = ? order by time_created, id")
        .all(input.tenant.id)
        .map((row) => webhook(row as Record<string, unknown>))
    },
    updateWebhook(request: { webhookID: string } & CloudAPI.UpdateWebhookRequest) {
      const found = input.db
        .query("select * from cloud_webhook_subscription where tenant_id = ? and id = ?")
        .get(input.tenant.id, request.webhookID) as Record<string, unknown> | null
      if (!found) throw new Error("Cloud webhook not found")
      const current = webhook(found)
      const result = CloudSchema.decodeWebhookSubscription({
        ...current,
        enabled: request.enabled,
        time: {
          ...current.time,
          updated: input.now(),
        },
      })
      CloudSQLiteRunner.run({
        db: input.db,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            {
              action: "update",
              table: "cloud_webhook_subscription",
              key: { id: result.id, tenant_id: result.tenantID },
              values: CloudRepository.webhookRow(result),
            },
          ],
        }),
      })
      return result
    },
    deleteWebhook(request: { webhookID: string }) {
      const found = input.db
        .query("select * from cloud_webhook_subscription where tenant_id = ? and id = ?")
        .get(input.tenant.id, request.webhookID) as Record<string, unknown> | null
      if (!found) throw new Error("Cloud webhook not found")
      const result = webhook(found)
      CloudSQLiteRunner.run({
        db: input.db,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            {
              action: "delete",
              table: "cloud_webhook_subscription",
              key: { id: result.id, tenant_id: result.tenantID },
            },
          ],
        }),
      })
      return result
    },
    createLLMCredential(request: CloudAPI.CreateLLMCredentialRequest) {
      const id = input.id("llmcred")
      const secretRef = `${input.tenant.id}/${request.ownerKey}/${request.name}`
      const result = CloudSchema.decodeLLMCredential({
        id,
        tenantID: input.tenant.id,
        scope: request.scope,
        ownerKey: request.ownerKey,
        name: request.name,
        providerType: request.providerType,
        provider: request.provider,
        baseURL: request.baseURL,
        secretRef,
        allowedModels: request.allowedModels,
        defaultModel: request.defaultModel,
        enabled: request.enabled,
        version: 1,
        time: { created: input.now(), updated: input.now() },
      })
      ensureTenant({ db: input.db, tenant: input.tenant, now: input.now() })
      CloudSQLiteRunner.run({
        db: input.db,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [{ action: "insert", table: "cloud_llm_credential", key: { id }, values: CloudRepository.llmCredentialRow(result) }],
        }),
      })
      input.modelSecretStore?.put({ tenantID: input.tenant.id, secretRef, secret: request.apiKey, now: input.now() })
      return result
    },
    listLLMCredentials() {
      return input.db
        .query("select * from cloud_llm_credential where tenant_id = ? order by time_created, id")
        .all(input.tenant.id)
        .map((row) => llmCredential(row as Record<string, unknown>))
    },
    getLLMCredential(request: { credentialID: string }) {
      const found = input.db
        .query("select * from cloud_llm_credential where tenant_id = ? and id = ?")
        .get(input.tenant.id, request.credentialID) as Record<string, unknown> | null
      if (!found) throw new Error("Cloud LLM credential not found")
      return llmCredential(found)
    },
    updateLLMCredential(credentialID: string, request: CloudAPI.UpdateLLMCredentialRequest) {
      const current = this.getLLMCredential({ credentialID })
      const secretRef = request.apiKey !== undefined ? `${input.tenant.id}/${credentialID}/rotated-${input.now()}` : undefined
      const result = CloudSchema.decodeLLMCredential({
        ...current,
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.baseURL !== undefined ? { baseURL: request.baseURL } : {}),
        ...(secretRef !== undefined ? { secretRef } : {}),
        ...(request.allowedModels !== undefined ? { allowedModels: request.allowedModels } : {}),
        ...(request.defaultModel !== undefined ? { defaultModel: request.defaultModel } : {}),
        ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
        version: current.version + 1,
        time: { ...current.time, updated: input.now() },
      })
      CloudSQLiteRunner.run({
        db: input.db,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            {
              action: "update",
              table: "cloud_llm_credential",
              key: { id: result.id, tenant_id: result.tenantID },
              values: CloudRepository.llmCredentialRow(result),
            },
          ],
        }),
      })
      if (secretRef !== undefined) input.modelSecretStore?.put({ tenantID: input.tenant.id, secretRef, secret: request.apiKey!, now: input.now() })
      return result
    },
    deleteLLMCredential(request: { credentialID: string }) {
      const result = this.getLLMCredential(request)
      CloudSQLiteRunner.run({
        db: input.db,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [{ action: "delete", table: "cloud_llm_credential", key: { id: result.id, tenant_id: result.tenantID } }],
        }),
      })
      return result
    },
    testLLMCredential(request: { credentialID: string }) {
      const credential = this.getLLMCredential(request)
      const secretAvailable = input.modelSecretStore
        ? Boolean(input.modelSecretStore.resolve({ tenantID: input.tenant.id, secretRef: credential.secretRef }))
        : true
      return { ok: credential.enabled && secretAvailable, credentialID: credential.id, provider: credential.provider, model: credential.defaultModel }
    },
    registerRuntimeWorker(request: {
      runtimeID: string
      executionMode?: RuntimeWorker["executionMode"]
      status?: RuntimeWorker["status"]
      version: string
      profile: RuntimeWorker["profile"]
      maxActiveJobs: number
      maxSessions: number
      metrics?: RuntimeWorker["metrics"]
    }) {
      const result = CloudRuntimePool.decodeRuntimeWorker({
        id: request.runtimeID,
        tenantID: input.tenant.id,
        executionMode: request.executionMode ?? "shared_session_pool",
        status: request.status ?? "healthy",
        version: request.version,
        profile: request.profile,
        maxActiveJobs: request.maxActiveJobs,
        maxSessions: request.maxSessions,
        metrics: request.metrics ?? emptyRuntimeMetrics,
        time: { created: input.now(), updated: input.now() },
      })
      ensureTenant({ db: input.db, tenant: input.tenant, now: input.now() })
      input.db
        .query(
          `insert into cloud_runtime_worker (
            id, tenant_id, execution_mode, status, version, profile, max_active_jobs, max_sessions, metrics, time_created, time_updated
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            execution_mode = excluded.execution_mode,
            status = excluded.status,
            version = excluded.version,
            profile = excluded.profile,
            max_active_jobs = excluded.max_active_jobs,
            max_sessions = excluded.max_sessions,
            metrics = excluded.metrics,
            time_updated = excluded.time_updated`,
        )
        .run(
          result.id,
          result.tenantID,
          result.executionMode,
          result.status,
          result.version,
          result.profile,
          result.maxActiveJobs,
          result.maxSessions,
          stringify(result.metrics),
          result.time.created,
          result.time.updated,
        )
      return result
    },
    heartbeatRuntimeWorker(runtimeID: string, request: {
      status?: RuntimeWorker["status"]
      metrics?: RuntimeWorker["metrics"]
    }) {
      const runtime = this.getRuntimeWorker({ runtimeID })
      const result = CloudRuntimePool.decodeRuntimeWorker({
        ...runtime,
        ...(request.status ? { status: request.status } : {}),
        ...(request.metrics ? { metrics: request.metrics } : {}),
        time: { ...runtime.time, updated: input.now() },
      })
      input.db
        .query(
          `update cloud_runtime_worker set
            status = ?,
            metrics = ?,
            time_updated = ?
          where tenant_id = ? and id = ?`,
        )
        .run(result.status, stringify(result.metrics), result.time.updated, input.tenant.id, result.id)
      return result
    },
    listRuntimeWorkers() {
      return input.db
        .query("select * from cloud_runtime_worker where tenant_id = ? order by id")
        .all(input.tenant.id)
        .map((row) => runtimeWorker(row as Record<string, unknown>))
    },
    getRuntimeWorker(request: { runtimeID: string }) {
      const found = input.db
        .query("select * from cloud_runtime_worker where tenant_id = ? and id = ?")
        .get(input.tenant.id, request.runtimeID) as Record<string, unknown> | null
      if (!found) throw new Error("Cloud runtime worker not found")
      return runtimeWorker(found)
    },
    drainRuntimeWorker(request: { runtimeID: string }) {
      return this.heartbeatRuntimeWorker(request.runtimeID, { status: "draining" })
    },
    restartRuntimeWorker(request: { runtimeID: string }) {
      return this.heartbeatRuntimeWorker(request.runtimeID, { status: "healthy", metrics: emptyRuntimeMetrics })
    },
    assignSessionRuntime(request: { sessionID: string }) {
      const found = getSession({ db: input.db, tenantID: input.tenant.id, id: request.sessionID })
      if (!found) throw new Error("Cloud session not found")
      const assignment = CloudRuntimePool.assign({
        tenantID: input.tenant.id,
        sessionID: found.id,
        runtimes: this.listRuntimeWorkers(),
        bindings: input.db
          .query("select * from cloud_session_runtime_binding where tenant_id = ?")
          .all(input.tenant.id)
          .map((row) => sessionRuntimeBinding(row as Record<string, unknown>)),
      })
      if (!assignment.assigned) throw new Error("Cloud runtime capacity exhausted")
      const binding = CloudRuntimePool.bindSession({
        tenantID: input.tenant.id,
        sessionID: found.id,
        runtimeID: assignment.runtimeID,
        now: input.now(),
      })
      input.db
        .query(
          `insert into cloud_session_runtime_binding (
            tenant_id, session_id, runtime_id, time_created, time_updated
          ) values (?, ?, ?, ?, ?)
          on conflict(tenant_id, session_id) do update set
            runtime_id = excluded.runtime_id,
            time_updated = excluded.time_updated`,
        )
        .run(binding.tenantID, binding.sessionID, binding.runtimeID, binding.time.created, binding.time.updated)
      return binding
    },
    getSessionRuntimeBinding(request: { sessionID: string }) {
      const found = getSession({ db: input.db, tenantID: input.tenant.id, id: request.sessionID })
      if (!found) throw new Error("Cloud session not found")
      const binding = input.db
        .query("select * from cloud_session_runtime_binding where tenant_id = ? and session_id = ?")
        .get(input.tenant.id, found.id) as Record<string, unknown> | null
      if (!binding) return undefined
      return sessionRuntimeBinding(binding)
    },
    listSessionRuntimeBindings() {
      return input.db
        .query("select * from cloud_session_runtime_binding where tenant_id = ? order by session_id")
        .all(input.tenant.id)
        .map((row) => sessionRuntimeBinding(row as Record<string, unknown>))
    },
    releaseSessionRuntime(request: { sessionID: string }) {
      const binding = this.getSessionRuntimeBinding(request)
      if (!binding) throw new Error("Cloud session runtime binding not found")
      input.db
        .query("delete from cloud_session_runtime_binding where tenant_id = ? and session_id = ?")
        .run(input.tenant.id, binding.sessionID)
      return binding
    },
    reconcileRuntimePool(request: { heartbeatTTLMS: number }) {
      const result = CloudRuntimePool.reconcile({
        tenantID: input.tenant.id,
        now: input.now(),
        heartbeatTTLMS: request.heartbeatTTLMS,
        runtimes: this.listRuntimeWorkers(),
        bindings: input.db
          .query("select * from cloud_session_runtime_binding where tenant_id = ?")
          .all(input.tenant.id)
          .map((row) => sessionRuntimeBinding(row as Record<string, unknown>)),
      })
      result.runtimes.map((runtime) =>
        input.db
          .query(
            `update cloud_runtime_worker set
              status = ?,
              metrics = ?,
              time_updated = ?
            where tenant_id = ? and id = ?`,
          )
          .run(runtime.status, stringify(runtime.metrics), runtime.time.updated, input.tenant.id, runtime.id),
      )
      result.releasedBindings.map((binding) =>
        input.db
          .query("delete from cloud_session_runtime_binding where tenant_id = ? and session_id = ?")
          .run(input.tenant.id, binding.sessionID),
      )
      return {
        offlineRuntimeIDs: result.runtimes
          .filter((runtime) => runtime.tenantID === input.tenant.id && runtime.status === "offline")
          .map((runtime) => runtime.id),
        releasedSessionIDs: result.releasedBindings.map((binding) => binding.sessionID),
      }
    },
    applyRuntimePoolPlan(request?: ApplyRuntimePoolPlanRequest) {
      const runtimes = this.listRuntimeWorkers()
      const plan = CloudRuntimePool.poolPlan({
        tenantID: input.tenant.id,
        runtimes,
        bindings: this.listSessionRuntimeBindings(),
      })
      const drainedRuntimeIDs = plan.drainRuntimeIDs.map((runtimeID) => this.drainRuntimeWorker({ runtimeID }).id)
      const releasedSessionIDs = plan.releaseSessionIDs.map((sessionID) => {
        input.db
          .query("delete from cloud_session_runtime_binding where tenant_id = ? and session_id = ?")
          .run(input.tenant.id, sessionID)
        return sessionID
      })
      return {
        desiredRuntimes: plan.desiredRuntimes,
        action: plan.action,
        reason: plan.reason,
        drainedRuntimeIDs,
        releasedSessionIDs,
        scaleOperations: CloudRuntimePoolScaler.operations({
          target: request?.target ?? "local",
          namespace: request?.namespace,
          deploymentName: request?.deploymentName,
          currentRuntimes: request?.currentRuntimes ?? runtimes.length,
          plan: {
            desiredRuntimes: plan.desiredRuntimes,
            action: plan.action,
            reason: plan.reason,
            drainedRuntimeIDs,
            releasedSessionIDs,
          },
        }),
      }
    },
    getIntegratorRuntimePolicy(request: { integratorID: string }) {
      const row = input.db
        .query("select * from cloud_integrator_runtime_policy where tenant_id = ? and integrator_id = ?")
        .get(input.tenant.id, request.integratorID) as Record<string, unknown> | null
      if (!row) return undefined
      return integratorRuntimePolicy(row)
    },
    updateIntegratorRuntimePolicy(integratorID: string, request: IntegratorRuntimePolicyUpdate) {
      const result = CloudTenantPolicy.integratorRuntimePolicy({
        ...request,
        tenantID: input.tenant.id,
        integratorID,
      })
      ensureTenant({ db: input.db, tenant: input.tenant, now: input.now() })
      input.db
        .query(
          `insert into cloud_integrator_runtime_policy (
            tenant_id,
            integrator_id,
            default_execution_mode,
            allowed_execution_modes,
            max_active_jobs,
            max_sessions,
            max_concurrent_jobs_per_session,
            time_created,
            time_updated
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(tenant_id, integrator_id) do update set
            default_execution_mode = excluded.default_execution_mode,
            allowed_execution_modes = excluded.allowed_execution_modes,
            max_active_jobs = excluded.max_active_jobs,
            max_sessions = excluded.max_sessions,
            max_concurrent_jobs_per_session = excluded.max_concurrent_jobs_per_session,
            time_updated = excluded.time_updated`,
        )
        .run(
          result.tenantID,
          result.integratorID,
          result.defaultExecutionMode,
          stringify(result.allowedExecutionModes),
          result.maxActiveJobs,
          result.maxSessions,
          result.maxConcurrentJobsPerSession,
          input.now(),
          input.now(),
        )
      return result
    },
  }
}

export * as CloudSQLiteService from "./sqlite-service"
