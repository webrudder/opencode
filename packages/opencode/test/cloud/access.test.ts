import { describe, expect, test } from "bun:test"
import { CloudAccess } from "../../src/cloud/access"

describe("CloudAccess", () => {
  test("allows resources owned by the current tenant", () => {
    expect(
      CloudAccess.assertTenant({
        tenantID: "tenant_abc",
        resource: { id: "job_abc", tenantID: "tenant_abc" },
      }),
    ).toEqual({ id: "job_abc", tenantID: "tenant_abc" })
  })

  test("rejects cross-tenant resource access", () => {
    expect(() =>
      CloudAccess.assertTenant({
        tenantID: "tenant_abc",
        resource: { id: "artifact_xyz", tenantID: "tenant_xyz" },
      }),
    ).toThrow("Cloud resource tenant mismatch")
  })

  test("rejects resources without tenant ownership", () => {
    expect(() =>
      CloudAccess.assertTenant({
        tenantID: "tenant_abc",
        resource: { id: "legacy_resource" },
      }),
    ).toThrow("Cloud resource is missing tenant ownership")
  })

  test("filters lists to the current tenant", () => {
    expect(
      CloudAccess.filterTenant({
        tenantID: "tenant_abc",
        resources: [
          { id: "job_1", tenantID: "tenant_abc" },
          { id: "job_2", tenantID: "tenant_xyz" },
          { id: "job_3", tenantID: "tenant_abc" },
        ],
      }).map((item) => item.id),
    ).toEqual(["job_1", "job_3"])
  })

  test("checks optional user ownership when provided", () => {
    expect(
      CloudAccess.assertUser({
        tenantID: "tenant_abc",
        userID: "user_abc",
        resource: { id: "session_abc", tenantID: "tenant_abc", userID: "user_abc" },
      }).id,
    ).toBe("session_abc")

    expect(() =>
      CloudAccess.assertUser({
        tenantID: "tenant_abc",
        userID: "user_abc",
        resource: { id: "session_xyz", tenantID: "tenant_abc", userID: "user_xyz" },
      }),
    ).toThrow("Cloud resource user mismatch")
  })
})
