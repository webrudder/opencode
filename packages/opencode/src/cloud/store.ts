import type { JobEvent } from "./api"
import { CloudAccess } from "./access"
import { CloudAudit } from "./audit"
import { CloudEvent } from "./event"
import type { Lease } from "./lease"
import { CloudSchema, type Artifact, type AuditEvent, type Job, type LLMCredential, type Message, type Session, type WebhookSubscription, type Workspace } from "./schema"
import type { File } from "./schema"
import type { CloudAttempt } from "./attempt"
import type { RuntimeWorker, SessionBinding } from "./runtime-pool"
import type { JobSpec, JobStatus } from "./runtime"
import type { Cost } from "./usage"

type JobPrompt = {
  id: string
  tenantID: string
  jobID: string
  prompt: string
}

type State = {
  workspaces: Map<string, Workspace>
  sessions: Map<string, Session>
  files: Map<string, File>
  jobs: Map<string, Job>
  jobSpecs: Map<string, JobSpec>
  jobPrompts: Map<string, JobPrompt>
  attempts: Map<string, ReturnType<typeof CloudAttempt.start>>
  messages: Map<string, Message>
  artifacts: Map<string, Artifact>
  events: JobEvent[]
  eventCheckpoints: Map<string, ReturnType<typeof CloudEvent.checkpoint>>
  leases: Map<string, Lease>
  auditEvents: AuditEvent[]
  webhooks: Map<string, WebhookSubscription>
  llmCredentials: Map<string, LLMCredential>
  runtimeWorkers: Map<string, RuntimeWorker>
  sessionRuntimeBindings: Map<string, SessionBinding>
}

function scopedGet<T extends { id: string; tenantID: string }>(input: {
  records: Map<string, T>
  tenantID: string
  id: string
}) {
  const record = input.records.get(input.id)
  if (!record) return undefined
  return CloudAccess.filterTenant({ tenantID: input.tenantID, resources: [record] })[0]
}

