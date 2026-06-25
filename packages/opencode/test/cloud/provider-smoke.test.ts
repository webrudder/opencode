import { describe, expect, test } from "bun:test"
import { CloudProviderSmoke } from "../../src/cloud/provider-smoke"
import type { Clients } from "../../src/cloud/provider-smoke"

function postgres() {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const tenants = new Set<string>()
  const users = new Set<string>()
  const workspaces = new Set<string>()
  const sessions = new Set<string>()
  const jobs = new Set<string>()
  const queue = new Map<string, { status: string; workerID?: string; leaseExpiresAt?: number }>()
  return {
    calls,
    client: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        if (sql.startsWith("insert into cloud_tenant")) {
          tenants.add(String(params?.[0]))
          return { rows: [], rowCount: 1 }
        }
        if (sql.startsWith("insert into cloud_user")) {
          if (!tenants.has(String(params?.[1]))) throw new Error(`tenant ${params?.[1]} is missing`)
          users.add(String(params?.[0]))
          return { rows: [], rowCount: 1 }
        }
        if (sql.startsWith("insert into cloud_workspace")) {
          if (!tenants.has(String(params?.[1]))) throw new Error(`tenant ${params?.[1]} is missing`)
          workspaces.add(String(params?.[0]))
          return { rows: [], rowCount: 1 }
        }
        if (sql.startsWith("insert into cloud_session")) {
          if (!tenants.has(String(params?.[1]))) throw new Error(`tenant ${params?.[1]} is missing`)
          if (!workspaces.has(String(params?.[2]))) throw new Error(`workspace ${params?.[2]} is missing`)
          if (!users.has(String(params?.[3]))) throw new Error(`user ${params?.[3]} is missing`)
          sessions.add(String(params?.[0]))
          return { rows: [], rowCount: 1 }
        }
        if (sql.startsWith("insert into cloud_job")) {
          if (!tenants.has(String(params?.[1]))) throw new Error(`tenant ${params?.[1]} is missing`)
          if (!workspaces.has(String(params?.[2]))) throw new Error(`workspace ${params?.[2]} is missing`)
          if (!sessions.has(String(params?.[3]))) throw new Error(`session ${params?.[3]} is missing`)
          jobs.add(String(params?.[0]))
          return { rows: [], rowCount: 1 }
        }
        if (sql.startsWith("insert into cloud_queue_message")) {
          if (!tenants.has(String(params?.[1]))) throw new Error(`tenant ${params?.[1]} is missing`)
          if (!jobs.has(String(params?.[2]))) throw new Error(`job ${params?.[2]} is missing`)
          queue.set(String(params?.[2]), { status: "queued" })
          return { rows: [], rowCount: 1 }
        }
        if (sql.startsWith("update cloud_queue_message set\n        status = 'leased'")) {
          const message = queue.get(String(params?.[2]))
          if (message?.status !== "queued") return { rows: [], rowCount: 0 }
          queue.set(String(params?.[2]), { status: "leased", workerID: String(params?.[3]), leaseExpiresAt: Number(params?.[4]) })
          return { rows: [{ job_id: params?.[2], lease_expires_at: params?.[4] }], rowCount: 1 }
        }
        if (sql.startsWith("update cloud_queue_message set\n        status = 'acked'")) {
          const message = queue.get(String(params?.[0]))
          if (message?.status !== "leased") return { rows: [], rowCount: 0 }
          queue.set(String(params?.[0]), { ...message, status: "acked" })
          return { rows: [], rowCount: 1 }
        }
        return { rows: [{ ok: 1 }], rowCount: 1 }
      },
    },
  }
}

function objectStorage() {
  const objects = new Map<string, string>()
  const calls: Array<{ action: string; input: Record<string, unknown> }> = []
  return {
    calls,
    client: {
      putObject: async (input: Parameters<NonNullable<Clients["objectStorage"]["putObject"]>>[0]) => {
        calls.push({ action: "put", input })
        objects.set(input.objectKey, String(input.body))
        return { etag: "etag_put" }
      },
      listObjects: async (input: Parameters<NonNullable<Clients["objectStorage"]["listObjects"]>>[0]) => {
        calls.push({ action: "list", input })
        return [...objects.keys()].filter((objectKey) => objectKey.startsWith(input.prefix)).map((objectKey) => ({ objectKey }))
      },
      getObject: async (input: Parameters<NonNullable<Clients["objectStorage"]["getObject"]>>[0]) => {
        calls.push({ action: "get", input })
        return objects.get(input.objectKey) ?? ""
      },
      signDownload: async (input: Parameters<NonNullable<Clients["objectStorage"]["signDownload"]>>[0]) => {
        calls.push({ action: "sign", input })
        return `https://storage.example.com/${input.bucket}/${input.objectKey}?expires=${input.expiresAt}`
      },
      deleteObjects: async (input: Parameters<NonNullable<Clients["objectStorage"]["deleteObjects"]>>[0]) => {
        calls.push({ action: "delete", input })
        input.objectKeys.map((objectKey) => objects.delete(objectKey))
        return { deleted: input.objectKeys.length }
      },
    },
  }
}

