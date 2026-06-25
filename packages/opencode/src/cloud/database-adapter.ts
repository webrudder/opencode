import type { CloudRepository } from "./repository"

type ConflictMode = "error" | "ignore" | "replace"

export type Operation =
  | {
      action: "begin"
      isolation: "deferred" | "immediate" | "exclusive"
    }
  | {
      action: "write"
      table: string
      mutation: CloudRepository.Mutation["action"]
      key: Record<string, string | number>
      values: Record<string, unknown>
      conflict: ConflictMode
    }
  | {
      action: "commit"
    }
  | {
      action: "rollback"
      reason: string
    }

function values(input: CloudRepository.Mutation) {
  if (input.action === "delete") return {}
  return input.values ?? {}
}

export function write(input: {
  mutation: CloudRepository.Mutation
  conflict?: ConflictMode
}): Operation {
  return {
    action: "write",
    table: input.mutation.table,
    mutation: input.mutation.action,
    key: input.mutation.key,
    values: values(input.mutation),
    conflict: input.conflict ?? "error",
  }
}

export function transaction(input: {
  mutations: CloudRepository.Mutation[]
  isolation?: "deferred" | "immediate" | "exclusive"
  conflict?: ConflictMode
}) {
  return [
    { action: "begin" as const, isolation: input.isolation ?? "immediate" },
    ...input.mutations.map((mutation) => write({ mutation, conflict: input.conflict })),
    { action: "commit" as const },
  ]
}

export function failed(input: {
  mutations: CloudRepository.Mutation[]
  reason: string
  isolation?: "deferred" | "immediate" | "exclusive"
}) {
  return [
    { action: "begin" as const, isolation: input.isolation ?? "immediate" },
    ...input.mutations.map((mutation) => write({ mutation })),
    { action: "rollback" as const, reason: input.reason },
  ]
}

export function tables(input: { mutations: CloudRepository.Mutation[] }) {
  return Array.from(new Set(input.mutations.map((mutation) => mutation.table))).toSorted()
}

export * as CloudDatabaseAdapter from "./database-adapter"
