import { describe, expect, test } from "bun:test"
import { CloudAPIKey } from "../../src/cloud/api-key"

describe("CloudAPIKey", () => {
  test("issues a key once and stores only its hash", () => {
    const issued = CloudAPIKey.issue({
      id: "key_abc",
      tenantID: "tenant_abc",
      prefix: "ocrt",
      secret: "secret-value",
      now: 10,
    })

    expect(issued.key).toBe("ocrt_secret-value")
    expect(issued.record).toMatchObject({
      id: "key_abc",
      tenantID: "tenant_abc",
      prefix: "ocrt",
      status: "active",
      time: { created: 10, updated: 10 },
    })
    expect(issued.record.hash).toBe(CloudAPIKey.hash("ocrt_secret-value"))
    expect(JSON.stringify(issued.record)).not.toContain("secret-value")
  })

  test("authenticates bearer tokens against active key hashes", () => {
    const issued = CloudAPIKey.issue({
      id: "key_abc",
      tenantID: "tenant_abc",
      prefix: "ocrt",
      secret: "secret-value",
      now: 10,
    })

    expect(
      CloudAPIKey.authenticate({
        authorization: `Bearer ${issued.key}`,
        records: [issued.record],
      }),
    ).toEqual({
      tenantID: "tenant_abc",
      apiKeyID: "key_abc",
    })
  })

  test("rejects missing, unknown, and revoked keys", () => {
    const issued = CloudAPIKey.issue({
      id: "key_abc",
      tenantID: "tenant_abc",
      prefix: "ocrt",
      secret: "secret-value",
      now: 10,
    })

    expect(() => CloudAPIKey.authenticate({ authorization: undefined, records: [issued.record] })).toThrow(
      "Cloud API key missing",
    )
    expect(() => CloudAPIKey.authenticate({ authorization: "Bearer unknown", records: [issued.record] })).toThrow(
      "Cloud API key invalid",
    )
    expect(() =>
      CloudAPIKey.authenticate({
        authorization: `Bearer ${issued.key}`,
        records: [{ ...issued.record, status: "revoked" }],
      }),
    ).toThrow("Cloud API key revoked")
  })
})
