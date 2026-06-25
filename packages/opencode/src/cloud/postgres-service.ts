import { CloudAPI } from "./api"
import { CloudDatabaseAdapter } from "./database-adapter"
import { CloudEvent } from "./event"
import { CloudOrchestrator } from "./orchestrator"
import { CloudPostgresRepository } from "./postgres-repository"
import { CloudPostgresRunner, type QueryClient } from "./postgres-runner"
import { CloudRepository } from "./repository"
import { CloudRuntimeExecutor } from "./runtime-executor"
import { CloudRuntimePool, type RuntimeWorker } from "./runtime-pool"
import { CloudRuntimePoolScaler } from "./runtime-pool-scaler"
import type { Artifact, File, LLMCredential, Message, Session, WebhookSubscription, Workspace } from "./schema"
import { CloudSchema } from "./schema"
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

function rows(input: Awaited<ReturnType<QueryClient["query"]>>) {
  if (Array.isArray(input)) return input
  return input.rows ?? []
}

function parseJSON(input: unknown) {
  if (typeof input !== "string") return input
  return JSON.parse(input)
}

function numberValue(input: unknown) {
  return Number(input)
}

function workspace(input: Record<string, unknown>): Workspace {
  return CloudSchema.decodeWorkspace({
    id: input.id,
    tenantID: input.tenant_id,
    externalID: input.external_id ?? undefined,
    name: input.name ?? undefined,
    time: {
      created: numberValue(input.time_created),
      updated: numberValue(input.time_updated),
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
    model: input.model ? parseJSON(input.model) : undefined,
    summary: input.summary ?? undefined,
    time: {
      created: numberValue(input.time_created),
      updated: numberValue(input.time_updated),
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
      created: numberValue(input.time_created),
      updated: numberValue(input.time_updated),
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
    size: numberValue(input.size),
    objectKey: input.object_key,
    sha256: input.sha256 ?? undefined,
    time: {
      created: numberValue(input.time_created),
      updated: numberValue(input.time_updated),
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
    size: numberValue(input.size),
    objectKey: input.object_key,
    sha256: input.sha256 ?? undefined,
    time: {
      created: numberValue(input.time_created),
      updated: numberValue(input.time_updated),
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
    enabled: input.enabled === true || input.enabled === 1,
    time: {
      created: numberValue(input.time_created),
      updated: numberValue(input.time_updated),
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
    enabled: input.enabled === true || input.enabled === 1,
    version: numberValue(input.version),
    lastUsedAt: input.last_used_at === null || input.last_used_at === undefined ? undefined : numberValue(input.last_used_at),
    time: {
      created: numberValue(input.time_created),
      updated: numberValue(input.time_updated),
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
    maxActiveJobs: Number(input.max_active_jobs),
    maxSessions: Number(input.max_sessions),
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    metrics: parseJSON(input.metrics),
    time: {
      created: numberValue(input.time_created),
      updated: numberValue(input.time_updated),
    },
  })
}

function sessionRuntimeBinding(input: Record<string, unknown>) {
  return CloudRuntimePool.decodeSessionBinding({
    tenantID: input.tenant_id,
    sessionID: input.session_id,
    runtimeID: input.runtime_id,
    time: {
      created: numberValue(input.time_created),
      updated: numberValue(input.time_updated),
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

function webhookRow(input: WebhookSubscription) {
  return {
    ...CloudRepository.webhookRow(input),
    enabled: input.enabled,
  }
}

async function getWorkspace(input: { client: QueryClient; tenantID: string; id: string }) {
  return rows(await input.client.query("select * from cloud_workspace where tenant_id = $1 and id = $2", [input.tenantID, input.id]))
    .map(workspace)
    .at(0)
}

async function getSession(input: { client: QueryClient; tenantID: string; id: string }) {
  return rows(await input.client.query("select * from cloud_session where tenant_id = $1 and id = $2", [input.tenantID, input.id]))
    .map(session)
    .at(0)
}

async function ensureTenant(input: { client: QueryClient; tenant: Tenant; now: number }) {
  await input.client.query(
    `insert into cloud_tenant (
      id, name, default_runtime_version, allowed_models, budget, time_created, time_updated
    ) values ($1, $2, $3, $4, $5, $6, $7)
    on conflict(id) do update set
      default_runtime_version = excluded.default_runtime_version,
      allowed_models = excluded.allowed_models,
      time_updated = excluded.time_updated`,
    [
      input.tenant.id,
      input.tenant.id,
      input.tenant.defaultRuntimeVersion,
      input.tenant.allowedModels,
      {},
      input.now,
      input.now,
    ],
  )
}

async function ensureUser(input: { client: QueryClient; tenantID: string; userID: string; now: number }) {
  await input.client.query(
    `insert into cloud_user (id, tenant_id, external_id, time_created, time_updated)
    values ($1, $2, $3, $4, $5)
    on conflict(id) do update set time_updated = excluded.time_updated`,
    [input.userID, input.tenantID, input.userID, input.now, input.now],
  )
}

export function create(input: {
  client: QueryClient
  tenant: Tenant
  tools: ToolCatalog
  now: () => number
  id: (prefix: string) => string
  stageFile?: (input: CloudAPI.CreateFileRequest & { tenantID: string; fileID: string }) => Promise<{
    objectKey: string
    size: number
    sha256?: string
  }> | {
    objectKey: string
    size: number
    sha256?: string
  }
  signArtifactDownload?: (input: { artifact: Artifact; expiresAt: number }) => Promise<string | undefined> | string | undefined
  modelSecretStore?: ModelSecretStore
}) {
  return {
    async createWorkspace(request: CloudAPI.CreateWorkspaceRequest) {
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
      await ensureTenant({ client: input.client, tenant: input.tenant, now: input.now() })
      await CloudPostgresRunner.run({
        client: input.client,
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
    async createSession(request: CloudAPI.CreateSessionRequest) {
      const found = await getWorkspace({ client: input.client, tenantID: input.tenant.id, id: request.workspaceID })
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
      await ensureUser({ client: input.client, tenantID: input.tenant.id, userID: request.userID, now: input.now() })
      await CloudPostgresRunner.run({
        client: input.client,
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
    async createJob(request: CloudAPI.CreateJobRequest) {
      const found = await getSession({ client: input.client, tenantID: input.tenant.id, id: request.sessionID })
      if (!found) throw new Error("Cloud session not found")
      const spec = CloudOrchestrator.planJob({
        id: input.id("job"),
        tenant: input.tenant,
        session: found,
        request,
        tools: input.tools,
        modelCredentials: await this.listLLMCredentials(),
        modelContext: {
          integratorID: request.integratorID,
          externalTenantID: request.externalTenantID,
          externalUserID: request.externalUserID,
          workspaceID: found.workspaceID,
          sessionID: found.id,
        },
      })
      const policy = request.integratorID
        ? await this.getIntegratorRuntimePolicy({ integratorID: request.integratorID })
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
      await CloudPostgresRunner.run({
        client: input.client,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            ...CloudRepository.createJobTransaction({
              job,
              spec,
              event: CloudEvent.status({ jobID: job.id, sequence: 1, status: job.status, time: job.time.created }),
            }),
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
    async createSessionMessage(sessionID: string, request: CloudAPI.CreateSessionMessageRequest) {
      const found = await getSession({ client: input.client, tenantID: input.tenant.id, id: sessionID })
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
      await CloudPostgresRunner.run({
        client: input.client,
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
    async listSessionMessages(request: { sessionID: string }) {
      const found = await getSession({ client: input.client, tenantID: input.tenant.id, id: request.sessionID })
      if (!found) throw new Error("Cloud session not found")
      return rows(
        await input.client.query("select * from cloud_message where tenant_id = $1 and session_id = $2 order by time_created, id", [
          input.tenant.id,
          found.id,
        ]),
      ).map(message)
    },
    async createFile(request: CloudAPI.CreateFileRequest) {
      const found = await getWorkspace({ client: input.client, tenantID: input.tenant.id, id: request.workspaceID })
      if (!found) throw new Error("Cloud workspace not found")
      const foundSession = request.sessionID
        ? await getSession({ client: input.client, tenantID: input.tenant.id, id: request.sessionID })
        : undefined
      if (request.sessionID && !foundSession) throw new Error("Cloud session not found")
      if (foundSession && foundSession.workspaceID !== found.id) throw new Error("Cloud session workspace mismatch")
      if (!input.stageFile) throw new Error("Cloud file staging adapter not configured")
      const id = input.id("file")
      const staged = await input.stageFile({ ...request, tenantID: input.tenant.id, fileID: id })
      const result = CloudSchema.decodeFile({
        id,
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
      await CloudPostgresRunner.run({
        client: input.client,
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
    async listFiles(request: { workspaceID?: string; sessionID?: string; cursor?: string; limit?: number }) {
      return rows(
        await input.client.query(
          "select * from cloud_file where tenant_id = $1 and ($2::text is null or workspace_id = $3) and ($4::text is null or session_id = $5) and ($6::text is null or id > $7) order by time_created, id limit $8",
          [
            input.tenant.id,
            request.workspaceID ?? null,
            request.workspaceID ?? null,
            request.sessionID ?? null,
            request.sessionID ?? null,
            request.cursor ?? null,
            request.cursor ?? null,
            request.limit ?? 2_147_483_647,
          ],
        ),
      ).map(file)
    },
    async getJob(request: { jobID: string }) {
      const job = await CloudPostgresRepository.getJob({ client: input.client, tenantID: input.tenant.id, id: request.jobID })
      if (!job) throw new Error("Cloud job not found")
      return job
    },
    async cancelJob(request: { jobID: string }) {
      const job = await CloudPostgresRepository.getJob({ client: input.client, tenantID: input.tenant.id, id: request.jobID })
      if (!job) throw new Error("Cloud job not found")
      const canceled = CloudSchema.decodeJob({
        ...job,
        status: CloudSchema.transitionJobStatus(job.status, "canceled"),
        time: {
          ...job.time,
          updated: input.now(),
        },
      })
      await CloudPostgresRunner.run({
        client: input.client,
        operations: CloudDatabaseAdapter.transaction({
          mutations: CloudRepository.cancelJobTransaction({
            job: canceled,
            event: CloudEvent.status({
              jobID: canceled.id,
              sequence: (await CloudPostgresRepository.listEvents({ client: input.client, jobID: canceled.id })).length + 1,
              status: canceled.status,
              time: canceled.time.updated,
            }),
          }),
        }),
      })
      return canceled
    },
    listJobEvents(request: { jobID: string; cursor?: string; limit?: number }) {
      return CloudPostgresRepository.listEvents({ client: input.client, ...request })
    },
    async listArtifacts(request: { jobID?: string; cursor?: string; limit?: number }) {
      return rows(
        await input.client.query(
          "select * from cloud_artifact where tenant_id = $1 and ($2::text is null or job_id = $3) and ($4::text is null or id > $5) order by time_created, id limit $6",
          [input.tenant.id, request.jobID ?? null, request.jobID ?? null, request.cursor ?? null, request.cursor ?? null, request.limit ?? 2_147_483_647],
        ),
      ).map(artifact)
    },
    async getArtifactDownload(request: { artifactID: string; ttlMS: number }): Promise<CloudAPI.ArtifactDownloadResponse> {
      const found = rows(
        await input.client.query("select * from cloud_artifact where tenant_id = $1 and id = $2", [input.tenant.id, request.artifactID]),
      )
        .map(artifact)
        .at(0)
      if (!found) throw new Error("Cloud artifact not found")
      if (!input.signArtifactDownload) throw new Error("Cloud artifact download signer not configured")
      const expiresAt = input.now() + request.ttlMS
      return {
        artifactID: found.id,
        url: await input.signArtifactDownload({ artifact: found, expiresAt }) ?? "",
        expiresAt,
      }
    },
    async createWebhook(request: CloudAPI.CreateWebhookRequest) {
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
      await ensureTenant({ client: input.client, tenant: input.tenant, now: input.now() })
      await CloudPostgresRunner.run({
        client: input.client,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            {
              action: "insert",
              table: "cloud_webhook_subscription",
              key: { id: result.id },
              values: webhookRow(result),
            },
          ],
        }),
      })
      return result
    },
    async listWebhooks() {
      return rows(
        await input.client.query("select * from cloud_webhook_subscription where tenant_id = $1 order by time_created, id", [
          input.tenant.id,
        ]),
      ).map(webhook)
    },
    async updateWebhook(request: { webhookID: string } & CloudAPI.UpdateWebhookRequest) {
      const found = rows(
        await input.client.query("select * from cloud_webhook_subscription where tenant_id = $1 and id = $2", [
          input.tenant.id,
          request.webhookID,
        ]),
      )
        .map(webhook)
        .at(0)
      if (!found) throw new Error("Cloud webhook not found")
      const result = CloudSchema.decodeWebhookSubscription({
        ...found,
        enabled: request.enabled,
        time: {
          ...found.time,
          updated: input.now(),
        },
      })
      await CloudPostgresRunner.run({
        client: input.client,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            {
              action: "update",
              table: "cloud_webhook_subscription",
              key: { id: result.id, tenant_id: result.tenantID },
              values: webhookRow(result),
            },
          ],
        }),
      })
      return result
    },
    async deleteWebhook(request: { webhookID: string }) {
      const found = rows(
        await input.client.query("select * from cloud_webhook_subscription where tenant_id = $1 and id = $2", [
          input.tenant.id,
          request.webhookID,
        ]),
      )
        .map(webhook)
        .at(0)
      if (!found) throw new Error("Cloud webhook not found")
      await CloudPostgresRunner.run({
        client: input.client,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [
            {
              action: "delete",
              table: "cloud_webhook_subscription",
              key: { id: found.id, tenant_id: found.tenantID },
            },
          ],
        }),
      })
      return found
    },
    async createLLMCredential(request: CloudAPI.CreateLLMCredentialRequest) {
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
      await ensureTenant({ client: input.client, tenant: input.tenant, now: input.now() })
      await CloudPostgresRunner.run({
        client: input.client,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [{ action: "insert", table: "cloud_llm_credential", key: { id }, values: CloudRepository.llmCredentialRow(result) }],
        }),
      })
      input.modelSecretStore?.put({ tenantID: input.tenant.id, secretRef, secret: request.apiKey, now: input.now() })
      return result
    },
    async listLLMCredentials() {
      return rows(
        await input.client.query("select * from cloud_llm_credential where tenant_id = $1 order by time_created, id", [
          input.tenant.id,
        ]),
      ).map(llmCredential)
    },
    async getLLMCredential(request: { credentialID: string }) {
      const found = rows(
        await input.client.query("select * from cloud_llm_credential where tenant_id = $1 and id = $2", [
          input.tenant.id,
          request.credentialID,
        ]),
      )
        .map(llmCredential)
        .at(0)
      if (!found) throw new Error("Cloud LLM credential not found")
      return found
    },
    async updateLLMCredential(credentialID: string, request: CloudAPI.UpdateLLMCredentialRequest) {
      const current = await this.getLLMCredential({ credentialID })
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
      await CloudPostgresRunner.run({
        client: input.client,
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
    async deleteLLMCredential(request: { credentialID: string }) {
      const result = await this.getLLMCredential(request)
      await CloudPostgresRunner.run({
        client: input.client,
        operations: CloudDatabaseAdapter.transaction({
          mutations: [{ action: "delete", table: "cloud_llm_credential", key: { id: result.id, tenant_id: result.tenantID } }],
        }),
      })
      return result
    },
    async testLLMCredential(request: { credentialID: string }) {
      const credential = await this.getLLMCredential(request)
      const secretAvailable = input.modelSecretStore
        ? Boolean(input.modelSecretStore.resolve({ tenantID: input.tenant.id, secretRef: credential.secretRef }))
        : true
      return { ok: credential.enabled && secretAvailable, credentialID: credential.id, provider: credential.provider, model: credential.defaultModel }
    },
    async registerRuntimeWorker(request: {
      runtimeID: string
      executionMode?: RuntimeWorker["executionMode"]
      status?: RuntimeWorker["status"]
      version: string
      profile: RuntimeWorker["profile"]
      maxActiveJobs: number
      maxSessions: number
      endpoint?: string
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
        endpoint: request.endpoint,
        metrics: request.metrics ?? emptyRuntimeMetrics,
        time: { created: input.now(), updated: input.now() },
      })
      await ensureTenant({ client: input.client, tenant: input.tenant, now: input.now() })
      await input.client.query(
        `insert into cloud_runtime_worker (
          id, tenant_id, execution_mode, status, version, profile, max_active_jobs, max_sessions, endpoint, metrics, time_created, time_updated
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        on conflict(id) do update set
          execution_mode = excluded.execution_mode,
          status = excluded.status,
          version = excluded.version,
          profile = excluded.profile,
          max_active_jobs = excluded.max_active_jobs,
          max_sessions = excluded.max_sessions,
          endpoint = excluded.endpoint,
          metrics = excluded.metrics,
          time_updated = excluded.time_updated`,
        [
          result.id,
          result.tenantID,
          result.executionMode,
          result.status,
          result.version,
          result.profile,
          result.maxActiveJobs,
          result.maxSessions,
          result.endpoint ?? null,
          JSON.stringify(result.metrics),
          result.time.created,
          result.time.updated,
        ],
      )
      return result
    },
    async heartbeatRuntimeWorker(runtimeID: string, request: {
      status?: RuntimeWorker["status"]
      metrics?: RuntimeWorker["metrics"]
    }) {
      const runtime = await this.getRuntimeWorker({ runtimeID })
      const result = CloudRuntimePool.decodeRuntimeWorker({
        ...runtime,
        ...(request.status ? { status: request.status } : {}),
        ...(request.metrics ? { metrics: request.metrics } : {}),
        time: { ...runtime.time, updated: input.now() },
      })
      await input.client.query(
        `update cloud_runtime_worker set
          status = $1,
          metrics = $2,
          time_updated = $3
        where tenant_id = $4 and id = $5`,
        [result.status, JSON.stringify(result.metrics), result.time.updated, input.tenant.id, result.id],
      )
      return result
    },
    async listRuntimeWorkers() {
      return rows(
        await input.client.query("select * from cloud_runtime_worker where tenant_id = $1 order by id", [
          input.tenant.id,
        ]),
      ).map(runtimeWorker)
    },
    async getRuntimeWorker(request: { runtimeID: string }) {
      const found = rows(
        await input.client.query("select * from cloud_runtime_worker where tenant_id = $1 and id = $2", [
          input.tenant.id,
          request.runtimeID,
        ]),
      )
        .map(runtimeWorker)
        .at(0)
      if (!found) throw new Error("Cloud runtime worker not found")
      return found
    },
    async drainRuntimeWorker(request: { runtimeID: string }) {
      return this.heartbeatRuntimeWorker(request.runtimeID, { status: "draining" })
    },
    async restartRuntimeWorker(request: { runtimeID: string }) {
      return this.heartbeatRuntimeWorker(request.runtimeID, { status: "healthy", metrics: emptyRuntimeMetrics })
    },
    async assignSessionRuntime(request: { sessionID: string }) {
      const found = await getSession({ client: input.client, tenantID: input.tenant.id, id: request.sessionID })
      if (!found) throw new Error("Cloud session not found")
      const assignment = CloudRuntimePool.assign({
        tenantID: input.tenant.id,
        sessionID: found.id,
        runtimes: await this.listRuntimeWorkers(),
        bindings: rows(
          await input.client.query("select * from cloud_session_runtime_binding where tenant_id = $1", [
            input.tenant.id,
          ]),
        ).map(sessionRuntimeBinding),
      })
      if (!assignment.assigned) throw new Error("Cloud runtime capacity exhausted")
      const binding = CloudRuntimePool.bindSession({
        tenantID: input.tenant.id,
        sessionID: found.id,
        runtimeID: assignment.runtimeID,
        now: input.now(),
      })
      await input.client.query(
        `insert into cloud_session_runtime_binding (
          tenant_id, session_id, runtime_id, time_created, time_updated
        ) values ($1, $2, $3, $4, $5)
        on conflict(tenant_id, session_id) do update set
          runtime_id = excluded.runtime_id,
          time_updated = excluded.time_updated`,
        [binding.tenantID, binding.sessionID, binding.runtimeID, binding.time.created, binding.time.updated],
      )
      return binding
    },
    async getSessionRuntimeBinding(request: { sessionID: string }) {
      const found = await getSession({ client: input.client, tenantID: input.tenant.id, id: request.sessionID })
      if (!found) throw new Error("Cloud session not found")
      return rows(
        await input.client.query("select * from cloud_session_runtime_binding where tenant_id = $1 and session_id = $2", [
          input.tenant.id,
          found.id,
        ]),
      )
        .map(sessionRuntimeBinding)
        .at(0)
    },
    async listSessionRuntimeBindings() {
      return rows(
        await input.client.query("select * from cloud_session_runtime_binding where tenant_id = $1 order by session_id", [
          input.tenant.id,
        ]),
      ).map(sessionRuntimeBinding)
    },
    async releaseSessionRuntime(request: { sessionID: string }) {
      const binding = await this.getSessionRuntimeBinding(request)
      if (!binding) throw new Error("Cloud session runtime binding not found")
      await input.client.query("delete from cloud_session_runtime_binding where tenant_id = $1 and session_id = $2", [
        input.tenant.id,
        binding.sessionID,
      ])
      return binding
    },
    async reconcileRuntimePool(request: { heartbeatTTLMS: number }) {
      const result = CloudRuntimePool.reconcile({
        tenantID: input.tenant.id,
        now: input.now(),
        heartbeatTTLMS: request.heartbeatTTLMS,
        runtimes: await this.listRuntimeWorkers(),
        bindings: rows(
          await input.client.query("select * from cloud_session_runtime_binding where tenant_id = $1", [
            input.tenant.id,
          ]),
        ).map(sessionRuntimeBinding),
      })
      await Promise.all(
        result.runtimes.map((runtime) =>
          input.client.query(
            `update cloud_runtime_worker set
              status = $1,
              metrics = $2,
              time_updated = $3
            where tenant_id = $4 and id = $5`,
            [runtime.status, runtime.metrics, runtime.time.updated, input.tenant.id, runtime.id],
          ),
        ),
      )
      await Promise.all(
        result.releasedBindings.map((binding) =>
          input.client.query("delete from cloud_session_runtime_binding where tenant_id = $1 and session_id = $2", [
            input.tenant.id,
            binding.sessionID,
          ]),
        ),
      )
      return {
        offlineRuntimeIDs: result.runtimes
          .filter((runtime) => runtime.tenantID === input.tenant.id && runtime.status === "offline")
          .map((runtime) => runtime.id),
        releasedSessionIDs: result.releasedBindings.map((binding) => binding.sessionID),
      }
    },
    async applyRuntimePoolPlan(request?: ApplyRuntimePoolPlanRequest) {
      const runtimes = await this.listRuntimeWorkers()
      const plan = CloudRuntimePool.poolPlan({
        tenantID: input.tenant.id,
        runtimes,
        bindings: await this.listSessionRuntimeBindings(),
      })
      const drainedRuntimeIDs = await Promise.all(
        plan.drainRuntimeIDs.map((runtimeID) => this.drainRuntimeWorker({ runtimeID }).then((runtime) => runtime.id)),
      )
      await Promise.all(
        plan.releaseSessionIDs.map((sessionID) =>
          input.client.query("delete from cloud_session_runtime_binding where tenant_id = $1 and session_id = $2", [
            input.tenant.id,
            sessionID,
          ]),
        ),
      )
      return {
        desiredRuntimes: plan.desiredRuntimes,
        action: plan.action,
        reason: plan.reason,
        drainedRuntimeIDs,
        releasedSessionIDs: plan.releaseSessionIDs,
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
            releasedSessionIDs: plan.releaseSessionIDs,
          },
        }),
      }
    },
    async getIntegratorRuntimePolicy(request: { integratorID: string }) {
      return rows(
        await input.client.query("select * from cloud_integrator_runtime_policy where tenant_id = $1 and integrator_id = $2", [
          input.tenant.id,
          request.integratorID,
        ]),
      )
        .map(integratorRuntimePolicy)
        .at(0)
    },
    async updateIntegratorRuntimePolicy(integratorID: string, request: IntegratorRuntimePolicyUpdate) {
      const result = CloudTenantPolicy.integratorRuntimePolicy({
        ...request,
        tenantID: input.tenant.id,
        integratorID,
      })
      await ensureTenant({ client: input.client, tenant: input.tenant, now: input.now() })
      await input.client.query(
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
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict(tenant_id, integrator_id) do update set
          default_execution_mode = excluded.default_execution_mode,
          allowed_execution_modes = excluded.allowed_execution_modes,
          max_active_jobs = excluded.max_active_jobs,
          max_sessions = excluded.max_sessions,
          max_concurrent_jobs_per_session = excluded.max_concurrent_jobs_per_session,
          time_updated = excluded.time_updated`,
        [
          result.tenantID,
          result.integratorID,
          result.defaultExecutionMode,
          JSON.stringify(result.allowedExecutionModes),
          result.maxActiveJobs,
          result.maxSessions,
          result.maxConcurrentJobsPerSession,
          input.now(),
          input.now(),
        ],
      )
      return result
    },
  }
}

export * as CloudPostgresService from "./postgres-service"
