import type { CloudAPI } from "./api"

type Policy = {
  webfetch: {
    enabled: boolean
    allowDomains: string[]
  }
  websearch: {
    enabled: boolean
    providers: string[]
  }
  mcp: string[]
  skills: string[]
}

export function apply(input: { request: CloudAPI.CreateJobRequest["tools"]; policy: Policy }) {
  if (input.request.webfetch.enabled && !input.policy.webfetch.enabled) {
    throw new Error("Cloud tool policy denied webfetch")
  }
  input.request.webfetch.allowDomains.map((domain) => {
    if (!input.policy.webfetch.allowDomains.includes(domain)) {
      throw new Error(`Cloud tool policy denied webfetch domain: ${domain}`)
    }
  })

  if (input.request.websearch.enabled && !input.policy.websearch.enabled) {
    throw new Error("Cloud tool policy denied websearch")
  }
  if (
    input.request.websearch.enabled &&
    input.request.websearch.provider &&
    !input.policy.websearch.providers.includes(input.request.websearch.provider)
  ) {
    throw new Error(`Cloud tool policy denied websearch provider: ${input.request.websearch.provider}`)
  }

  input.request.mcp.map((name) => {
    if (!input.policy.mcp.includes(name)) throw new Error(`Cloud tool policy denied MCP server: ${name}`)
  })
  input.request.skills.map((name) => {
    if (!input.policy.skills.includes(name)) throw new Error(`Cloud tool policy denied skill: ${name}`)
  })

  return input.request
}

export * as CloudToolPolicy from "./tool-policy"
