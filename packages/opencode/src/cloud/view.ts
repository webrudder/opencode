import { CloudAPI, type JobEvent } from "./api"
import type { Artifact, File, Job, LLMCredential, Message, Session, WebhookSubscription, Workspace } from "./schema"

export function workspace(input: Workspace) {
  return CloudAPI.decodeWorkspaceResponse({
    id: input.id,
    ...(input.externalID ? { externalID: input.externalID } : {}),
    ...(input.name ? { name: input.name } : {}),
    created: input.time.created,
    updated: input.time.updated,
  })
}

export function file(input: File) {
  return CloudAPI.decodeFileResponse({
    id: input.id,
    workspaceID: input.workspaceID,
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
    name: input.name,
    ...(input.mime ? { mime: input.mime } : {}),
    size: input.size,
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    created: input.time.created,
  })
}

export function job(input: Job) {
  return CloudAPI.decodeJobResponse({
    id: input.id,
    status: input.status,
    sessionID: input.sessionID,
    runtimeVersion: input.runtime.version,
  })
}

export function artifact(input: Artifact) {
  return CloudAPI.decodeArtifactResponse({
    id: input.id,
    jobID: input.jobID,
    name: input.name,
    kind: input.kind,
    ...(input.mime ? { mime: input.mime } : {}),
    size: input.size,
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    created: input.time.created,
  })
}

export function session(input: Session) {
  return CloudAPI.decodeSessionResponse({
    id: input.id,
    workspaceID: input.workspaceID,
    userID: input.userID,
    title: input.title,
    ...(input.summary ? { summary: input.summary } : {}),
    created: input.time.created,
    updated: input.time.updated,
  })
}

export function message(input: Message) {
  return CloudAPI.decodeMessageResponse({
    id: input.id,
    sessionID: input.sessionID,
    ...(input.jobID ? { jobID: input.jobID } : {}),
    role: input.role,
    content: input.content,
    created: input.time.created,
  })
}

export function event(input: JobEvent) {
  return CloudAPI.decodeJobEvent(input)
}

export function webhook(input: WebhookSubscription) {
  return CloudAPI.decodeWebhookResponse({
    id: input.id,
    url: input.url,
    events: input.events,
    enabled: input.enabled,
    created: input.time.created,
  })
}

export function llmCredential(input: LLMCredential) {
  return CloudAPI.decodeLLMCredentialResponse({
    id: input.id,
    scope: input.scope,
    ownerKey: input.ownerKey,
    name: input.name,
    providerType: input.providerType,
    provider: input.provider,
    ...(input.baseURL ? { baseURL: input.baseURL } : {}),
    allowedModels: input.allowedModels,
    defaultModel: input.defaultModel,
    enabled: input.enabled,
    version: input.version,
    ...(input.lastUsedAt ? { lastUsedAt: input.lastUsedAt } : {}),
    created: input.time.created,
    updated: input.time.updated,
  })
}

export * as CloudView from "./view"
