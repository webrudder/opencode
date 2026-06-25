type Operation = {
  action: string
  [key: string]: unknown
}

type Provider = "database" | "queue" | "object_storage" | "kubernetes" | "secret"

type Result = {
  id: string
  provider: Provider
  action: string
  status: "succeeded" | "failed" | "skipped"
  retryable: boolean
  durationMS: number
  error?: string
}

function stable(input: unknown) {
  return JSON.stringify(input, Object.keys(input as Record<string, unknown>).sort())
}

export function idempotencyKey(input: {
  provider: Result["provider"]
  operation: Operation
}) {
  const key =
    input.operation.jobID ??
    input.operation.objectKey ??
    input.operation.name ??
    input.operation.table ??
    input.operation.queue ??
    input.operation.secretRef ??
    "operation"
  return `${input.provider}:${input.operation.action}:${String(key)}:${stable(input.operation).length}`
}

export function task(input: {
  provider: Result["provider"]
  operation: Operation
  dependsOn?: string[]
}) {
  return {
    id: idempotencyKey(input),
    provider: input.provider,
    operation: input.operation,
    dependsOn: input.dependsOn ?? [],
  }
}

export function plan(input: {
  database?: Operation[]
  queue?: Operation[]
  objectStorage?: Operation[]
  kubernetes?: Operation[]
  secret?: Operation[]
}) {
  return [
    ...(input.database ?? []).map((operation) => task({ provider: "database", operation })),
    ...(input.queue ?? []).map((operation) => task({ provider: "queue", operation })),
    ...(input.objectStorage ?? []).map((operation) => task({ provider: "object_storage", operation })),
    ...(input.kubernetes ?? []).map((operation) => task({ provider: "kubernetes", operation })),
    ...(input.secret ?? []).map((operation) => task({ provider: "secret", operation })),
  ]
}

export function result(input: {
  provider: Result["provider"]
  operation: Operation
  status: Result["status"]
  durationMS: number
  error?: string
  retryable?: boolean
}): Result {
  return {
    id: idempotencyKey(input),
    provider: input.provider,
    action: input.operation.action,
    status: input.status,
    retryable: input.retryable ?? input.status === "failed",
    durationMS: input.durationMS,
    ...(input.error ? { error: input.error } : {}),
  }
}

export function summarize(input: { results: Result[] }) {
  const failed = input.results.filter((item) => item.status === "failed")
  return {
    total: input.results.length,
    succeeded: input.results.filter((item) => item.status === "succeeded").length,
    failed: failed.length,
    skipped: input.results.filter((item) => item.status === "skipped").length,
    retryable: failed.filter((item) => item.retryable).length,
    terminal: failed.filter((item) => !item.retryable).length,
    durationMS: input.results.reduce((total, item) => total + item.durationMS, 0),
  }
}

export function retryPlan(input: { results: Result[] }) {
  return input.results
    .filter((item) => item.status === "failed" && item.retryable)
    .map((item) => ({
      id: item.id,
      provider: item.provider,
      action: item.action,
      reason: item.error ?? "retryable operation failed",
    }))
}

export * as CloudOperationRunner from "./operation-runner"
