import { describe, expect, test } from "bun:test"
import { CloudModelSecretAdapter } from "../../src/cloud/model-secret-adapter"

describe("CloudModelSecretAdapter", () => {
  test("builds provider-neutral model secret put, resolve, delete, and rotation operations", () => {
    expect(
      CloudModelSecretAdapter.put({
        tenantID: "tenant_abc",
        secretRef: "tenant_abc/user/key",
        secret: "sk-user",
        provider: "anthropic",
        credentialID: "llmcred_abc",
        scope: "external_user",
        ownerKey: "integrator/tenant/user",
      }),
    ).toEqual({
      action: "put",
      tenantID: "tenant_abc",
      secretRef: "tenant_abc/user/key",
      secret: "sk-user",
      metadata: {
        "tenant-id": "tenant_abc",
        provider: "anthropic",
        "credential-id": "llmcred_abc",
        scope: "external_user",
        "owner-key": "integrator/tenant/user",
      },
    })
    expect(CloudModelSecretAdapter.resolve({ tenantID: "tenant_abc", secretRef: "tenant_abc/user/key" })).toEqual({
      action: "resolve",
      tenantID: "tenant_abc",
      secretRef: "tenant_abc/user/key",
    })
    expect(CloudModelSecretAdapter.rotate({
      tenantID: "tenant_abc",
      oldSecretRef: "old",
      newSecretRef: "new",
      secret: "sk-rotated",
      provider: "openai",
      credentialID: "llmcred_abc",
    }).map(CloudModelSecretAdapter.redacted)).toEqual([
      {
        action: "put",
        tenantID: "tenant_abc",
        secretRef: "new",
        secret: "***",
        metadata: {
          "tenant-id": "tenant_abc",
          provider: "openai",
          "credential-id": "llmcred_abc",
        },
      },
      {
        action: "delete",
        tenantID: "tenant_abc",
        secretRef: "old",
      },
    ])
  })
})
