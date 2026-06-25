import { CloudAPI } from "./api"
import { CloudEvent } from "./event"
import { CloudOrchestrator } from "./orchestrator"
import { CloudRuntimeExecutor } from "./runtime-executor"
import { CloudRuntimePool, type RuntimeWorker } from "./runtime-pool"
import { CloudRuntimePoolScaler } from "./runtime-pool-scaler"
import { CloudSchema, type Artifact } from "./schema"
import { CloudTenantPolicy, type IntegratorRuntimePolicyUpdate } from "./tenant-policy"
import type { CloudStore } from "./store"
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

export function create(input: {
  store: ReturnType<typeof CloudStore.create>
  tenant: Tenant
  tools: ToolCatalog
  now: () => number
  id: (prefix: string) => string
  signArtifactDownload?: (input: { artifact: Artifact; expiresAt: number }) => string
  stageFile?: (input: CloudAPI.CreateFileRequest & { tenantID: string }) => {
    objectKey: string
    size: number
    sha256?: string
  }
  modelSecretStore?: ModelSecretStore
}) {
  const integratorRuntimePolicies = new Map<string, ReturnType<typeof CloudTenantPolicy.integratorRuntimePolicy>>()
  return {
    createWorkspace(request: CloudAPI.CreateWorkspaceRequest) {
      return input.store.putWorkspace({
        id: input.id("workspace"),
        tenantID: input.tenant.id,
        externalID: request.externalID,
        name: request.name,
        time: {
          created: input.now(),
          updated: input.now(),
        },
      })
    },
    createSession(request: CloudAPI.CreateSessionRequest) {
      const workspace = input.store.getWorkspace({ tenantID: input.tenant.id, id: request.workspaceID })
      if (!workspace) throw new Error("Cloud workspace not found")
      return input.store.putSession({
        id: input.id("session"),
        tenantID: input.tenant.id,
        workspaceID: workspace.id,
        userID: request.userID,
        title: request.title ?? "Untitled",
        model: request.model,
        time: {
          created: input.now(),
          updated: input.now(),
        },
      })
    },
    createSessionMessage(sessionID: string, request: CloudAPI.CreateSessionMessageRequest) {
      const session = input.store.getSession({ tenantID: input.tenant.id, id: sessionID })
      if (!session) throw new Error("Cloud session not found")
      return input.store.putMessage({
        id: input.id("message"),
        tenantID: input.tenant.id,
        workspaceID: session.workspaceID,
        sessionID: session.id,
        role: request.role ?? "user",
        content: request.content,
        time: {
          created: input.now(),
          updated: input.now(),
        },
      })
    },
    listSessionMessages(request: { sessionID: string }) {
      const session = input.store.getSession({ tenantID: input.tenant.id, id: request.sessionID })
      if (!session) throw new Error("Cloud session not found")
      return input.store.listMessages({ tenantID: input.tenant.id, sessionID: session.id })
    },
    createFile(request: CloudAPI.CreateFileRequest) {
      const workspace = input.store.getWorkspace({ tenantID: input.tenant.id, id: request.workspaceID })
      if (!workspace) throw new Error("Cloud workspace not found")
      const session = request.sessionID
        ? input.store.getSession({ tenantID: input.tenant.id, id: request.sessionID })
        : undefined
      if (request.sessionID && !session) throw new Error("Cloud session not found")
      if (session && session.workspaceID !== workspace.id) throw new Error("Cloud session workspace mismatch")
      if (!input.stageFile) throw new Error("Cloud file staging adapter not configured")
      const staged = input.stageFile({ ...request, tenantID: input.tenant.id })
      return input.store.putFile({
        id: input.id("file"),
        tenantID: input.tenant.id,
        workspaceID: workspace.id,
        sessionID: session?.id,
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
    },
    listFiles(request: { workspaceID?: string; sessionID?: string; cursor?: string; limit?: number }) {
      if (request.workspaceID && !input.store.getWorkspace({ tenantID: input.tenant.id, id: request.workspaceID })) {
        throw new Error("Cloud workspace not found")
      }
      if (request.sessionID && !input.store.getSession({ tenantID: input.tenant.id, id: request.sessionID })) {
        throw new Error("Cloud session not found")
      }
      return input.store.listFiles({
        tenantID: input.tenant.id,
        workspaceID: request.workspaceID,
        sessionID: request.sessionID,
        cursor: request.cursor,
        limit: request.limit,
      })
    },
    createJob(request: CloudAPI.CreateJobRequest) {
      const session = input.store.getSession({ tenantID: input.tenant.id, id: request.sessionID })
      if (!session) throw new Error("Cloud session not found")
      const spec = CloudOrchestrator.planJob({
        id: input.id("job"),
        tenant: input.tenant,
        session,
        request,
        tools: input.tools,
        modelCredentials: input.store.listLLMCredentials({ tenantID: input.tenant.id }),
        modelContext: {
          integratorID: request.integratorID,
          externalTenantID: request.externalTenantID,
          externalUserID: request.externalUserID,
          workspaceID: session.workspaceID,
          sessionID: session.id,
        },
      })
      const job = input.store.putJob({
        id: spec.id,
        tenantID: spec.tenantID,
        workspaceID: spec.workspaceID,
        sessionID: spec.sessionID,
        status: "queued",
        executionMode: request.integratorID
          ? integratorRuntimePolicies.get(request.integratorID)?.defaultExecutionMode ?? CloudRuntimeExecutor.mode(process.env)
          : CloudRuntimeExecutor.mode(process.env),
        runtime: spec.runtime,
        modelConfigSnapshot: spec.modelConfigSnapshot,
        cost: emptyCost,
        time: {
          created: input.now(),
          updated: input.now(),
        },
      })
      input.store.putJobSpec(spec)
      input.store.putJobPrompt({
        id: job.id,
        tenantID: job.tenantID,
        jobID: job.id,
        prompt: request.prompt,
      })
      input.store.appendEvent(CloudEvent.status({ jobID: job.id, sequence: 1, status: job.status, time: job.time.created }))
      return job
    },
    getJob(request: { jobID: string }) {
      const job = input.store.getJob({ tenantID: input.tenant.id, id: request.jobID })
      if (!job) throw new Error("Cloud job not found")
      return job
    },
    cancelJob(request: { jobID: string }) {
      const job = input.store.updateJobStatus({
        tenantID: input.tenant.id,
        id: request.jobID,
        status: "canceled",
        now: input.now(),
      })
      input.store.appendEvent(
        CloudEvent.status({
          jobID: job.id,
          sequence: input.store.listEvents({ jobID: job.id }).length + 1,
          status: job.status,
          time: job.time.updated,
        }),
      )
      return job
    },
    listJobEvents(request: { jobID: string; cursor?: string; limit?: number }) {
      return input.store.listEvents(request)
    },
    listArtifacts(request: { jobID?: string; cursor?: string; limit?: number }) {
      return input.store.listArtifacts({ tenantID: input.tenant.id, jobID: request.jobID, cursor: request.cursor, limit: request.limit })
    },
    getArtifactDownload(request: { artifactID: string; ttlMS: number }): CloudAPI.ArtifactDownloadResponse {
      const artifact = input.store.getArtifact({ tenantID: input.tenant.id, id: request.artifactID })
      if (!artifact) throw new Error("Cloud artifact not found")
      if (!input.signArtifactDownload) throw new Error("Cloud artifact download signer not configured")
      const expiresAt = input.now() + request.ttlMS
      return {
        artifactID: artifact.id,
        url: input.signArtifactDownload({ artifact, expiresAt }),
        expiresAt,
      }
    },
    createWebhook(request: CloudAPI.CreateWebhookRequest) {
      const id = input.id("webhook")
      return input.store.putWebhook({
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
    },
    listWebhooks() {
      return input.store.listWebhooks({ tenantID: input.tenant.id })
    },
    updateWebhook(request: { webhookID: string } & CloudAPI.UpdateWebhookRequest) {
      return input.store.updateWebhook({
        tenantID: input.tenant.id,
        id: request.webhookID,
        enabled: request.enabled,
        now: input.now(),
      })
    },
    deleteWebhook(request: { webhookID: string }) {
      return input.store.deleteWebhook({ tenantID: input.tenant.id, id: request.webhookID })
    },
    createLLMCredential(request: CloudAPI.CreateLLMCredentialRequest) {
      const secretRef = `${input.tenant.id}/${request.ownerKey}/${request.name}`
      const credential = CloudSchema.decodeLLMCredential({
        id: input.id("llmcred"),
        tenantID: input.tenant.id,
        scope: request.scope,
        ownerKey: request.ownerKey,
        name: request.name,
        providerType: request.providerType,
        provider: request.provider,
        baseURL: request.baseURL,
        secretRef,
        allowedModels: request.allowedModels ? [...request.allowedModels] : undefined,
        defaultModel: request.defaultModel,
        enabled: request.enabled,
        version: 1,
        time: {
          created: input.now(),
          updated: input.now(),
        },
      })
      input.modelSecretStore?.put({ tenantID: input.tenant.id, secretRef, secret: request.apiKey, now: input.now() })
      return input.store.putLLMCredential(credential)
    },
    listLLMCredentials() {
      return input.store.listLLMCredentials({ tenantID: input.tenant.id })
    },
    getLLMCredential(request: { credentialID: string }) {
      const credential = input.store.getLLMCredential({ tenantID: input.tenant.id, id: request.credentialID })
      if (!credential) throw new Error("Cloud LLM credential not found")
      return credential
    },
    updateLLMCredential(credentialID: string, request: CloudAPI.UpdateLLMCredentialRequest) {
      const secretRef = request.apiKey ? `${input.tenant.id}/${credentialID}/rotated-${input.now()}` : undefined
      if (secretRef) input.modelSecretStore?.put({ tenantID: input.tenant.id, secretRef, secret: request.apiKey!, now: input.now() })
      return input.store.updateLLMCredential({
        tenantID: input.tenant.id,
        id: credentialID,
        name: request.name,
        baseURL: request.baseURL,
        secretRef,
        allowedModels: request.allowedModels ? [...request.allowedModels] : undefined,
        defaultModel: request.defaultModel,
        enabled: request.enabled,
        now: input.now(),
      })
    },
    deleteLLMCredential(request: { credentialID: string }) {
      return input.store.deleteLLMCredential({ tenantID: input.tenant.id, id: request.credentialID })
    },
    testLLMCredential(request: { credentialID: string }) {
      const credential = input.store.getLLMCredential({ tenantID: input.tenant.id, id: request.credentialID })
      if (!credential) throw new Error("Cloud LLM credential not found")
      const secretAvailable = input.modelSecretStore
        ? Boolean(input.modelSecretStore.resolve({ tenantID: input.tenant.id, secretRef: credential.secretRef }))
        : true
      return CloudAPI.decodeLLMCredentialTestResponse({
        ok: credential.enabled && secretAvailable,
        credentialID: credential.id,
        provider: credential.provider,
        model: credential.defaultModel,
      })
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
      return input.store.putRuntimeWorker(
        CloudRuntimePool.decodeRuntimeWorker({
          id: request.runtimeID,
          tenantID: input.tenant.id,
          executionMode: request.executionMode ?? "shared_session_pool",
          status: request.status ?? "healthy",
          version: request.version,
          profile: request.profile,
          maxActiveJobs: request.maxActiveJobs,
          maxSessions: request.maxSessions,
          metrics: request.metrics ?? emptyRuntimeMetrics,
          time: {
            created: input.now(),
            updated: input.now(),
          },
        }),
      )
    },
    heartbeatRuntimeWorker(runtimeID: string, request: {
      status?: RuntimeWorker["status"]
      metrics?: RuntimeWorker["metrics"]
    }) {
      const runtime = input.store.getRuntimeWorker({ tenantID: input.tenant.id, id: runtimeID })
      if (!runtime) throw new Error("Cloud runtime worker not found")
      return input.store.putRuntimeWorker(
        CloudRuntimePool.decodeRuntimeWorker({
          ...runtime,
          ...(request.status ? { status: request.status } : {}),
          ...(request.metrics ? { metrics: request.metrics } : {}),
          time: {
            ...runtime.time,
            updated: input.now(),
          },
        }),
      )
    },
    listRuntimeWorkers() {
      return input.store.listRuntimeWorkers({ tenantID: input.tenant.id })
    },
    getRuntimeWorker(request: { runtimeID: string }) {
      const runtime = input.store.getRuntimeWorker({ tenantID: input.tenant.id, id: request.runtimeID })
      if (!runtime) throw new Error("Cloud runtime worker not found")
      return runtime
    },
    drainRuntimeWorker(request: { runtimeID: string }) {
      const runtime = input.store.getRuntimeWorker({ tenantID: input.tenant.id, id: request.runtimeID })
      if (!runtime) throw new Error("Cloud runtime worker not found")
      return input.store.putRuntimeWorker(
        CloudRuntimePool.decodeRuntimeWorker({
          ...runtime,
          status: "draining",
          time: {
            ...runtime.time,
            updated: input.now(),
          },
        }),
      )
    },
    restartRuntimeWorker(request: { runtimeID: string }) {
      const runtime = input.store.getRuntimeWorker({ tenantID: input.tenant.id, id: request.runtimeID })
      if (!runtime) throw new Error("Cloud runtime worker not found")
      return input.store.putRuntimeWorker(
        CloudRuntimePool.decodeRuntimeWorker({
          ...runtime,
          status: "healthy",
          metrics: emptyRuntimeMetrics,
          time: {
            ...runtime.time,
            updated: input.now(),
          },
        }),
      )
    },
    assignSessionRuntime(request: { sessionID: string }) {
      const session = input.store.getSession({ tenantID: input.tenant.id, id: request.sessionID })
      if (!session) throw new Error("Cloud session not found")
      const assignment = CloudRuntimePool.assign({
        tenantID: input.tenant.id,
        sessionID: session.id,
        runtimes: input.store.listRuntimeWorkers({ tenantID: input.tenant.id }),
        bindings: input.store.listSessionRuntimeBindings({ tenantID: input.tenant.id }),
      })
      if (!assignment.assigned) throw new Error("Cloud runtime capacity exhausted")
      return input.store.putSessionRuntimeBinding(
        CloudRuntimePool.bindSession({
          tenantID: input.tenant.id,
          sessionID: session.id,
          runtimeID: assignment.runtimeID,
          now: input.now(),
        }),
      )
    },
    getSessionRuntimeBinding(request: { sessionID: string }) {
      const session = input.store.getSession({ tenantID: input.tenant.id, id: request.sessionID })
      if (!session) throw new Error("Cloud session not found")
      return input.store.getSessionRuntimeBinding({ tenantID: input.tenant.id, sessionID: session.id })
    },
    listSessionRuntimeBindings() {
      return input.store.listSessionRuntimeBindings({ tenantID: input.tenant.id })
    },
    releaseSessionRuntime(request: { sessionID: string }) {
      const session = input.store.getSession({ tenantID: input.tenant.id, id: request.sessionID })
      if (!session) throw new Error("Cloud session not found")
      return input.store.deleteSessionRuntimeBinding({ tenantID: input.tenant.id, sessionID: session.id })
    },
    reconcileRuntimePool(request: { heartbeatTTLMS: number }) {
      const result = CloudRuntimePool.reconcile({
        tenantID: input.tenant.id,
        now: input.now(),
        heartbeatTTLMS: request.heartbeatTTLMS,
        runtimes: input.store.listRuntimeWorkers({ tenantID: input.tenant.id }),
        bindings: input.store.listSessionRuntimeBindings({ tenantID: input.tenant.id }),
      })
      result.runtimes.map((runtime) => input.store.putRuntimeWorker(runtime))
      result.releasedBindings.map((binding) =>
        input.store.deleteSessionRuntimeBinding({ tenantID: input.tenant.id, sessionID: binding.sessionID }),
      )
      return {
        offlineRuntimeIDs: result.runtimes
          .filter((runtime) => runtime.tenantID === input.tenant.id && runtime.status === "offline")
          .map((runtime) => runtime.id),
        releasedSessionIDs: result.releasedBindings.map((binding) => binding.sessionID),
      }
    },
    applyRuntimePoolPlan(request?: ApplyRuntimePoolPlanRequest) {
      const runtimes = input.store.listRuntimeWorkers({ tenantID: input.tenant.id })
      const plan = CloudRuntimePool.poolPlan({
        tenantID: input.tenant.id,
        runtimes,
        bindings: input.store.listSessionRuntimeBindings({ tenantID: input.tenant.id }),
      })
      const drainedRuntimeIDs = plan.drainRuntimeIDs.map((runtimeID) => this.drainRuntimeWorker({ runtimeID }).id)
      const releasedSessionIDs = plan.releaseSessionIDs.map(
        (sessionID) => input.store.deleteSessionRuntimeBinding({ tenantID: input.tenant.id, sessionID }).sessionID,
      )
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
      return integratorRuntimePolicies.get(request.integratorID)
    },
    updateIntegratorRuntimePolicy(integratorID: string, request: IntegratorRuntimePolicyUpdate) {
      const result = CloudTenantPolicy.integratorRuntimePolicy({
        tenantID: input.tenant.id,
        integratorID,
        ...request,
      })
      integratorRuntimePolicies.set(integratorID, result)
      return result
    },
  }
}

export * as CloudService from "./service"
