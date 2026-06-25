import type { QueryClient } from "./postgres-runner"

type SQL = new (url: string, options: { max: number }) => {
  unsafe(statement: string, params: unknown[]): Promise<Record<string, unknown>[]>
  close(): Promise<void> | void
}

export function create(input: { url: string | undefined; SQL?: SQL }): QueryClient {
  if (!input.url) throw new Error("CLOUD_RUNTIME_DATABASE_URL is required for PostgreSQL Cloud Runtime")
  const sql = new (input.SQL ?? Bun.SQL)(input.url, { max: 1 })
  return {
    query: async (statement, params = []) => await sql.unsafe(statement, params) as Record<string, unknown>[],
    close: async () => await sql.close(),
  }
}

export * as CloudPostgresClient from "./postgres-client"
