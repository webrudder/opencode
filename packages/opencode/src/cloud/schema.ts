import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { JobStatus } from "./runtime"

const Time = Schema.Struct({
  created: Schema.Number,
  updated: Schema.Number,
})

const Budget = Schema.Struct({
  dailyUSD: Schema.optional(Schema.Number),
  monthlyUSD: Schema.optional(Schema.Number),
})

const ModelRef = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  credentialID: Schema.optional(Schema.String),
})

const TokenUsage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
})

const Cost = Schema.Struct({
  estimatedUSD: Schema.Number,
  tokens: TokenUsage,
})

const RuntimeRef = Schema.Struct({
  engine: Schema.Literal("opencode"),
  version: Schema.String,
  image: Schema.optional(Schema.String),
  imageDigest: Schema.optional(Schema.String),
  profile: Schema.Literals(["small", "standard", "large", "gpu"]),
})

export const Tenant = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  defaultRuntimeVersion: Schema.String,
  allowedModels: Schema.Array(Schema.String),
  budget: Budget,
  time: Time,
})
  .annotate({ identifier: "CloudTenant" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Tenant = Schema.Schema.Type<typeof Tenant>

export const User = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  externalID: Schema.String,
  email: Schema.optional(Schema.String),
  time: Time,
})
  .annotate({ identifier: "CloudUser" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type User = Schema.Schema.Type<typeof User>

export const Workspace = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  externalID: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  time: Time,
})
  .annotate({ identifier: "CloudWorkspace" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Workspace = Schema.Schema.Type<typeof Workspace>

export const Session = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  workspaceID: Schema.String,
  userID: Schema.String,
  title: Schema.String,
  model: Schema.optional(ModelRef),
  summary: Schema.optional(Schema.String),
  time: Time,
})
  .annotate({ identifier: "CloudSession" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Session = Schema.Schema.Type<typeof Session>

export const File = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  workspaceID: Schema.String,
  sessionID: Schema.optional(Schema.String),
  name: Schema.String,
  mime: Schema.optional(Schema.String),
  size: Schema.Number,
  objectKey: Schema.String,
  sha256: Schema.optional(Schema.String),
  time: Time,
})
  .annotate({ identifier: "CloudFile" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type File = Schema.Schema.Type<typeof File>

export const Artifact = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  workspaceID: Schema.String,
  sessionID: Schema.String,
  jobID: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  mime: Schema.optional(Schema.String),
  size: Schema.Number,
  objectKey: Schema.String,
  sha256: Schema.optional(Schema.String),
  time: Time,
})
  .annotate({ identifier: "CloudArtifact" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Artifact = Schema.Schema.Type<typeof Artifact>

export const Message = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  workspaceID: Schema.String,
  sessionID: Schema.String,
  jobID: Schema.optional(Schema.String),
  role: Schema.Literals(["user", "assistant", "tool", "system"]),
  content: Schema.String,
  time: Time,
})
  .annotate({ identifier: "CloudMessage" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Message = Schema.Schema.Type<typeof Message>

export const RuntimeInstance = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  workspaceID: Schema.String,
  sessionID: Schema.String,
  jobID: Schema.String,
  engine: Schema.Literal("opencode"),
  version: Schema.String,
  image: Schema.optional(Schema.String),
  imageDigest: Schema.optional(Schema.String),
  sandboxID: Schema.optional(Schema.String),
  time: Time,
})
  .annotate({ identifier: "CloudRuntimeInstance" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type RuntimeInstance = Schema.Schema.Type<typeof RuntimeInstance>

export const ToolCall = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  workspaceID: Schema.String,
  sessionID: Schema.String,
  jobID: Schema.String,
  tool: Schema.String,
  status: Schema.Literals(["pending", "running", "succeeded", "failed", "denied"]),
  durationMS: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  estimatedCostUSD: Schema.optional(Schema.Number),
  time: Time,
})
  .annotate({ identifier: "CloudToolCall" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolCall = Schema.Schema.Type<typeof ToolCall>

export const AuditEvent = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  userID: Schema.optional(Schema.String),
  resourceType: Schema.String,
  resourceID: Schema.String,
  action: Schema.String,
  time: Time,
})
  .annotate({ identifier: "CloudAuditEvent" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AuditEvent = Schema.Schema.Type<typeof AuditEvent>

export const WebhookSubscription = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  url: Schema.String,
  secretRef: Schema.String,
  events: Schema.Array(Schema.Literals([
    "*",
    "job.status",
    "job.message",
    "job.tool_call",
    "job.artifact",
    "job.error",
    "job.heartbeat",
  ])),
  enabled: Schema.Boolean,
  time: Time,
})
  .annotate({ identifier: "CloudWebhookSubscription" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type WebhookSubscription = Schema.Schema.Type<typeof WebhookSubscription>

export const LLMCredential = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  scope: Schema.Literals(["platform", "integrator", "external_tenant", "external_user", "workspace", "session"]),
  ownerKey: Schema.String,
  name: Schema.String,
  providerType: Schema.String,
  provider: Schema.String,
  baseURL: Schema.optional(Schema.String),
  secretRef: Schema.String,
  allowedModels: Schema.Array(Schema.String),
  defaultModel: Schema.String,
  enabled: Schema.Boolean,
  version: Schema.Number,
  lastUsedAt: Schema.optional(Schema.Number),
  time: Time,
})
  .annotate({ identifier: "CloudLLMCredentialRecord" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type LLMCredential = Schema.Schema.Type<typeof LLMCredential>

export const Job = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  workspaceID: Schema.String,
  sessionID: Schema.String,
  status: JobStatus,
  executionMode: Schema.optional(Schema.Literals(["shared_session_pool", "isolated_job_runtime", "local_dev"])),
  runtime: RuntimeRef,
  modelConfigSnapshot: Schema.optional(Schema.Unknown),
  cost: Cost,
  error: Schema.optional(Schema.String),
  time: Time,
})
  .annotate({ identifier: "CloudJob" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Job = Schema.Schema.Type<typeof Job>

const transitions: Record<JobStatus, JobStatus[]> = {
  queued: ["leasing", "failed", "canceled", "expired"],
  leasing: ["starting", "failed", "canceled", "expired"],
  starting: ["running", "failed", "canceled", "expired"],
  running: ["uploading", "failed", "canceled", "expired"],
  uploading: ["succeeded", "failed", "canceled", "expired"],
  succeeded: [],
  failed: [],
  canceled: [],
  expired: [],
}

export function transitionJobStatus(current: JobStatus, next: JobStatus) {
  if (transitions[current].includes(next)) return next
  throw new Error(`Invalid cloud job transition: ${current} -> ${next}`)
}

export const decodeTenant = Schema.decodeUnknownSync(Tenant)
export const decodeUser = Schema.decodeUnknownSync(User)
export const decodeWorkspace = Schema.decodeUnknownSync(Workspace)
export const decodeSession = Schema.decodeUnknownSync(Session)
export const decodeFile = Schema.decodeUnknownSync(File)
export const decodeArtifact = Schema.decodeUnknownSync(Artifact)
export const decodeMessage = Schema.decodeUnknownSync(Message)
export const decodeRuntimeInstance = Schema.decodeUnknownSync(RuntimeInstance)
export const decodeToolCall = Schema.decodeUnknownSync(ToolCall)
export const decodeAuditEvent = Schema.decodeUnknownSync(AuditEvent)
export const decodeWebhookSubscription = Schema.decodeUnknownSync(WebhookSubscription)
export const decodeLLMCredential = Schema.decodeUnknownSync(LLMCredential)
export const decodeJob = Schema.decodeUnknownSync(Job)

export * as CloudSchema from "./schema"
