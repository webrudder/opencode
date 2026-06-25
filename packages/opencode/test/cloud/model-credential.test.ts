import { describe, expect, test } from "bun:test"
import { CloudModelCredential } from "../../src/cloud/model-credential"

const platform = CloudModelCredential.decodeCredential({
  id: "cred_platform",
  scope: "platform",
  ownerKey: "platform",
  providerType: "openai-compatible",
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  secretRef: "secret/platform",
  allowedModels: ["gpt-4.1"],
  defaultModel: "gpt-4.1",
  enabled: true,
  version: 1,
  time: { created: 10, updated: 10 },
})

const user = CloudModelCredential.decodeCredential({
  id: "cred_user",
  scope: "external_user",
  ownerKey: "integrator_abc/customer_abc/user_abc",
  providerType: "openai-compatible",
  provider: "openai-compatible",
  baseURL: "https://llm.customer.example/v1",
  secretRef: "secret/user",
  allowedModels: ["qwen-max"],
  defaultModel: "qwen-max",
  enabled: true,
  version: 7,
  time: { created: 10, updated: 20 },
})

const context = {
  integratorID: "integrator_abc",
  externalTenantID: "customer_abc",
  externalUserID: "user_abc",
}

describe("CloudModelCredential", () => {
  test("uses an explicitly requested user credential before platform defaults", () => {
    expect(
      CloudModelCredential.select({
        context,
        credentials: [platform, user],
        platformDefault: { credentialID: platform.id, model: "gpt-4.1" },
        request: { credentialID: user.id, model: "qwen-max" },
      }),
    ).toMatchObject({
      provider: "openai-compatible",
      model: "qwen-max",
      credentialID: "cred_user",
      credentialVersion: 7,
      baseURL: "https://llm.customer.example/v1",
      secretRef: "secret/user",
    })
  })

  test("rejects explicit credential/model mismatches instead of falling back", () => {
    expect(() =>
      CloudModelCredential.select({
        context,
        credentials: [platform, user],
        platformDefault: { credentialID: platform.id, model: "gpt-4.1" },
        request: { credentialID: user.id, model: "gpt-4.1" },
      }),
    ).toThrow("model_not_allowed")
  })

  test("rejects credentials outside the caller namespace", () => {
    const other = CloudModelCredential.decodeCredential({ ...user, id: "cred_other", ownerKey: "integrator_abc/customer_xyz/user_abc" })

    expect(() =>
      CloudModelCredential.select({
        context,
        credentials: [platform, other],
        platformDefault: { credentialID: platform.id, model: "gpt-4.1" },
        request: { credentialID: other.id, model: "qwen-max" },
      }),
    ).toThrow("credential_scope_denied")
  })

  test("freezes a model config snapshot at job creation time", () => {
    const snapshot = CloudModelCredential.snapshot({
      jobID: "job_abc",
      now: 30,
      selection: CloudModelCredential.select({
        context,
        credentials: [platform, user],
        platformDefault: { credentialID: platform.id, model: "gpt-4.1" },
        request: { credentialID: user.id },
      }),
    })

    expect(snapshot).toMatchObject({
      jobID: "job_abc",
      credentialID: "cred_user",
      credentialVersion: 7,
      model: "qwen-max",
      time: { created: 30, updated: 30 },
    })
  })
})
