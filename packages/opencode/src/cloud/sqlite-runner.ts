import type { Database } from "bun:sqlite"
import type { CloudDatabaseAdapter } from "./database-adapter"

type Binding = string | number | boolean | null

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
  throw new Error(`Unsafe SQLite identifier: ${input}`)
}

function where(input: Record<string, string | number>) {
  return {
    clause: Object.keys(input)
      .map((key) => `${identifier(key)} = ?`)
      .join(" and "),
    values: Object.values(input),
  }
}

function insertSQL(input: CloudDatabaseAdapter.Operation & { action: "write"; mutation: "insert" }) {
  return {
    sql: `insert into ${identifier(input.table)} (${Object.keys(input.values).map(identifier).join(", ")}) values (${Object.keys(input.values)
      .map(() => "?")
      .join(", ")})`,
    values: Object.values(input.values).map(serialize),
  }
}

function updateSQL(input: CloudDatabaseAdapter.Operation & { action: "write"; mutation: "update" }) {
  const condition = where(input.key)
  return {
    sql: `update ${identifier(input.table)} set ${Object.keys(input.values)
      .map((key) => `${identifier(key)} = ?`)
      .join(", ")} where ${condition.clause}`,
    values: [...Object.values(input.values).map(serialize), ...condition.values],
  }
}

function deleteSQL(input: CloudDatabaseAdapter.Operation & { action: "write"; mutation: "delete" }) {
  const condition = where(input.key)
  return {
    sql: `delete from ${identifier(input.table)} where ${condition.clause}`,
    values: condition.values,
  }
}

function write(input: {
  db: Database
  operation: CloudDatabaseAdapter.Operation & { action: "write" }
}) {
  const statement =
    input.operation.mutation === "insert"
      ? insertSQL({ ...input.operation, mutation: "insert" })
      : input.operation.mutation === "update"
        ? updateSQL({ ...input.operation, mutation: "update" })
        : deleteSQL({ ...input.operation, mutation: "delete" })

  input.db.query(statement.sql).run(...statement.values)
  return 1
}

export function run(input: {
  db: Database
  operations: CloudDatabaseAdapter.Operation[]
}) {
  const writes = input.operations
    .map((operation) => {
      if (operation.action === "begin") {
        input.db.exec(`begin ${operation.isolation}`)
        return 0
      }
      if (operation.action === "write") return write({ db: input.db, operation })
      if (operation.action === "rollback") {
        input.db.exec("rollback")
        return 0
      }
      input.db.exec("commit")
      return 0
    })
    .reduce((sum, item) => sum + item, 0)

  return {
    writes,
    committed: input.operations.at(-1)?.action === "commit",
  }
}

export * as CloudSQLiteRunner from "./sqlite-runner"
