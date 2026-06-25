export type Operation =
  | {
      action: "put"
      tenantID: string
      secretRef: string
      secret: string
      metadata: Record<string, string>
    }
  | {
      action: "resolve"
      tenantID: string
      secretRef: string
    }
  | {
      action: "delete"
      tenantID: string
      secretRef: string
    }

export function put(input: {
  tenantID: string
  secretRef: string
  secret: string
  provider: string
  credentialID?: string
  scope?: string
  ownerKey?: string
}) {
  return {
    action: "put" as const,
    tenantID: input.tenantID,
    secretRef: input.secretRef,
    secret: input.secret,
    metadata: {
      "tenant-id": input.tenantID,
      provider: input.provider,
      ...(input.credentialID ? { "credential-id": input.credentialID } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.ownerKey ? { "owner-key": input.ownerKey } : {}),
    },
  }
}

export function resolve(input: { tenantID: string; secretRef: string }) {
  return {
    action: "resolve" as const,
    tenantID: input.tenantID,
    secretRef: input.secretRef,
  }
}

export function deleteSecret(input: { tenantID: string; secretRef: string }) {
  return {
    action: "delete" as const,
    tenantID: input.tenantID,
    secretRef: input.secretRef,
  }
}

export function rotate(input: {
  tenantID: string
  oldSecretRef: string
  newSecretRef: string
  secret: string
  provider: string
  credentialID: string
  scope?: string
  ownerKey?: string
}) {
  return [
    put({
      tenantID: input.tenantID,
      secretRef: input.newSecretRef,
      secret: input.secret,
      provider: input.provider,
      credentialID: input.credentialID,
      scope: input.scope,
      ownerKey: input.ownerKey,
    }),
    deleteSecret({ tenantID: input.tenantID, secretRef: input.oldSecretRef }),
  ]
}

export function redacted(input: Operation) {
  if (input.action !== "put") return input
  return {
    ...input,
    secret: "***",
  }
}

export * as CloudModelSecretAdapter from "./model-secret-adapter"
