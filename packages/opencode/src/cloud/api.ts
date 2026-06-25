import { Effect, Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { optionalOmitUndefined, withStatics } from "@/util/schema"
import { JobStatus } from "./runtime"

const ModelRef = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  credentialID: optionalOmitUndefined(Schema.String),
})

const RuntimeProfile = Schema.Literals(["small", "standard", "large", "gpu"])
const ExecutionMode = Schema.Literals(["shared_session_pool", "isolated_job_runtime", "local_dev"])
const RuntimeStatus = Schema.Literals(["healthy", "draining", "overloaded", "offline"])
const OutputKind = Schema.Literals(["csv", "xlsx", "png", "html", "md", "pdf", "json"])
const MessageRole = Schema.Literals(["user", "assistant", "tool", "system"])
const WebhookEvent = Schema.Literals([
  "*",
  "job.status",
  "job.message",
  "job.tool_call",
  "job.artifact",
  "job.error",
  "job.heartbeat",
])
const LLMCredentialScope = Schema.Literals(["platform", "integrator", "external_tenant", "external_user", "workspace", "session"])

export const CreateWorkspaceRequest = Schema.Struct({
  externalID: optionalOmitUndefined(Schema.String),
  name: optionalOmitUndefined(Schema.String),
})
  .annotate({ identifier: "CloudCreateWorkspaceRequest" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreateWorkspaceRequest = Schema.Schema.Type<typeof CreateWorkspaceRequest>

export const CreateSessionRequest = Schema.Struct({
  workspaceID: Schema.String,
  userID: Schema.String,
  title: optionalOmitUndefined(Schema.String),
  model: optionalOmitUndefined(ModelRef),
})
  .annotate({ identifier: "CloudCreateSessionRequest" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreateSessionRequest = Schema.Schema.Type<typeof CreateSessionRequest>

export const CreateSessionMessageRequest = Schema.Struct({
  role: Schema.optional(MessageRole).pipe(Schema.withDecodingDefault(Effect.succeed("user" as const))),
  content: Schema.String,
})
  .annotate({ identifier: "CloudCreateSessionMessageRequest" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreateSessionMessageRequest = Schema.Schema.Type<typeof CreateSessionMessageRequest>

const CreateFileRequestSchema = Schema.Struct({
  workspaceID: Schema.String,
  sessionID: optionalOmitUndefined(Schema.String),
  name: Schema.String,
  mime: optionalOmitUndefined(Schema.String),
  contentBase64: optionalOmitUndefined(Schema.String),
  sourceURL: optionalOmitUndefined(Schema.String),
})
  .annotate({ identifier: "CloudCreateFileRequest" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreateFileRequest = Schema.Schema.Type<typeof CreateFileRequestSchema>

const JobRuntime = Schema.Struct({
  profile: RuntimeProfile,
  version: optionalOmitUndefined(Schema.String),
})

const JobTools = Schema.Struct({
  webfetch: Schema.Struct({
    enabled: Schema.Boolean,
    allowDomains: Schema.Array(Schema.String),
  }),
  websearch: Schema.Struct({
    enabled: Schema.Boolean,
    provider: optionalOmitUndefined(Schema.String),
  }),
  mcp: Schema.Array(Schema.String),
  skills: Schema.Array(Schema.String),
})

const JobPermissions = Schema.Struct({
  filesystem: Schema.Literals(["workspace_only", "read_only"]),
  shell: Schema.Literals(["disabled", "restricted", "allow"]),
  network: Schema.Array(Schema.String),
})

export const CreateJobRequest = Schema.Struct({
  sessionID: Schema.String,
  prompt: Schema.String,
  inputs: Schema.Array(Schema.String),
  outputs: Schema.Array(OutputKind),
  runtime: JobRuntime,
  model: optionalOmitUndefined(ModelRef),
  tools: JobTools,
  permissions: optionalOmitUndefined(JobPermissions),
  integratorID: optionalOmitUndefined(Schema.String),
  externalTenantID: optionalOmitUndefined(Schema.String),
  externalUserID: optionalOmitUndefined(Schema.String),
  async: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})
  .annotate({ identifier: "CloudCreateJobRequest" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreateJobRequest = Schema.Schema.Type<typeof CreateJobRequest>

export const CreateWebhookRequest = Schema.Struct({
  url: Schema.String,
  events: Schema.Array(WebhookEvent),
  secret: Schema.String,
  enabled: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})
  .annotate({ identifier: "CloudCreateWebhookRequest" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreateWebhookRequest = Schema.Schema.Type<typeof CreateWebhookRequest>

export const UpdateWebhookRequest = Schema.Struct({
  enabled: Schema.Boolean,
})
  .annotate({ identifier: "CloudUpdateWebhookRequest" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type UpdateWebhookRequest = Schema.Schema.Type<typeof UpdateWebhookRequest>

export const CreateLLMCredentialRequest = Schema.Struct({
  scope: LLMCredentialScope,
  ownerKey: Schema.String,
  name: Schema.String,
  providerType: Schema.String,
  provider: Schema.String,
  baseURL: optionalOmitUndefined(Schema.String),
  apiKey: Schema.String,
  allowedModels: Schema.Array(Schema.String),
  defaultModel: Schema.String,
  enabled: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})
  .annotate({ identifier: "CloudCreateLLMCredentialRequest" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreateLLMCredentialRequest = Schema.Schema.Type<typeof CreateLLMCredentialRequest>

export const UpdateLLMCredentialRequest = Schema.Struct({
  name: optionalOmitUndefined(Schema.String),
  baseURL: optionalOmitUndefined(Schema.String),
  apiKey: optionalOmitUndefined(Schema.String),
  allowedModels: optionalOmitUndefined(Schema.Array(Schema.String)),
  defaultModel: optionalOmitUndefined(Schema.String),
  enabled: optionalOmitUndefined(Schema.Boolean),
})
  .annotate({ identifier: "CloudUpdateLLMCredentialRequest" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type UpdateLLMCredentialRequest = Schema.Schema.Type<typeof UpdateLLMCredentialRequest>

export const RuntimePolicyRequest = Schema.Struct({
  defaultExecutionMode: ExecutionMode,
  allowedExecutionModes: Schema.Array(ExecutionMode),
  maxActiveJobs: Schema.Number,
  maxSessions: Schema.Number,
  maxConcurrentJobsPerSession: Schema.Number,
})
  .annotate({ identifier: "CloudRuntimePolicyRequest" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type RuntimePolicyRequest = Schema.Schema.Type<typeof RuntimePolicyRequest>

export const JobEvent = Schema.Struct({
  id: Schema.String,
  jobID: Schema.String,
  type: Schema.Literals([
    "job.status",
    "job.message",
    "job.tool_call",
    "job.artifact",
    "job.error",
    "job.heartbeat",
  ]),
  data: Schema.Record(Schema.String, Schema.Unknown),
  time: Schema.Number,
})
  .annotate({ identifier: "CloudJobEvent" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type JobEvent = Schema.Schema.Type<typeof JobEvent>

export const JobEventPageResponse = Schema.Struct({
  items: Schema.Array(JobEvent),
  nextCursor: optionalOmitUndefined(Schema.String),
  hasMore: Schema.Boolean,
})
  .annotate({ identifier: "CloudJobEventPageResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type JobEventPageResponse = Schema.Schema.Type<typeof JobEventPageResponse>

export const JobResponse = Schema.Struct({
  id: Schema.String,
  status: JobStatus,
  sessionID: Schema.String,
  runtimeVersion: Schema.String,
})
  .annotate({ identifier: "CloudJobResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type JobResponse = Schema.Schema.Type<typeof JobResponse>

export const WorkspaceResponse = Schema.Struct({
  id: Schema.String,
  externalID: optionalOmitUndefined(Schema.String),
  name: optionalOmitUndefined(Schema.String),
  created: Schema.Number,
  updated: Schema.Number,
})
  .annotate({ identifier: "CloudWorkspaceResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type WorkspaceResponse = Schema.Schema.Type<typeof WorkspaceResponse>

export const FileResponse = Schema.Struct({
  id: Schema.String,
  workspaceID: Schema.String,
  sessionID: optionalOmitUndefined(Schema.String),
  name: Schema.String,
  mime: optionalOmitUndefined(Schema.String),
  size: Schema.Number,
  sha256: optionalOmitUndefined(Schema.String),
  created: Schema.Number,
})
  .annotate({ identifier: "CloudFileResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type FileResponse = Schema.Schema.Type<typeof FileResponse>

export const FilePageResponse = Schema.Struct({
  items: Schema.Array(FileResponse),
  nextCursor: optionalOmitUndefined(Schema.String),
  hasMore: Schema.Boolean,
})
  .annotate({ identifier: "CloudFilePageResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type FilePageResponse = Schema.Schema.Type<typeof FilePageResponse>

export const ArtifactDownloadResponse = Schema.Struct({
  artifactID: Schema.String,
  url: Schema.String,
  expiresAt: Schema.Number,
})
  .annotate({ identifier: "CloudArtifactDownloadResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ArtifactDownloadResponse = Schema.Schema.Type<typeof ArtifactDownloadResponse>

export const ErrorResponse = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
})
  .annotate({ identifier: "CloudErrorResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ErrorResponse = Schema.Schema.Type<typeof ErrorResponse>

export const SessionResponse = Schema.Struct({
  id: Schema.String,
  workspaceID: Schema.String,
  userID: Schema.String,
  title: Schema.String,
  summary: optionalOmitUndefined(Schema.String),
  created: Schema.Number,
  updated: Schema.Number,
})
  .annotate({ identifier: "CloudSessionResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SessionResponse = Schema.Schema.Type<typeof SessionResponse>

export const MessageResponse = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  jobID: optionalOmitUndefined(Schema.String),
  role: Schema.Literals(["user", "assistant", "tool", "system"]),
  content: Schema.String,
  created: Schema.Number,
})
  .annotate({ identifier: "CloudMessageResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type MessageResponse = Schema.Schema.Type<typeof MessageResponse>

export const ArtifactResponse = Schema.Struct({
  id: Schema.String,
  jobID: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  mime: optionalOmitUndefined(Schema.String),
  size: Schema.Number,
  sha256: optionalOmitUndefined(Schema.String),
  created: Schema.Number,
})
  .annotate({ identifier: "CloudArtifactResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ArtifactResponse = Schema.Schema.Type<typeof ArtifactResponse>

export const ArtifactPageResponse = Schema.Struct({
  items: Schema.Array(ArtifactResponse),
  nextCursor: optionalOmitUndefined(Schema.String),
  hasMore: Schema.Boolean,
})
  .annotate({ identifier: "CloudArtifactPageResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ArtifactPageResponse = Schema.Schema.Type<typeof ArtifactPageResponse>

export const WebhookResponse = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  events: Schema.Array(WebhookEvent),
  enabled: Schema.Boolean,
  created: Schema.Number,
})
  .annotate({ identifier: "CloudWebhookResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type WebhookResponse = Schema.Schema.Type<typeof WebhookResponse>

export const LLMCredentialResponse = Schema.Struct({
  id: Schema.String,
  scope: LLMCredentialScope,
  ownerKey: Schema.String,
  name: Schema.String,
  providerType: Schema.String,
  provider: Schema.String,
  baseURL: optionalOmitUndefined(Schema.String),
  allowedModels: Schema.Array(Schema.String),
  defaultModel: Schema.String,
  enabled: Schema.Boolean,
  version: Schema.Number,
  lastUsedAt: optionalOmitUndefined(Schema.Number),
  created: Schema.Number,
  updated: Schema.Number,
})
  .annotate({ identifier: "CloudLLMCredentialResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type LLMCredentialResponse = Schema.Schema.Type<typeof LLMCredentialResponse>

export const LLMCredentialTestResponse = Schema.Struct({
  ok: Schema.Boolean,
  credentialID: Schema.String,
  provider: Schema.String,
  model: Schema.String,
})
  .annotate({ identifier: "CloudLLMCredentialTestResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type LLMCredentialTestResponse = Schema.Schema.Type<typeof LLMCredentialTestResponse>

export const RuntimeWorkerResponse = Schema.Struct({
  id: Schema.String,
  executionMode: ExecutionMode,
  status: RuntimeStatus,
  version: Schema.String,
  profile: RuntimeProfile,
  maxActiveJobs: Schema.Number,
  maxSessions: Schema.Number,
  metrics: Schema.Struct({
    activeJobs: Schema.Number,
    busySessions: Schema.Number,
    idleSessions: Schema.Number,
    cpuPercent: Schema.Number,
    memoryPercent: Schema.Number,
    diskPercent: Schema.Number,
    recentErrorRate: Schema.Number,
    heartbeatDelayMS: Schema.Number,
    childProcesses: optionalOmitUndefined(Schema.Number),
    openFiles: optionalOmitUndefined(Schema.Number),
    oldestQueueAgeMS: optionalOmitUndefined(Schema.Number),
  }),
  capacity: Schema.Struct({
    healthy: Schema.Boolean,
    reasons: Schema.Array(Schema.String),
    boundSessions: Schema.Number,
    remainingJobs: Schema.Number,
    remainingSessions: Schema.Number,
    loadScore: Schema.Number,
  }),
  updated: Schema.Number,
})
  .annotate({ identifier: "CloudRuntimeWorkerResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type RuntimeWorkerResponse = Schema.Schema.Type<typeof RuntimeWorkerResponse>

export const RuntimePoolResponse = Schema.Struct({
  runtimes: Schema.Number,
  healthy: Schema.Number,
  draining: Schema.Number,
  overloaded: Schema.Number,
  offline: Schema.Number,
  activeJobs: Schema.Number,
  busySessions: Schema.Number,
  idleSessions: Schema.Number,
  plan: Schema.Struct({
    desiredRuntimes: Schema.Number,
    action: Schema.Literals(["scale_up", "scale_down", "hold"]),
    reason: Schema.Literals(["capacity_exhausted", "idle_capacity", "partial_pressure", "steady"]),
    availableJobSlots: Schema.Number,
    availableSessionSlots: Schema.Number,
    boundSessions: Schema.Number,
    saturatedRuntimes: Schema.Number,
    unavailableRuntimes: Schema.Number,
    drainRuntimeIDs: Schema.Array(Schema.String),
    releaseSessionIDs: Schema.Array(Schema.String),
  }),
})
  .annotate({ identifier: "CloudRuntimePoolResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type RuntimePoolResponse = Schema.Schema.Type<typeof RuntimePoolResponse>

export const RuntimePoolReconcileResponse = Schema.Struct({
  offlineRuntimeIDs: Schema.Array(Schema.String),
  releasedSessionIDs: Schema.Array(Schema.String),
})
  .annotate({ identifier: "CloudRuntimePoolReconcileResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type RuntimePoolReconcileResponse = Schema.Schema.Type<typeof RuntimePoolReconcileResponse>

export const RuntimePoolApplyPlanResponse = Schema.Struct({
  desiredRuntimes: Schema.Number,
  action: Schema.Literals(["scale_up", "scale_down", "hold"]),
  reason: Schema.Literals(["capacity_exhausted", "idle_capacity", "partial_pressure", "steady"]),
  drainedRuntimeIDs: Schema.Array(Schema.String),
  releasedSessionIDs: Schema.Array(Schema.String),
  scaleOperations: Schema.Array(
    Schema.Struct({
      action: Schema.String,
      target: Schema.String,
      desiredRuntimes: optionalOmitUndefined(Schema.Number),
      currentRuntimes: optionalOmitUndefined(Schema.Number),
      runtimeID: optionalOmitUndefined(Schema.String),
      sessionID: optionalOmitUndefined(Schema.String),
      namespace: optionalOmitUndefined(Schema.String),
      deploymentName: optionalOmitUndefined(Schema.String),
    }),
  ),
})
  .annotate({ identifier: "CloudRuntimePoolApplyPlanResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type RuntimePoolApplyPlanResponse = Schema.Schema.Type<typeof RuntimePoolApplyPlanResponse>

export const SessionRuntimeBindingResponse = Schema.Struct({
  sessionID: Schema.String,
  runtimeID: Schema.String,
  updated: Schema.Number,
})
  .annotate({ identifier: "CloudSessionRuntimeBindingResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SessionRuntimeBindingResponse = Schema.Schema.Type<typeof SessionRuntimeBindingResponse>

export const IntegratorRuntimePolicyResponse = Schema.Struct({
  tenantID: Schema.String,
  integratorID: Schema.String,
  defaultExecutionMode: ExecutionMode,
  allowedExecutionModes: Schema.Array(ExecutionMode),
  maxActiveJobs: Schema.Number,
  maxSessions: Schema.Number,
  maxConcurrentJobsPerSession: Schema.Number,
})
  .annotate({ identifier: "CloudIntegratorRuntimePolicyResponse" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type IntegratorRuntimePolicyResponse = Schema.Schema.Type<typeof IntegratorRuntimePolicyResponse>

export const decodeCreateWorkspaceRequest = Schema.decodeUnknownSync(CreateWorkspaceRequest)
export const decodeCreateSessionRequest = Schema.decodeUnknownSync(CreateSessionRequest)
export const decodeCreateSessionMessageRequest = Schema.decodeUnknownSync(CreateSessionMessageRequest)
const decodeFileRequest = Schema.decodeUnknownSync(CreateFileRequestSchema)
export const decodeCreateJobRequest = Schema.decodeUnknownSync(CreateJobRequest)
export const decodeCreateWebhookRequest = Schema.decodeUnknownSync(CreateWebhookRequest)
export const decodeUpdateWebhookRequest = Schema.decodeUnknownSync(UpdateWebhookRequest)
export const decodeCreateLLMCredentialRequest = Schema.decodeUnknownSync(CreateLLMCredentialRequest)
export const decodeUpdateLLMCredentialRequest = Schema.decodeUnknownSync(UpdateLLMCredentialRequest)
export const decodeRuntimePolicyRequest = Schema.decodeUnknownSync(RuntimePolicyRequest)
export const decodeJobEvent = Schema.decodeUnknownSync(JobEvent)
export const decodeJobEventPageResponse = Schema.decodeUnknownSync(JobEventPageResponse)
export const decodeJobResponse = Schema.decodeUnknownSync(JobResponse)
export const decodeWorkspaceResponse = Schema.decodeUnknownSync(WorkspaceResponse)
export const decodeFileResponse = Schema.decodeUnknownSync(FileResponse)
export const decodeFilePageResponse = Schema.decodeUnknownSync(FilePageResponse)
export const decodeArtifactDownloadResponse = Schema.decodeUnknownSync(ArtifactDownloadResponse)
export const decodeErrorResponse = Schema.decodeUnknownSync(ErrorResponse)
export const decodeSessionResponse = Schema.decodeUnknownSync(SessionResponse)
export const decodeMessageResponse = Schema.decodeUnknownSync(MessageResponse)
export const decodeArtifactResponse = Schema.decodeUnknownSync(ArtifactResponse)
export const decodeArtifactPageResponse = Schema.decodeUnknownSync(ArtifactPageResponse)
export const decodeWebhookResponse = Schema.decodeUnknownSync(WebhookResponse)
export const decodeLLMCredentialResponse = Schema.decodeUnknownSync(LLMCredentialResponse)
export const decodeLLMCredentialTestResponse = Schema.decodeUnknownSync(LLMCredentialTestResponse)
export const decodeRuntimeWorkerResponse = Schema.decodeUnknownSync(RuntimeWorkerResponse)
export const decodeRuntimePoolResponse = Schema.decodeUnknownSync(RuntimePoolResponse)
export const decodeRuntimePoolReconcileResponse = Schema.decodeUnknownSync(RuntimePoolReconcileResponse)
export const decodeRuntimePoolApplyPlanResponse = Schema.decodeUnknownSync(RuntimePoolApplyPlanResponse)
export const decodeSessionRuntimeBindingResponse = Schema.decodeUnknownSync(SessionRuntimeBindingResponse)
export const decodeIntegratorRuntimePolicyResponse = Schema.decodeUnknownSync(IntegratorRuntimePolicyResponse)

export function decodeCreateFileRequest(input: unknown) {
  const result = decodeFileRequest(input)
  const sources = [result.contentBase64, result.sourceURL].filter((item) => item !== undefined)
  if (sources.length !== 1) throw new Error("Cloud file upload expected exactly one content source")
  return result
}

export * as CloudAPI from "./api"
