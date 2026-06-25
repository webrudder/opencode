import type { CloudDatabaseAdapter } from "./database-adapter"

type Binding = string | number | boolean | null

export type QueryResult = { rowCount?: number | null; rows?: Record<string, unknown>[] } | Record<string, unknown>[]

export type QueryClient = {
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  close?(): Promise<void> | void
}

function serialize(input: unknown): Binding {
  if (input === undefined) return null
  if (input === null) return null
  if (typeof input === "object") return JSON.stringify(input)
  if (typeof input === "string") return input
  if (typeof input === "number") return input
  if (typeof input === "boolean") return input
  return `${input}`
}

function identifier(input: string) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(input)) return input
  throw new Error(`Unsafe PostgreSQL identifier: ${input}`)
}

function placeholders(input: { count: number; offset?: number }) {
  return Array.from({ length: input.count }, (_, index) => `$${(input.offset ?? 0) + index + 1}`)
}

function where(input: Record<string, string | number>, offset = 0) {
  return {
    clause: Object.keys(input)
      .map((key, index) => `${identifier(key)} = $${offset + index + 1}`)
      .join(" and "),
    values: Object.values(input),
  }
}

function insertSQL(input: CloudDatabaseAdapter.Operation & { action: "write"; mutation: "insert" }) {
  return {
    sql: `insert into ${identifier(input.table)} (${Object.keys(input.values).map(identifier).join(", ")}) values (${placeholders({
      count: Object.keys(input.values).length,
    }).join(", ")})`,
    values: Object.values(input.values).map(serialize),
  }
}

function updateSQL(input: CloudDatabaseAdapter.Operation & { action: "write"; mutation: "update" }) {
  const condition = where(input.key, Object.keys(input.values).length)
  return {
    sql: `update ${identifier(input.table)} set ${Object.keys(input.values)
      .map((key, index) => `${identifier(key)} = $${index + 1}`)
      .join(", ")} where ${condition.clause}`,
    values: [...Object.values(input.values).map(serialize), ...condition.values.map(serialize)],
  }
}

function deleteSQL(input: CloudDatabaseAdapter.Operation & { action: "write"; mutation: "delete" }) {
  const condition = where(input.key)
  return {
    sql: `delete from ${identifier(input.table)} where ${condition.clause}`,
    values: condition.values.map(serialize),
  }
}

function beginSQL(input: string) {
  if (input === "immediate") return "begin"
  return `begin ${input}`
}

async function write(input: {
  client: QueryClient
  operation: CloudDatabaseAdapter.Operation & { action: "write" }
}) {
  const statement =
    input.operation.mutation === "insert"
      ? insertSQL({ ...input.operation, mutation: "insert" })
      : input.operation.mutation === "update"
        ? updateSQL({ ...input.operation, mutation: "update" })
        : deleteSQL({ ...input.operation, mutation: "delete" })

  const result = await input.client.query(statement.sql, statement.values)
  if (Array.isArray(result)) return 1
  return result.rowCount ?? 1
}

export async function run(input: {
  client: QueryClient
  operations: CloudDatabaseAdapter.Operation[]
}) {
  let writes = 0
  for (const operation of input.operations) {
    if (operation.action === "begin") {
      await input.client.query(beginSQL(operation.isolation), [])
      continue
    }
    if (operation.action === "write") {
      writes += await write({ client: input.client, operation })
      continue
    }
    if (operation.action === "rollback") {
      await input.client.query("rollback", [])
      continue
    }
    await input.client.query("commit", [])
  }

  return {
    writes,
    committed: input.operations.at(-1)?.action === "commit",
  }
}

export * as CloudPostgresRunner from "./postgres-runner"
