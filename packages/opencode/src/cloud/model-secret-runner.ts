import type { CloudModelSecretAdapter } from "./model-secret-adapter"

export type Client = {
  putSecret?: (input: { tenantID: string; secretRef: string; secret: string; metadata: Record<string, string> }) => void | Promise<void>
  getSecret?: (input: { tenantID: string; secretRef: string }) => string | undefined | Promise<string | undefined>
  deleteSecret?: (input: { tenantID: string; secretRef: string }) => void | Promise<void>
}

type Result = {
  action: CloudModelSecretAdapter.Operation["action"]
  tenantID: string
  secretRef: string
  status: "succeeded" | "failed"
  secretAvailable?: boolean
  error?: string
}

function missing(action: string) {
  return new Error(`Cloud model secret client missing ${action}`)
}

async function runOne(input: {
  client: Client
  operation: CloudModelSecretAdapter.Operation
}): Promise<Result> {
  try {
    if (input.operation.action === "put") {
      if (!input.client.putSecret) throw missing("putSecret")
      await input.client.putSecret(input.operation)
      return {
        action: input.operation.action,
        tenantID: input.operation.tenantID,
        secretRef: input.operation.secretRef,
        status: "succeeded",
      }
    }
    if (input.operation.action === "resolve") {
      if (!input.client.getSecret) throw missing("getSecret")
      return {
        action: input.operation.action,
        tenantID: input.operation.tenantID,
        secretRef: input.operation.secretRef,
        status: "succeeded",
        secretAvailable: (await input.client.getSecret(input.operation)) !== undefined,
      }
    }
    if (!input.client.deleteSecret) throw missing("deleteSecret")
    await input.client.deleteSecret(input.operation)
    return {
      action: input.operation.action,
      tenantID: input.operation.tenantID,
      secretRef: input.operation.secretRef,
      status: "succeeded",
    }
  } catch (error) {
    return {
      action: input.operation.action,
      tenantID: input.operation.tenantID,
      secretRef: input.operation.secretRef,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function run(input: {
  client: Client
  operations: CloudModelSecretAdapter.Operation[]
}) {
  return Promise.all(input.operations.map((operation) => runOne({ client: input.client, operation })))
}

export function store(input: { client: Required<Client> }) {
  return {
    put(request: { tenantID: string; secretRef: string; secret: string; now: number }) {
      input.client.putSecret({ ...request, metadata: { "tenant-id": request.tenantID } })
      return {
        tenantID: request.tenantID,
        secretRef: request.secretRef,
        secret: request.secret,
        time: {
          created: request.now,
          updated: request.now,
        },
      }
    },
    resolve(request: { tenantID: string; secretRef: string }) {
      return input.client.getSecret(request)
    },
    delete(request: { tenantID: string; secretRef: string }) {
      const secret = input.client.getSecret(request)
      input.client.deleteSecret(request)
      if (secret === undefined) return undefined
      return {
        tenantID: request.tenantID,
        secretRef: request.secretRef,
        secret,
        time: {
          created: 0,
          updated: 0,
        },
      }
    },
  }
}

export * as CloudModelSecretRunner from "./model-secret-runner"
