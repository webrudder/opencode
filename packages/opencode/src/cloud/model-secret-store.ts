type SecretRecord = {
  tenantID: string
  secretRef: string
  secret: string
  time: {
    created: number
    updated: number
  }
}

export type Store = {
  put: (input: { tenantID: string; secretRef: string; secret: string; now: number }) => SecretRecord
  resolve: (input: { tenantID: string; secretRef: string }) => string | undefined
  delete: (input: { tenantID: string; secretRef: string }) => SecretRecord | undefined
}

function key(input: { tenantID: string; secretRef: string }) {
  return `${input.tenantID}:${input.secretRef}`
}

export function memory(input?: { secrets?: Map<string, SecretRecord> }): Store {
  const secrets = input?.secrets ?? new Map<string, SecretRecord>()
  return {
    put(request) {
      const found = secrets.get(key(request))
      const result = {
        tenantID: request.tenantID,
        secretRef: request.secretRef,
        secret: request.secret,
        time: {
          created: found?.time.created ?? request.now,
          updated: request.now,
        },
      }
      secrets.set(key(result), result)
      return result
    },
    resolve(request) {
      return secrets.get(key(request))?.secret
    },
    delete(request) {
      const found = secrets.get(key(request))
      secrets.delete(key(request))
      return found
    },
  }
}

export function resolver(input: { store: Store; tenantID: string }) {
  return (secretRef: string) => input.store.resolve({ tenantID: input.tenantID, secretRef })
}

export * as CloudModelSecretStore from "./model-secret-store"
