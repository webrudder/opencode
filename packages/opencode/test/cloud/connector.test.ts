import { describe, expect, test } from "bun:test"
import { CloudConnector } from "../../src/cloud/connector"

describe("CloudConnector", () => {
  test("creates a scoped runtime grant without exposing tenant OAuth secrets", () => {
    const grant = CloudConnector.grant({
      tenantID: "tenant_abc",
      connector: {
        name: "slack",
        authRef: "secret/oauth/slack",
        scopes: ["channels:read", "chat:write"],
      },
      request: {
        jobID: "job_abc",
        sessionID: "session_abc",
        scopes: ["channels:read"],
      },
      token: {
        value: "short-lived-token",
        expiresAt: 1010,
      },
    })

    expect(grant).toEqual({
      tenantID: "tenant_abc",
      jobID: "job_abc",
      sessionID: "session_abc",
      connector: "slack",
      scopes: ["channels:read"],
      expiresAt: 1010,
      headers: {
        "x-cloud-connector": "slack",
        "x-cloud-connector-token": "short-lived-token",
      },
    })
    expect(JSON.stringify(grant)).not.toContain("secret/oauth/slack")
  })

  test("rejects connector scopes not allowed by tenant policy", () => {
    expect(() =>
      CloudConnector.grant({
        tenantID: "tenant_abc",
        connector: {
          name: "slack",
          authRef: "secret/oauth/slack",
          scopes: ["channels:read"],
        },
        request: {
          jobID: "job_abc",
          sessionID: "session_abc",
          scopes: ["chat:write"],
        },
        token: {
          value: "short-lived-token",
          expiresAt: 1010,
        },
      }),
    ).toThrow("Cloud connector scope denied: chat:write")
  })

  test("builds remote MCP headers from connector grants", () => {
    expect(
      CloudConnector.mcpHeaders({
        connector: "slack",
        grant: CloudConnector.grant({
          tenantID: "tenant_abc",
          connector: {
            name: "slack",
            authRef: "secret/oauth/slack",
            scopes: ["channels:read"],
          },
          request: {
            jobID: "job_abc",
            sessionID: "session_abc",
            scopes: ["channels:read"],
          },
          token: {
            value: "short-lived-token",
            expiresAt: 1010,
          },
        }),
      }),
    ).toEqual({
      "x-cloud-connector": "slack",
      "x-cloud-connector-token": "short-lived-token",
    })
  })
})
