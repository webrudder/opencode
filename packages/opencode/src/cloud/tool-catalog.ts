type CatalogItem = {
  title: string
  description?: string
}

type Catalog = {
  mcp: Record<string, CatalogItem & { type?: string; url?: string }>
  skills: Record<string, CatalogItem & { path?: string }>
  connectors: Record<string, CatalogItem & { enabled: boolean; internalAuthRef?: string }>
}

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
  connectors: string[]
}

function publicItem(input: [string, CatalogItem]) {
  return {
    name: input[0],
    title: input[1].title,
    description: input[1].description,
  }
}

export function publicCatalog(input: { catalog: Catalog; policy: Policy }) {
  return {
    webfetch: input.policy.webfetch,
    websearch: input.policy.websearch,
    mcp: Object.entries(input.catalog.mcp)
      .filter(([name]) => input.policy.mcp.includes(name))
      .map(publicItem),
    skills: Object.entries(input.catalog.skills)
      .filter(([name]) => input.policy.skills.includes(name))
      .map(publicItem),
    connectors: Object.entries(input.catalog.connectors)
      .filter(([name, item]) => item.enabled && input.policy.connectors.includes(name))
      .map(publicItem),
  }
}

export * as CloudToolCatalog from "./tool-catalog"
