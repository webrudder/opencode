import { describe, expect, test } from "bun:test"
import { CloudModelSecretAdapter } from "../../src/cloud/model-secret-adapter"
import { CloudModelSecretRunner } from "../../src/cloud/model-secret-runner"

describe("CloudModelSecretRunner", () => {
  test("executes put, resolve, and delete through an injected secret client", async () => {
    const secrets = new Map<string, string>()
    const calls: string[] = []
    const client = {
      putSecret(input: { tenantID: string; secretRef: string; secret: string }) {
        calls.push(`put:${input.secretRef}`)
        secrets.set(`${input.tenantID}:${input.secretRef}`, input.secret)
      },
      getSecret(input: { tenantID: string; secretRef: string }) {
        calls.push(`get:${input.secretRef}`)
        return secrets.get(`${input.tenantID}:${input.secretRef}`)
      },
      deleteSecret(input: { tenantID: string; secretRef: string }) {
        calls.push(`delete:${input.secretRef}`)
        secrets.delete(`${input.tenantID}:${input.secretRef}`)
      },
    }

    expect(
      await CloudModelSecretRunner.run({
        client,
        operations: [
          CloudModelSecretAdapter.put({
            tenantID: "tenant_abc",
            secretRef: "tenant_abc/user/key",
            secret: "sk-user",
            provider: "anthropic",
          }),
          CloudModelSecretAdapter.resolve({ tenantID: "tenant_abc", secretRef: "tenant_abc/user/key" }),
          CloudModelSecretAdapter.deleteSecret({ tenantID: "tenant_abc", secretRef: "tenant_abc/user/key" }),
        ],
      }),
    ).toEqual([
      { action: "put", tenantID: "tenant_abc", secretRef: "tenant_abc/user/key", status: "succeeded" },
      {
        action: "resolve",
        tenantID: "tenant_abc",
        secretRef: "tenant_abc/user/key",
        status: "succeeded",
        secretAvailable: true,
      },
      { action: "delete", tenantID: "tenant_abc", secretRef: "tenant_abc/user/key", status: "succeeded" },
    ])
    expect(calls).toEqual(["put:tenant_abc/user/key", "get:tenant_abc/user/key", "delete:tenant_abc/user/key"])
  })

  test("returns failed operation results without exposing secret values", async () => {
    const result = await CloudModelSecretRunner.run({
      client: {},
      operations: [
        CloudModelSecretAdapter.put({
          tenantID: "tenant_abc",
          secretRef: "tenant_abc/user/key",
          secret: "sk-user",
          provider: "anthropic",
        }),
      ],
    })

    expect(result).toEqual([
      {
        action: "put",
        tenantID: "tenant_abc",
        secretRef: "tenant_abc/user/key",
        status: "failed",
        error: "Cloud model secret client missing putSecret",
      },
    ])
    expect(JSON.stringify(result)).not.toContain("sk-user")
  })

  test("wraps a synchronous client as a control-plane model secret store", () => {
    const secrets = new Map<string, string>()
    const store = CloudModelSecretRunner.store({
      client: {
        putSecret: (input) => {
          secrets.set(`${input.tenantID}:${input.secretRef}`, input.secret)
        },
        getSecret: (input) => secrets.get(`${input.tenantID}:${input.secretRef}`),
        deleteSecret: (input) => {
          secrets.delete(`${input.tenantID}:${input.secretRef}`)
        },
      },
    })

    store.put({ tenantID: "tenant_abc", secretRef: "secret/user/key", secret: "sk-user", now: 10 })

    expect(store.resolve({ tenantID: "tenant_abc", secretRef: "secret/user/key" })).toBe("sk-user")
    expect(store.delete({ tenantID: "tenant_abc", secretRef: "secret/user/key" })?.secret).toBe("sk-user")
    expect(store.resolve({ tenantID: "tenant_abc", secretRef: "secret/user/key" })).toBeUndefined()
  })
})
