import { describe, expect, test } from "bun:test"
import { CloudAudit } from "../../src/cloud/audit"
import { CloudStore } from "../../src/cloud/store"

describe("CloudAudit", () => {
  test("builds deterministic audit events", () => {
    expect(
      CloudAudit.event({
        id: "audit_abc",
        tenantID: "tenant_abc",
        userID: "user_abc",
        resourceType: "job",
        resourceID: "job_abc",
        action: "job.create",
        time: 10,
      }),
    ).toEqual({
      id: "audit_abc",
      tenantID: "tenant_abc",
      userID: "user_abc",
      resourceType: "job",
      resourceID: "job_abc",
      action: "job.create",
      time: { created: 10, updated: 10 },
    })
  })

  test("stores and lists audit events inside the tenant boundary", () => {
    const store = CloudStore.create()
    store.putAuditEvent(
      CloudAudit.event({
        id: "audit_a",
        tenantID: "tenant_a",
        userID: "user_a",
        resourceType: "artifact",
        resourceID: "artifact_a",
        action: "artifact.download",
        time: 10,
      }),
    )
    store.putAuditEvent(
      CloudAudit.event({
        id: "audit_b",
        tenantID: "tenant_b",
        userID: "user_b",
        resourceType: "artifact",
        resourceID: "artifact_b",
        action: "artifact.download",
        time: 20,
      }),
    )

    expect(store.listAuditEvents({ tenantID: "tenant_a" }).map((event) => event.id)).toEqual(["audit_a"])
    expect(store.listAuditEvents({ tenantID: "tenant_b" }).map((event) => event.id)).toEqual(["audit_b"])
  })

  test("filters audit events by user and resource", () => {
    const events = [
      CloudAudit.event({
        id: "audit_1",
        tenantID: "tenant_abc",
        userID: "user_abc",
        resourceType: "job",
        resourceID: "job_abc",
        action: "job.cancel",
        time: 10,
      }),
      CloudAudit.event({
        id: "audit_2",
        tenantID: "tenant_abc",
        userID: "user_xyz",
        resourceType: "job",
        resourceID: "job_abc",
        action: "job.read",
        time: 20,
      }),
      CloudAudit.event({
        id: "audit_3",
        tenantID: "tenant_abc",
        userID: "user_abc",
        resourceType: "session",
        resourceID: "session_abc",
        action: "session.read",
        time: 30,
      }),
    ]

    expect(
      CloudAudit.filter({
        events,
        userID: "user_abc",
        resourceType: "job",
        resourceID: "job_abc",
      }).map((event) => event.id),
    ).toEqual(["audit_1"])
  })
})
