import { describe, expect, test } from "bun:test"
import { CloudRuntimeVersion } from "../../src/cloud/runtime-version"

const stable = {
  version: "1.14.28",
  image: "registry.example.com/cloud-runtime-opencode:1.14.28",
  imageDigest: "sha256:stable",
}
const canary = {
  version: "1.15.0",
  image: "registry.example.com/cloud-runtime-opencode:1.15.0",
  imageDigest: "sha256:canary",
}
const rollback = {
  version: "1.14.20",
  image: "registry.example.com/cloud-runtime-opencode:1.14.20",
  imageDigest: "sha256:rollback",
}

describe("CloudRuntimeVersion", () => {
  test("uses request override and tenant pin before platform defaults", () => {
    expect(
      CloudRuntimeVersion.select({
        tenantID: "tenant_abc",
        requestVersion: "1.14.28",
        defaults: stable,
        versions: { "1.14.28": stable },
      }),
    ).toEqual({ ...stable, source: "request" })

    expect(
      CloudRuntimeVersion.select({
        tenantID: "tenant_abc",
        tenantPinnedVersion: "1.14.20",
        defaults: stable,
        versions: { "1.14.20": rollback, "1.14.28": stable },
      }),
    ).toEqual({ ...rollback, source: "tenant_pin" })
  })

  test("uses emergency rollback before canary and default", () => {
    expect(
      CloudRuntimeVersion.select({
        tenantID: "tenant_abc",
        emergencyRollbackVersion: "1.14.20",
        defaults: stable,
        canary: { version: "1.15.0", percent: 100 },
        versions: { "1.14.20": rollback, "1.14.28": stable, "1.15.0": canary },
      }),
    ).toEqual({ ...rollback, source: "rollback" })
  })

  test("selects canary deterministically by tenant cohort", () => {
    expect(
      CloudRuntimeVersion.select({
        tenantID: "tenant_a",
        defaults: stable,
        canary: { version: "1.15.0", percent: 100 },
        versions: { "1.14.28": stable, "1.15.0": canary },
      }),
    ).toEqual({ ...canary, source: "canary" })

    expect(
      CloudRuntimeVersion.select({
        tenantID: "tenant_a",
        defaults: stable,
        canary: { version: "1.15.0", percent: 0 },
        versions: { "1.14.28": stable, "1.15.0": canary },
      }),
    ).toEqual({ ...stable, source: "default" })
  })

  test("rejects unknown runtime versions", () => {
    expect(() =>
      CloudRuntimeVersion.select({
        tenantID: "tenant_abc",
        requestVersion: "missing",
        defaults: stable,
        versions: { "1.14.28": stable },
      }),
    ).toThrow("Unknown cloud runtime version: missing")
  })
})
