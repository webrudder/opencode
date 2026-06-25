import { describe, expect, test } from "bun:test"
import { CloudToolPolicy } from "../../src/cloud/tool-policy"

const request = {
  webfetch: { enabled: true, allowDomains: ["docs.example.com", "api.example.com"] },
  websearch: { enabled: true, provider: "platform-search" },
  mcp: ["browser", "database"],
  skills: ["report-writer@1.0.0", "data-analysis@1.0.0"],
}

describe("CloudToolPolicy", () => {
  test("allows requested tools within tenant policy", () => {
    expect(
      CloudToolPolicy.apply({
        request,
        policy: {
          webfetch: { enabled: true, allowDomains: ["docs.example.com", "api.example.com"] },
          websearch: { enabled: true, providers: ["platform-search"] },
          mcp: ["browser", "database"],
          skills: ["report-writer@1.0.0", "data-analysis@1.0.0"],
        },
      }),
    ).toEqual(request)
  })

  test("rejects unapproved web domains, mcp servers, and skills", () => {
    expect(() =>
      CloudToolPolicy.apply({
        request,
        policy: {
          webfetch: { enabled: true, allowDomains: ["docs.example.com"] },
          websearch: { enabled: true, providers: ["platform-search"] },
          mcp: ["browser"],
          skills: ["report-writer@1.0.0"],
        },
      }),
    ).toThrow("Cloud tool policy denied webfetch domain: api.example.com")
  })

  test("rejects disabled websearch and unknown providers", () => {
    expect(() =>
      CloudToolPolicy.apply({
        request,
        policy: {
          webfetch: { enabled: true, allowDomains: ["docs.example.com", "api.example.com"] },
          websearch: { enabled: false, providers: [] },
          mcp: ["browser", "database"],
          skills: ["report-writer@1.0.0", "data-analysis@1.0.0"],
        },
      }),
    ).toThrow("Cloud tool policy denied websearch")

    expect(() =>
      CloudToolPolicy.apply({
        request,
        policy: {
          webfetch: { enabled: true, allowDomains: ["docs.example.com", "api.example.com"] },
          websearch: { enabled: true, providers: ["other-search"] },
          mcp: ["browser", "database"],
          skills: ["report-writer@1.0.0", "data-analysis@1.0.0"],
        },
      }),
    ).toThrow("Cloud tool policy denied websearch provider: platform-search")
  })

  test("keeps disabled requested tools disabled", () => {
    expect(
      CloudToolPolicy.apply({
        request: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false },
          mcp: [],
          skills: [],
        },
        policy: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false, providers: [] },
          mcp: [],
          skills: [],
        },
      }),
    ).toEqual({
      webfetch: { enabled: false, allowDomains: [] },
      websearch: { enabled: false },
      mcp: [],
      skills: [],
    })
  })
})
