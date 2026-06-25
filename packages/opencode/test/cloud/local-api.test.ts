import { describe, expect, test } from "bun:test"
import { config, serve } from "../../src/cloud/local-api"

describe("CloudLocalAPI", () => {
  test("reads local API listen config from environment values", () => {
    expect(
      config({
        env: {
          CLOUD_RUNTIME_HTTP_HOSTNAME: "127.0.0.1",
          CLOUD_RUNTIME_HTTP_PORT: "8788",
          CLOUD_RUNTIME_SERVICE_VERSION: "local-test",
          CLOUD_RUNTIME_STORAGE: "sqlite",
          CLOUD_RUNTIME_SQLITE_PATH: "/tmp/cloud-runtime.sqlite",
        },
      }),
    ).toEqual({
      hostname: "127.0.0.1",
      port: 8788,
      serviceVersion: "local-test",
      storage: "sqlite",
      sqlitePath: "/tmp/cloud-runtime.sqlite",
      databaseURL: undefined,
      bucket: undefined,
      objectEndpoint: undefined,
      objectRegion: undefined,
      objectAccessKeyID: undefined,
      objectSecretAccessKey: undefined,
      tenant: {
        id: "tenant_local",
        defaultRuntimeVersion: "1.14.28",
        defaultRuntimeImage: "cloud-runtime-opencode:1.14.28",
        defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
        allowedModels: ["anthropic/claude-sonnet-4-5"],
      },
    })
  })

  test("uses local development defaults", () => {
    expect(config({ env: {} })).toEqual({
      hostname: undefined,
      port: 8787,
      serviceVersion: "dev",
      storage: "memory",
      sqlitePath: undefined,
      databaseURL: undefined,
      bucket: undefined,
      objectEndpoint: undefined,
      objectRegion: undefined,
      objectAccessKeyID: undefined,
      objectSecretAccessKey: undefined,
      tenant: {
        id: "tenant_local",
        defaultRuntimeVersion: "1.14.28",
        defaultRuntimeImage: "cloud-runtime-opencode:1.14.28",
        defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
        allowedModels: ["anthropic/claude-sonnet-4-5"],
      },
    })
  })

  test("builds the local tenant default model from environment overrides", () => {
    expect(
      config({
        env: {
          CLOUD_RUNTIME_MODEL_PROVIDER: "openai",
          CLOUD_RUNTIME_MODEL: "gpt-5",
        },
      }).tenant,
    ).toEqual({
      id: "tenant_local",
      defaultRuntimeVersion: "1.14.28",
      defaultRuntimeImage: "cloud-runtime-opencode:1.14.28",
      defaultModel: { provider: "openai", model: "gpt-5" },
      allowedModels: ["openai/gpt-5"],
    })
  })

  test("can select a PostgreSQL-backed API service from environment", () => {
    expect(
      config({
        env: {
          CLOUD_RUNTIME_STORAGE: "postgres",
          CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:opencode@postgres:5432/cloud_runtime",
          CLOUD_RUNTIME_OBJECT_BUCKET: "runtime-artifacts",
          CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://minio:9000",
          CLOUD_RUNTIME_OBJECT_REGION: "us-east-1",
          CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID: "opencode",
          CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY: "secret",
        },
      }),
    ).toMatchObject({
      storage: "postgres",
      databaseURL: "postgres://opencode:opencode@postgres:5432/cloud_runtime",
      bucket: "runtime-artifacts",
      objectEndpoint: "http://minio:9000",
      objectRegion: "us-east-1",
      objectAccessKeyID: "opencode",
      objectSecretAccessKey: "secret",
    })
  })

  test("serves a PostgreSQL-backed API app from an injected query client", async () => {
    const result = await serve({
      env: {
        CLOUD_RUNTIME_STORAGE: "postgres",
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:opencode@postgres:5432/cloud_runtime",
      },
      client: {
        query: async () => [],
      },
      serve: (input) => ({
        hostname: input.hostname ?? "0.0.0.0",
        port: Number(input.port ?? 8787),
        stop: async () => undefined,
      }),
    })

    expect(result.server.port).toBe(8787)
    expect((await result.runtime.app.request("/health")).status).toBe(200)
  })

  test("passes an environment-built S3-compatible storage client into the PostgreSQL API", async () => {
    const factories: Record<string, unknown>[] = []
    await serve({
      env: {
        CLOUD_RUNTIME_STORAGE: "postgres",
        CLOUD_RUNTIME_DATABASE_URL: "postgres://opencode:opencode@postgres:5432/cloud_runtime",
        CLOUD_RUNTIME_OBJECT_ENDPOINT: "http://minio:9000",
        CLOUD_RUNTIME_OBJECT_REGION: "us-east-1",
        CLOUD_RUNTIME_OBJECT_ACCESS_KEY_ID: "opencode",
        CLOUD_RUNTIME_OBJECT_SECRET_ACCESS_KEY: "secret",
      },
      client: { query: async () => [] },
      storageClientFactory: (input) => {
        factories.push(input)
        return { signDownload: async () => "signed" }
      },
      serve: (input) => ({
        hostname: input.hostname ?? "0.0.0.0",
        port: Number(input.port ?? 8787),
        stop: async () => undefined,
      }),
    })

    expect(factories).toEqual([
      {
        endpoint: "http://minio:9000",
        region: "us-east-1",
        accessKeyID: "opencode",
        secretAccessKey: "secret",
      },
    ])
  })
})
