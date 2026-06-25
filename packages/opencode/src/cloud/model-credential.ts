import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { optionalOmitUndefined, withStatics } from "@/util/schema"

const Time = Schema.Struct({
  created: Schema.Number,
  updated: Schema.Number,
})

const Scope = Schema.Literals(["platform", "integrator", "external_tenant", "external_user", "workspace", "session"])

export const Credential = Schema.Struct({
  id: Schema.String,
  scope: Scope,
  ownerKey: Schema.String,
  providerType: Schema.String,
  provider: Schema.String,
  baseURL: optionalOmitUndefined(Schema.String),
  secretRef: Schema.String,
  allowedModels: Schema.Array(Schema.String),
  defaultModel: Schema.String,
  enabled: Schema.Boolean,
  version: Schema.Number,
  lastUsedAt: optionalOmitUndefined(Schema.Number),
  time: Time,
})
  .annotate({ identifier: "CloudLLMCredential" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Credential = Schema.Schema.Type<typeof Credential>

const ModelRequest = Schema.Struct({
  credentialID: optionalOmitUndefined(Schema.String),
  provider: optionalOmitUndefined(Schema.String),
  model: optionalOmitUndefined(Schema.String),
})
export type ModelRequest = Schema.Schema.Type<typeof ModelRequest>

export const ModelConfigSnapshot = Schema.Struct({
  jobID: Schema.String,
  credentialID: Schema.String,
  credentialVersion: Schema.Number,
  providerType: Schema.String,
  provider: Schema.String,
  baseURL: optionalOmitUndefined(Schema.String),
  secretRef: Schema.String,
  model: Schema.String,
  time: Time,
})
  .annotate({ identifier: "CloudModelConfigSnapshot" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ModelConfigSnapshot = Schema.Schema.Type<typeof ModelConfigSnapshot>

export type Context = {
  integratorID?: string
  externalTenantID?: string
  externalUserID?: string
  workspaceID?: string
  sessionID?: string
}

export type Selection = Omit<ModelConfigSnapshot, "jobID" | "time">

function ownerKey(input: { scope: Credential["scope"]; context: Context }) {
  if (input.scope === "platform") return "platform"
  if (input.scope === "integrator") return input.context.integratorID
  if (input.scope === "external_tenant") {
    if (!input.context.integratorID || !input.context.externalTenantID) return undefined
    return `${input.context.integratorID}/${input.context.externalTenantID}`
  }
  if (input.scope === "external_user") {
    if (!input.context.integratorID || !input.context.externalTenantID || !input.context.externalUserID) return undefined
    return `${input.context.integratorID}/${input.context.externalTenantID}/${input.context.externalUserID}`
  }
  if (input.scope === "workspace") return input.context.workspaceID
  return input.context.sessionID
}

function allowed(input: { credential: Credential; context: Context }) {
  return input.credential.ownerKey === ownerKey({ scope: input.credential.scope, context: input.context })
}

function findCredential(input: {
  credentials: Credential[]
  credentialID?: string
  context: Context
}) {
  const found = input.credentials.find((credential) => credential.id === input.credentialID)
  if (!found) throw new Error(`credential_not_found: ${input.credentialID}`)
  if (!found.enabled) throw new Error(`credential_disabled: ${found.id}`)
  if (!allowed({ credential: found, context: input.context })) throw new Error(`credential_scope_denied: ${found.id}`)
  return found
}

function firstCredential(input: {
  credentials: Credential[]
  credentialIDs: (string | undefined)[]
  context: Context
}) {
  const index = input.credentialIDs.findIndex(Boolean)
  const credentialID = input.credentialIDs[index]
  if (credentialID) {
    return {
      credential: findCredential({ credentials: input.credentials, credentialID, context: input.context }),
      index,
    }
  }
  const scoped = input.credentials.find((credential) => credential.enabled && allowed({ credential, context: input.context }))
  if (!scoped) throw new Error("credential_not_found")
  return { credential: scoped, index: -1 }
}

export function select(input: {
  context: Context
  credentials: Credential[]
  request?: ModelRequest
  sessionDefault?: ModelRequest
  workspaceDefault?: ModelRequest
  userDefault?: ModelRequest
  tenantDefault?: ModelRequest
  platformDefault?: ModelRequest
}) {
  const selected = firstCredential({
    credentials: input.credentials,
    context: input.context,
    credentialIDs: [
      input.request?.credentialID,
      input.sessionDefault?.credentialID,
      input.workspaceDefault?.credentialID,
      input.userDefault?.credentialID,
      input.tenantDefault?.credentialID,
      input.platformDefault?.credentialID,
    ],
  })
  const requests = [
    input.request,
    input.sessionDefault,
    input.workspaceDefault,
    input.userDefault,
    input.tenantDefault,
    input.platformDefault,
  ]
  const model = requests.slice(0, selected.index < 0 ? requests.length : selected.index + 1).find((item) => item?.model)?.model ?? selected.credential.defaultModel
  const credential = selected.credential
  if (!credential.allowedModels.includes(model)) throw new Error(`model_not_allowed: ${credential.provider}/${model}`)
  return {
    credentialID: credential.id,
    credentialVersion: credential.version,
    providerType: credential.providerType,
    provider: input.request?.provider ?? input.sessionDefault?.provider ?? credential.provider,
    ...(credential.baseURL ? { baseURL: credential.baseURL } : {}),
    secretRef: credential.secretRef,
    model,
  } satisfies Selection
}

export function snapshot(input: { jobID: string; selection: Selection; now: number }) {
  return Schema.decodeUnknownSync(ModelConfigSnapshot)({
    jobID: input.jobID,
    ...input.selection,
    time: {
      created: input.now,
      updated: input.now,
    },
  })
}

export const decodeCredential = Schema.decodeUnknownSync(Credential)
export const decodeModelConfigSnapshot = Schema.decodeUnknownSync(ModelConfigSnapshot)

export * as CloudModelCredential from "./model-credential"
