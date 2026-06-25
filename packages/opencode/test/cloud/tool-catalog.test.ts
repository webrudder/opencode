import { describe, expect, test } from "bun:test"
import { CloudToolCatalog } from "../../src/cloud/tool-catalog"

describe("CloudToolCatalog", () => {
  test("builds a public tool catalog filtered by policy", () => {
    expect(
      CloudToolCatalog.publicCatalog({
        catalog: {
          mcp: {
            browser: { title: "Browser", description: "Open web pages", type: "remote", url: "https://mcp.internal/browser" },
            database: { title: "Database", description: "Query data", type: "remote", url: "https://mcp.internal/db" },
          },
          skills: {
            "report-writer@1.0.0": { title: "Report Writer", description: "Create reports", path: "/internal/report" },
            "data-analysis@1.0.0": { title: "Data Analysis", description: "Analyze files", path: "/internal/data" },
          },
          connectors: {
            slack: { title: "Slack", description: "Post messages", enabled: true, internalAuthRef: "secret/slack" },
            salesforce: { title: "Salesforce", description: "CRM data", enabled: false, internalAuthRef: "secret/sf" },
          },
        },
        policy: {
          webfetch: { enabled: true, allowDomains: ["docs.example.com"] },
          websearch: { enabled: true, providers: ["platform-search"] },
          mcp: ["browser"],
          skills: ["report-writer@1.0.0"],
          connectors: ["slack"],
        },
      }),
    ).toEqual({
      webfetch: { enabled: true, allowDomains: ["docs.example.com"] },
      websearch: { enabled: true, providers: ["platform-search"] },
      mcp: [{ name: "browser", title: "Browser", description: "Open web pages" }],
      skills: [{ name: "report-writer@1.0.0", title: "Report Writer", description: "Create reports" }],
      connectors: [{ name: "slack", title: "Slack", description: "Post messages" }],
    })
  })

  test("omits disabled connectors even when policy allows them", () => {
    expect(
      CloudToolCatalog.publicCatalog({
        catalog: {
          mcp: {},
          skills: {},
          connectors: {
            salesforce: { title: "Salesforce", description: "CRM data", enabled: false, internalAuthRef: "secret/sf" },
          },
        },
        policy: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false, providers: [] },
          mcp: [],
          skills: [],
          connectors: ["salesforce"],
        },
      }).connectors,
    ).toEqual([])
  })
})