const env = {
  CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:secret@postgres.example.com:5432/cloud_runtime",
  CLOUD_RUNTIME_OBJECT_ENDPOINT: "https://s3.example.com",
  CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
  CLOUD_RUNTIME_OBJECT_REGION: "us-east-1",
  CLOUD_RUNTIME_QUEUE: "cloud-runtime-jobs",
  CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
  CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
  CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
}

describe("CloudProviderSmoke", () => {
  test("requires explicit confirmation before writing to real providers", async () => {
    const result = await CloudProviderSmoke.run({ env })

    expect(result.status).toBe("failed")
    expect(result.confirmed).toBe(false)
    expect(result.steps).toEqual([
      {
        name: "confirmation",
        status: "failed",
        detail: "set CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE=1 before writing to real providers",
      },
    ])
  })

  test("fails before smoke operations when provider readiness fails", async () => {
    const result = await CloudProviderSmoke.run({
      env: {
        CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE: "1",
      },
    })

    expect(result.status).toBe("failed")
    expect(result.steps[0]).toEqual({
      name: "provider-readiness",
      status: "failed",
      detail: "provider readiness failed; run bun run cloud:providers:check",
    })
  })

  test("runs schema, queue, and object storage roundtrips through injected clients", async () => {
    const pg = postgres()
    const storage = objectStorage()
    const result = await CloudProviderSmoke.run({
      env: {
        ...env,
        CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE: "1",
        CLOUD_RUNTIME_PROVIDER_SMOKE_PREFIX: "cloud-runtime-smoke/test",
      },
      clients: {
        postgres: pg.client,
        objectStorage: storage.client,
      },
      now: () => 1000,
    })

    expect(result.status).toBe("passed")
    expect(result.steps.map((item) => [item.name, item.status])).toEqual([
      ["postgres-schema", "passed"],
      ["postgres-query", "passed"],
      ["queue-roundtrip", "passed"],
      ["object-storage-roundtrip", "passed"],
    ])
    expect(pg.calls.some((item) => item.sql.includes("create table if not exists cloud_job"))).toBe(true)
    expect(pg.calls.map((item) => item.sql.split(" ")[0] === "insert" ? item.sql.match(/insert into ([a-z_]+)/)?.[1] : undefined).filter(Boolean)).toEqual([
      "cloud_tenant",
      "cloud_user",
      "cloud_workspace",
      "cloud_session",
      "cloud_job",
      "cloud_queue_message",
    ])
    expect(storage.calls.map((item) => item.action)).toEqual(["put", "list", "get", "sign", "delete"])
    expect(result.target).toEqual({
      queue: "cloud-runtime-jobs",
      bucket: "runtime-artifacts",
      prefix: "cloud-runtime-smoke/test",
    })
  })

  test("renders JSON evidence from the CLI", async () => {
    const pg = postgres()
    const storage = objectStorage()
    const result = await CloudProviderSmoke.runCLI({
      env: {
        ...env,
        CLOUD_RUNTIME_CONFIRM_PROVIDER_SMOKE: "1",
      },
      clients: {
        postgres: pg.client,
        objectStorage: storage.client,
      },
      now: () => 2000,
      json: true,
    })
    const evidence = JSON.parse(result.output) as { schemaVersion: number; status: string; steps: Array<{ name: string }> }

    expect(result.exitCode).toBe(0)
    expect(evidence.schemaVersion).toBe(1)
    expect(evidence.status).toBe("passed")
    expect(evidence.steps.map((item) => item.name)).toEqual([
      "postgres-schema",
      "postgres-query",
      "queue-roundtrip",
      "object-storage-roundtrip",
    ])
  })

  test("exposes package scripts for provider smoke", async () => {
    const scripts = (await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts

    expect(scripts["cloud:providers:smoke"]).toBe("bun run ./src/cloud/provider-smoke.ts")
    expect(scripts["cloud:providers:smoke:json"]).toBe("bun run ./src/cloud/provider-smoke.ts --json")
  })
})
