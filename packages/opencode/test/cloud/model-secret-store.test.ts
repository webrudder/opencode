import { describe, expect, test } from "bun:test"
import { CloudModelSecretStore } from "../../src/cloud/model-secret-store"

describe("CloudModelSecretStore", () => {
  test("stores, resolves, rotates, and deletes model secrets inside a tenant boundary", () => {
    const store = CloudModelSecretStore.memory()

    store.put({ tenantID: "tenant_abc", secretRef: "tenant_abc/user/key", secret: "sk-first", now: 10 })

    expect(store.resolve({ tenantID: "tenant_abc", secretRef: "tenant_abc/user/key" })).toBe("sk-first")
    expect(store.resolve({ tenantID: "tenant_other", secretRef: "tenant_abc/user/key" })).toBeUndefined()

    store.put({ tenantID: "tenant_abc", secretRef: "tenant_abc/user/key", secret: "sk-rotated", now: 20 })

    expect(store.resolve({ tenantID: "tenant_abc", secretRef: "tenant_abc/user/key" })).toBe("sk-rotated")
    expect(store.delete({ tenantID: "tenant_abc", secretRef: "tenant_abc/user/key" })?.secret).toBe("sk-rotated")
    expect(store.resolve({ tenantID: "tenant_abc", secretRef: "tenant_abc/user/key" })).toBeUndefined()
  })

  test("builds a worker-compatible resolver for stored BYOK secrets", () => {
    const store = CloudModelSecretStore.memory()
    store.put({ tenantID: "tenant_abc", secretRef: "secret/user/key", secret: "sk-user", now: 10 })

    expect(CloudModelSecretStore.resolver({ store, tenantID: "tenant_abc" })("secret/user/key")).toBe("sk-user")
  })
})