export function create(input?: Partial<State>) {
  const state = {
    workspaces: input?.workspaces ?? new Map<string, Workspace>(),
    sessions: input?.sessions ?? new Map<string, Session>(),
    files: input?.files ?? new Map<string, File>(),
    jobs: input?.jobs ?? new Map<string, Job>(),
    jobSpecs: input?.jobSpecs ?? new Map<string, JobSpec>(),
    jobPrompts: input?.jobPrompts ?? new Map<string, JobPrompt>(),
    attempts: input?.attempts ?? new Map<string, ReturnType<typeof CloudAttempt.start>>(),
    messages: input?.messages ?? new Map<string, Message>(),
    artifacts: input?.artifacts ?? new Map<string, Artifact>(),
    events: input?.events ?? [],
    eventCheckpoints: input?.eventCheckpoints ?? new Map<string, ReturnType<typeof CloudEvent.checkpoint>>(),
    leases: input?.leases ?? new Map<string, Lease>(),
    auditEvents: input?.auditEvents ?? [],
    webhooks: input?.webhooks ?? new Map<string, WebhookSubscription>(),
    llmCredentials: input?.llmCredentials ?? new Map<string, LLMCredential>(),
    runtimeWorkers: input?.runtimeWorkers ?? new Map<string, RuntimeWorker>(),
    sessionRuntimeBindings: input?.sessionRuntimeBindings ?? new Map<string, SessionBinding>(),
  }

  return {
    putWorkspace(workspace: Workspace) {
      state.workspaces.set(workspace.id, workspace)
      return workspace
    },
    getWorkspace(input: { tenantID: string; id: string }) {
      return scopedGet({ records: state.workspaces, ...input })
    },
    listWorkspaces(input: { tenantID: string }) {
      return CloudAccess.filterTenant({ tenantID: input.tenantID, resources: Array.from(state.workspaces.values()) })
    },
    putSession(session: Session) {
      state.sessions.set(session.id, session)
      return session
    },
    getSession(input: { tenantID: string; id: string }) {
      return scopedGet({ records: state.sessions, ...input })
    },
    putJob(job: Job) {
      state.jobs.set(job.id, job)
      return job
    },
    getJob(input: { tenantID: string; id: string }) {
      return scopedGet({ records: state.jobs, ...input })
    },
    putJobSpec(spec: JobSpec) {
      state.jobSpecs.set(spec.id, spec)
      return spec
    },
    getJobSpec(input: { tenantID: string; id: string }) {
      return scopedGet({ records: state.jobSpecs, ...input })
    },
    putJobPrompt(prompt: JobPrompt) {
      state.jobPrompts.set(prompt.id, prompt)
      return prompt
    },
    getJobPrompt(input: { tenantID: string; jobID: string }) {
      const prompt = state.jobPrompts.get(input.jobID)
      if (!prompt) return undefined
      return CloudAccess.filterTenant({ tenantID: input.tenantID, resources: [prompt] })[0]
    },
    listJobs(input: { tenantID: string }) {
      return CloudAccess.filterTenant({ tenantID: input.tenantID, resources: Array.from(state.jobs.values()) })
    },
    putAttempt(attempt: ReturnType<typeof CloudAttempt.start>) {
      state.attempts.set(attempt.id, attempt)
      return attempt
    },
    listAttempts(input: { tenantID: string; jobID?: string }) {
      return CloudAccess.filterTenant({
        tenantID: input.tenantID,
        resources: Array.from(state.attempts.values()),
      }).filter((attempt) => !input.jobID || attempt.jobID === input.jobID)
    },
    putMessage(message: Message) {
      state.messages.set(message.id, message)
      return message
    },
    listMessages(input: { tenantID: string; sessionID?: string }) {
      return CloudAccess.filterTenant({
        tenantID: input.tenantID,
        resources: Array.from(state.messages.values()),
      }).filter((message) => !input.sessionID || message.sessionID === input.sessionID)
    },
    putFile(file: File) {
      state.files.set(file.id, file)
      return file
    },
    getFile(input: { tenantID: string; id: string }) {
      return scopedGet({ records: state.files, ...input })
    },
    listFiles(input: { tenantID: string; workspaceID?: string; sessionID?: string; cursor?: string; limit?: number }) {
      return CloudAccess.filterTenant({
        tenantID: input.tenantID,
        resources: Array.from(state.files.values()),
      })
        .toSorted((a, b) => a.id.localeCompare(b.id))
        .filter(
          (file) =>
            (!input.workspaceID || file.workspaceID === input.workspaceID) &&
            (!input.sessionID || file.sessionID === input.sessionID) &&
            (!input.cursor || file.id > input.cursor),
        )
        .slice(0, input.limit)
    },
    updateJobStatus(input: { tenantID: string; id: string; status: JobStatus; now: number }) {
      const job = scopedGet({ records: state.jobs, tenantID: input.tenantID, id: input.id })
      if (!job) throw new Error("Cloud job not found")
      const updated = {
        ...job,
        status: CloudSchema.transitionJobStatus(job.status, input.status),
        time: {
          ...job.time,
          updated: input.now,
        },
      }
      state.jobs.set(updated.id, updated)
      return updated
    },
    updateJobCost(input: { tenantID: string; id: string; cost: Cost; now: number }) {
      const job = scopedGet({ records: state.jobs, tenantID: input.tenantID, id: input.id })
      if (!job) throw new Error("Cloud job not found")
      const updated = {
        ...job,
        cost: input.cost,
        time: {
          ...job.time,
          updated: input.now,
        },
      }
      state.jobs.set(updated.id, updated)
      return updated
    },
    appendEvent(event: JobEvent) {
      state.events.push(event)
      return event
    },
    listEvents(input: { jobID: string; cursor?: string; limit?: number }) {
      return CloudEvent.stream({
        events: state.events.filter((event) => event.jobID === input.jobID),
        jobID: input.jobID,
        cursor: input.cursor,
        limit: input.limit,
      })
    },
    putEventCheckpoint(checkpoint: ReturnType<typeof CloudEvent.checkpoint>) {
      state.eventCheckpoints.set(`${checkpoint.tenantID}:${checkpoint.consumer}:${checkpoint.jobID}`, checkpoint)
      return checkpoint
    },
    getEventCheckpoint(input: { tenantID: string; consumer: string; jobID: string }) {
      return state.eventCheckpoints.get(`${input.tenantID}:${input.consumer}:${input.jobID}`)
    },
    putLease(lease: Lease) {
      state.leases.set(lease.jobID, lease)
      return lease
    },
    getLease(input: { jobID: string }) {
      return state.leases.get(input.jobID)
    },
    putArtifact(artifact: Artifact) {
      state.artifacts.set(artifact.id, artifact)
      return artifact
    },
    getArtifact(input: { tenantID: string; id: string }) {
      return scopedGet({ records: state.artifacts, ...input })
    },
    listArtifacts(input: { tenantID: string; jobID?: string; cursor?: string; limit?: number }) {
      return CloudAccess.filterTenant({
        tenantID: input.tenantID,
        resources: Array.from(state.artifacts.values()),
      })
        .toSorted((a, b) => a.id.localeCompare(b.id))
        .filter((artifact) => (!input.jobID || artifact.jobID === input.jobID) && (!input.cursor || artifact.id > input.cursor))
        .slice(0, input.limit)
    },
    putAuditEvent(event: AuditEvent) {
      state.auditEvents.push(event)
      return event
    },
    listAuditEvents(input: {
      tenantID: string
      userID?: string
      resourceType?: string
      resourceID?: string
      action?: string
    }) {
      return CloudAudit.filter({
        events: CloudAccess.filterTenant({ tenantID: input.tenantID, resources: state.auditEvents }),
        userID: input.userID,
        resourceType: input.resourceType,
        resourceID: input.resourceID,
        action: input.action,
      })
    },
    putWebhook(webhook: WebhookSubscription) {
      state.webhooks.set(webhook.id, webhook)
      return webhook
    },
    listWebhooks(input: { tenantID: string }) {
      return CloudAccess.filterTenant({ tenantID: input.tenantID, resources: Array.from(state.webhooks.values()) })
    },
    updateWebhook(input: { tenantID: string; id: string; enabled: boolean; now: number }) {
      const webhook = scopedGet({ records: state.webhooks, tenantID: input.tenantID, id: input.id })
      if (!webhook) throw new Error("Cloud webhook not found")
      const updated = {
        ...webhook,
        enabled: input.enabled,
        time: {
          ...webhook.time,
          updated: input.now,
        },
      }
      state.webhooks.set(updated.id, updated)
      return updated
    },
    deleteWebhook(input: { tenantID: string; id: string }) {
      const webhook = scopedGet({ records: state.webhooks, tenantID: input.tenantID, id: input.id })
      if (!webhook) throw new Error("Cloud webhook not found")
      state.webhooks.delete(webhook.id)
      return webhook
    },
    putLLMCredential(credential: LLMCredential) {
      state.llmCredentials.set(credential.id, credential)
      return credential
    },
    getLLMCredential(input: { tenantID: string; id: string }) {
      return scopedGet({ records: state.llmCredentials, ...input })
    },
    listLLMCredentials(input: { tenantID: string }) {
      return CloudAccess.filterTenant({ tenantID: input.tenantID, resources: Array.from(state.llmCredentials.values()) })
    },
    updateLLMCredential(input: {
      tenantID: string
      id: string
      name?: string
      baseURL?: string
      secretRef?: string
      allowedModels?: string[]
      defaultModel?: string
      enabled?: boolean
      now: number
    }) {
      const credential = scopedGet({ records: state.llmCredentials, tenantID: input.tenantID, id: input.id })
      if (!credential) throw new Error("Cloud LLM credential not found")
      const updated = CloudSchema.decodeLLMCredential({
        ...credential,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseURL !== undefined ? { baseURL: input.baseURL } : {}),
        ...(input.secretRef !== undefined ? { secretRef: input.secretRef } : {}),
        ...(input.allowedModels !== undefined ? { allowedModels: input.allowedModels } : {}),
        ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        version: credential.version + 1,
        time: {
          ...credential.time,
          updated: input.now,
        },
      })
      state.llmCredentials.set(updated.id, updated)
      return updated
    },
    deleteLLMCredential(input: { tenantID: string; id: string }) {
      const credential = scopedGet({ records: state.llmCredentials, tenantID: input.tenantID, id: input.id })
      if (!credential) throw new Error("Cloud LLM credential not found")
      state.llmCredentials.delete(credential.id)
      return credential
    },
    putRuntimeWorker(runtime: RuntimeWorker) {
      state.runtimeWorkers.set(runtime.id, runtime)
      return runtime
    },
    getRuntimeWorker(input: { tenantID: string; id: string }) {
      return scopedGet({ records: state.runtimeWorkers, ...input })
    },
    listRuntimeWorkers(input: { tenantID: string }) {
      return CloudAccess.filterTenant({ tenantID: input.tenantID, resources: Array.from(state.runtimeWorkers.values()) })
    },
    putSessionRuntimeBinding(binding: SessionBinding) {
      state.sessionRuntimeBindings.set(`${binding.tenantID}:${binding.sessionID}`, binding)
      return binding
    },
    getSessionRuntimeBinding(input: { tenantID: string; sessionID: string }) {
      return state.sessionRuntimeBindings.get(`${input.tenantID}:${input.sessionID}`)
    },
    listSessionRuntimeBindings(input: { tenantID: string }) {
      return Array.from(state.sessionRuntimeBindings.values()).filter((binding) => binding.tenantID === input.tenantID)
    },
    deleteSessionRuntimeBinding(input: { tenantID: string; sessionID: string }) {
      const binding = state.sessionRuntimeBindings.get(`${input.tenantID}:${input.sessionID}`)
      if (!binding) throw new Error("Cloud session runtime binding not found")
      state.sessionRuntimeBindings.delete(`${input.tenantID}:${input.sessionID}`)
      return binding
    },
  }
}

export * as CloudStore from "./store"
