import { Schema } from "effect"
import { CloudAPI } from "./api"

type Fetch = (request: Request) => Promise<Response>

function url(input: { baseURL: string; path: string; query?: Record<string, string | undefined> }) {
  const result = new URL(input.path, input.baseURL.endsWith("/") ? input.baseURL : `${input.baseURL}/`)
  Object.entries(input.query ?? {}).map(([key, value]) => {
    if (value) result.searchParams.set(key, value)
  })
  return result
}

async function request(input: {
  fetch: Fetch
  baseURL: string
  apiKey: string
  method: string
  path: string
  query?: Record<string, string | undefined>
  body?: unknown
}) {
  const response = await input.fetch(
    new Request(url({ baseURL: input.baseURL, path: input.path, query: input.query }), {
      method: input.method,
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        ...(input.body ? { "content-type": "application/json" } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    }),
  )
  if (!response.ok) {
    const body = CloudAPI.decodeErrorResponse(await response.json())
    throw new Error(`Cloud SDK request failed: ${response.status} ${body.error.message}`)
  }
  return response.json()
}

async function textRequest(input: {
  fetch: Fetch
  baseURL: string
  apiKey: string
  method: string
  path: string
  query?: Record<string, string | undefined>
}) {
  const response = await input.fetch(
    new Request(url({ baseURL: input.baseURL, path: input.path, query: input.query }), {
      method: input.method,
      headers: {
        authorization: `Bearer ${input.apiKey}`,
      },
    }),
  )
  if (!response.ok) {
    const body = CloudAPI.decodeErrorResponse(await response.json())
    throw new Error(`Cloud SDK request failed: ${response.status} ${body.error.message}`)
  }
  return response.text()
}

function array<A, I>(decode: (input: I) => A) {
  return (input: unknown) => Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(input).map((item) => decode(item as I))
}

function eventStream(input: string) {
  return input
    .split(/\n\n+/)
    .flatMap((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .filter(Boolean),
    )
    .map((line) => CloudAPI.decodeJobEvent(JSON.parse(line) as unknown))
}

export function create(input: { baseURL: string; apiKey: string; fetch?: Fetch }) {
  const fetch = input.fetch ?? globalThis.fetch
  return {
    async createWorkspace(body: CloudAPI.CreateWorkspaceRequest) {
      return CloudAPI.decodeWorkspaceResponse(
        await request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "POST", path: "/v1/workspaces", body }),
      )
    },
    async createSession(body: CloudAPI.CreateSessionRequest) {
      return CloudAPI.decodeSessionResponse(
        await request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "POST", path: "/v1/sessions", body }),
      )
    },
    async createFile(body: CloudAPI.CreateFileRequest) {
      return CloudAPI.decodeFileResponse(
        await request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "POST", path: "/v1/files", body }),
      )
    },
    async listFiles(inputRequest?: { workspaceID?: string; sessionID?: string }) {
      return array(CloudAPI.decodeFileResponse)(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: "/v1/files",
          query: { workspaceID: inputRequest?.workspaceID, sessionID: inputRequest?.sessionID },
        }),
      )
    },
    async listFilesPage(inputRequest: { workspaceID?: string; sessionID?: string; cursor?: string; limit: number }) {
      return CloudAPI.decodeFilePageResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: "/v1/files",
          query: {
            workspaceID: inputRequest.workspaceID,
            sessionID: inputRequest.sessionID,
            cursor: inputRequest.cursor,
            limit: String(inputRequest.limit),
          },
        }),
      )
    },
    async createJob(body: CloudAPI.CreateJobRequest) {
      return CloudAPI.decodeJobResponse(
        await request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "POST", path: "/v1/jobs", body }),
      )
    },
    async getJob(inputRequest: { jobID: string }) {
      return CloudAPI.decodeJobResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: `/v1/jobs/${inputRequest.jobID}`,
        }),
      )
    },
    async cancelJob(inputRequest: { jobID: string }) {
      return CloudAPI.decodeJobResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "POST",
          path: `/v1/jobs/${inputRequest.jobID}/cancel`,
        }),
      )
    },
    async listJobEvents(inputRequest: { jobID: string; cursor?: string }) {
      return array(CloudAPI.decodeJobEvent)(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: `/v1/jobs/${inputRequest.jobID}/events`,
          query: { cursor: inputRequest.cursor },
        }),
      )
    },
    async listJobEventsPage(inputRequest: { jobID: string; cursor?: string; limit: number }) {
      return CloudAPI.decodeJobEventPageResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: `/v1/jobs/${inputRequest.jobID}/events`,
          query: { cursor: inputRequest.cursor, limit: String(inputRequest.limit) },
        }),
      )
    },
    async streamJobEvents(inputRequest: {
      jobID: string
      cursor?: string
      limit?: number
      follow?: boolean
      pollMS?: number
      timeoutMS?: number
    }) {
      return eventStream(
        await textRequest({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: `/v1/jobs/${inputRequest.jobID}/events/stream`,
          query: {
            cursor: inputRequest.cursor,
            limit: inputRequest.limit ? String(inputRequest.limit) : undefined,
            follow: inputRequest.follow ? "true" : undefined,
            pollMS: inputRequest.pollMS ? String(inputRequest.pollMS) : undefined,
            timeoutMS: inputRequest.timeoutMS ? String(inputRequest.timeoutMS) : undefined,
          },
        }),
      )
    },
    async createSessionMessage(sessionID: string, body: CloudAPI.CreateSessionMessageRequest) {
      return CloudAPI.decodeMessageResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "POST",
          path: `/v1/sessions/${sessionID}/messages`,
          body,
        }),
      )
    },
    async listSessionMessages(inputRequest: { sessionID: string }) {
      return array(CloudAPI.decodeMessageResponse)(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: `/v1/sessions/${inputRequest.sessionID}/messages`,
        }),
      )
    },
    async listArtifacts(inputRequest?: { jobID?: string }) {
      return array(CloudAPI.decodeArtifactResponse)(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: "/v1/artifacts",
          query: { jobID: inputRequest?.jobID },
        }),
      )
    },
    async listArtifactsPage(inputRequest: { jobID?: string; cursor?: string; limit: number }) {
      return CloudAPI.decodeArtifactPageResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: "/v1/artifacts",
          query: { jobID: inputRequest.jobID, cursor: inputRequest.cursor, limit: String(inputRequest.limit) },
        }),
      )
    },
    async downloadArtifact(inputRequest: { artifactID: string }) {
      return CloudAPI.decodeArtifactDownloadResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: `/v1/artifacts/${inputRequest.artifactID}/download`,
        }),
      )
    },
    async listTools() {
      return request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "GET", path: "/v1/tools" })
    },
    async createWebhook(body: CloudAPI.CreateWebhookRequest) {
      return CloudAPI.decodeWebhookResponse(
        await request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "POST", path: "/v1/webhooks", body }),
      )
    },
    async listWebhooks() {
      return array(CloudAPI.decodeWebhookResponse)(
        await request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "GET", path: "/v1/webhooks" }),
      )
    },
    async updateWebhook(inputRequest: { webhookID: string } & CloudAPI.UpdateWebhookRequest) {
      return CloudAPI.decodeWebhookResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "PATCH",
          path: `/v1/webhooks/${inputRequest.webhookID}`,
          body: { enabled: inputRequest.enabled },
        }),
      )
    },
    async deleteWebhook(inputRequest: { webhookID: string }) {
      return CloudAPI.decodeWebhookResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "DELETE",
          path: `/v1/webhooks/${inputRequest.webhookID}`,
        }),
      )
    },
    async createLLMCredential(body: CloudAPI.CreateLLMCredentialRequest) {
      return CloudAPI.decodeLLMCredentialResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "POST",
          path: "/v1/llm-credentials",
          body,
        }),
      )
    },
    async listLLMCredentials() {
      return array(CloudAPI.decodeLLMCredentialResponse)(
        await request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "GET", path: "/v1/llm-credentials" }),
      )
    },
    async getLLMCredential(inputRequest: { credentialID: string }) {
      return CloudAPI.decodeLLMCredentialResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: `/v1/llm-credentials/${inputRequest.credentialID}`,
        }),
      )
    },
    async updateLLMCredential(inputRequest: { credentialID: string } & CloudAPI.UpdateLLMCredentialRequest) {
      return CloudAPI.decodeLLMCredentialResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "PATCH",
          path: `/v1/llm-credentials/${inputRequest.credentialID}`,
          body: {
            ...(inputRequest.name === undefined ? {} : { name: inputRequest.name }),
            ...(inputRequest.baseURL === undefined ? {} : { baseURL: inputRequest.baseURL }),
            ...(inputRequest.apiKey === undefined ? {} : { apiKey: inputRequest.apiKey }),
            ...(inputRequest.allowedModels === undefined ? {} : { allowedModels: inputRequest.allowedModels }),
            ...(inputRequest.defaultModel === undefined ? {} : { defaultModel: inputRequest.defaultModel }),
            ...(inputRequest.enabled === undefined ? {} : { enabled: inputRequest.enabled }),
          },
        }),
      )
    },
    async deleteLLMCredential(inputRequest: { credentialID: string }) {
      return CloudAPI.decodeLLMCredentialResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "DELETE",
          path: `/v1/llm-credentials/${inputRequest.credentialID}`,
        }),
      )
    },
    async testLLMCredential(inputRequest: { credentialID: string }) {
      return CloudAPI.decodeLLMCredentialTestResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "POST",
          path: `/v1/llm-credentials/${inputRequest.credentialID}/test`,
        }),
      )
    },
    async adminGetRuntimePool() {
      return CloudAPI.decodeRuntimePoolResponse(
        await request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "GET", path: "/admin/runtime-pools" }),
      )
    },
    async adminReconcileRuntimePool(inputRequest?: { heartbeatTTLMS?: number }) {
      return CloudAPI.decodeRuntimePoolReconcileResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "POST",
          path: "/admin/runtime-pools/reconcile",
          body: inputRequest ?? {},
        }),
      )
    },
    async adminApplyRuntimePoolPlan(inputRequest?: {
      target?: "local" | "kubernetes"
      currentRuntimes?: number
      namespace?: string
      deploymentName?: string
    }) {
      return CloudAPI.decodeRuntimePoolApplyPlanResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "POST",
          path: "/admin/runtime-pools/apply-plan",
          body: inputRequest ?? {},
        }),
      )
    },
    async adminListRuntimes() {
      return array(CloudAPI.decodeRuntimeWorkerResponse)(
        await request({ fetch, baseURL: input.baseURL, apiKey: input.apiKey, method: "GET", path: "/admin/runtimes" }),
      )
    },
    async adminGetRuntime(inputRequest: { runtimeID: string }) {
      return CloudAPI.decodeRuntimeWorkerResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: `/admin/runtimes/${inputRequest.runtimeID}`,
        }),
      )
    },
    async adminDrainRuntime(inputRequest: { runtimeID: string }) {
      return CloudAPI.decodeRuntimeWorkerResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "POST",
          path: `/admin/runtimes/${inputRequest.runtimeID}/drain`,
        }),
      )
    },
    async adminRestartRuntime(inputRequest: { runtimeID: string }) {
      return CloudAPI.decodeRuntimeWorkerResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "POST",
          path: `/admin/runtimes/${inputRequest.runtimeID}/restart`,
        }),
      )
    },
    async adminGetSessionRuntime(inputRequest: { sessionID: string }) {
      return CloudAPI.decodeSessionRuntimeBindingResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: `/admin/sessions/${inputRequest.sessionID}/runtime`,
        }),
      )
    },
    async adminReleaseSessionRuntime(inputRequest: { sessionID: string }) {
      return CloudAPI.decodeSessionRuntimeBindingResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "POST",
          path: `/admin/sessions/${inputRequest.sessionID}/release-runtime`,
        }),
      )
    },
    async adminGetIntegratorRuntimePolicy(inputRequest: { integratorID: string }) {
      return CloudAPI.decodeIntegratorRuntimePolicyResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "GET",
          path: `/admin/integrators/${inputRequest.integratorID}/runtime-policy`,
        }),
      )
    },
    async adminUpdateIntegratorRuntimePolicy(inputRequest: { integratorID: string } & CloudAPI.RuntimePolicyRequest) {
      return CloudAPI.decodeIntegratorRuntimePolicyResponse(
        await request({
          fetch,
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          method: "PATCH",
          path: `/admin/integrators/${inputRequest.integratorID}/runtime-policy`,
          body: CloudAPI.decodeRuntimePolicyRequest({
            defaultExecutionMode: inputRequest.defaultExecutionMode,
            allowedExecutionModes: inputRequest.allowedExecutionModes,
            maxActiveJobs: inputRequest.maxActiveJobs,
            maxSessions: inputRequest.maxSessions,
            maxConcurrentJobsPerSession: inputRequest.maxConcurrentJobsPerSession,
          }),
        }),
      )
    },
  }
}

export * as CloudSDK from "./sdk"
