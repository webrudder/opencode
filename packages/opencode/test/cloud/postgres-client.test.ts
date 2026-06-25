import { describe, expect, test } from "bun:test"
import { CloudPostgresClient } from "../../src/cloud/postgres-client"

describe("CloudPostgresClient", () => {
  test("creates Bun SQL clients with a single connection for explicit transactions", async () => {
    const calls: unknown[] = []
    const subject = CloudPostgresClient.create({
      url: "postgres://runtime",
      SQL: class {
        constructor(url: string, options: unknown) {
          calls.push({ url, options })
        }

        async unsafe(sql: string, params: unknown[]) {
          calls.push({ sql, params })
          return [{ ok: true }]
        }

        close() {
          calls.push({ close: true })
        }
      },
    })

    expect(await subject.query("select 1", [])).toEqual([{ ok: true }])
    await subject.close?.()
    expect(calls.at(0)).toEqual({ url: "postgres://runtime", options: { max: 1 } })
    expect(calls.at(-1)).toEqual({ close: true })
  })
})
