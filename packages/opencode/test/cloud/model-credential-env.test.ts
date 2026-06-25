import { describe, expect, test } from "bun:test"
import { CloudModelCredentialEnv } from "../../src/cloud/model-credential-env"

const snapshot = {
  jobID: "job_123",
  credentialID: "cred_user",
  credentialVersion: 3,
  providerType: "openai-compatible",
  provider: "openai-compatible",
  baseURL: "https://llm.customer.example/v1",
  secretRef: "secret/user/key",
  model: "qwen-max",
  time: { created: 10, updated: 10 },
}

describe("CloudModelCredentialEnv", () => {
  test("maps model snapshots to provider environment variables without exposing secret refs", async () => {
    const result = await CloudModelCredentialEnv.resolve({
      snapshot,
      resolveSecret: async (secretRef) => secretRef === "secret/user/key" ? "sk-user" : undefined,
    })

    expect(result).toMatchObject({
      env: {
        OPENAI_API_KEY: "sk-user",
        OPENAI_BASE_URL: "https://llm.customer.example/v1",
      },
      evidence: {
        credentialID: "cred_user",
        credentialVersion: 3,
        provider: "openai-compatible",
        model: "qwen-max",
        envKeys: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
      },
    })
  })

  test("uses native provider key names for Anthropic and OpenAI credentials", () => {
    expect(CloudModelCredentialEnv.envName({ provider: "anthropic", providerType: "anthropic" })).toBe("ANTHROPIC_API_KEY")
    expect(CloudModelCredentialEnv.envName({ provider: "openai", providerType: "openai" })).toBe("OPENAI_API_KEY")
  })

  test("rejects snapshots when the secret resolver cannot provide a key", async () => {
    await expect(
      CloudModelCredentialEnv.resolve({
        snapshot,
        resolveSecret: async () => undefined,
      }),
    ).rejects.toThrow("model_credential_secret_missing: secret/user/key")
  })

  test("returns empty env when the job has no model credential snapshot", async () => {
    expect(
      await CloudModelCredentialEnv.resolve({
        resolveSecret: async () => {
          throw new Error("should not resolve")
        },
      }),
    ).toEqual({
      env: {},
      evidence: undefined,
    })
  })

  test("builds an environment-backed secret resolver from sanitized secret refs", async () => {
    const resolver = CloudModelCredentialEnv.envSecretResolver({
      env: {
        CLOUD_RUNTIME_MODEL_SECRET_SECRET_USER_KEY: "sk-user",
      },
    })

    expect(await resolver("secret/user/key", snapshot)).toBe("sk-user")
  })
})
