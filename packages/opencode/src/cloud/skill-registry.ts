type Env = Record<string, string | undefined>

type SkillEntry = {
  title: string
  description?: string
  path: string
}

function parseAllowed(input: string | undefined) {
  return (input ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseCatalog(input: string | undefined) {
  if (!input) return {}
  const parsed = (() => {
    try {
      return JSON.parse(input) as unknown
    } catch (error) {
      throw new Error(`Invalid CLOUD_RUNTIME_SKILL_CATALOG_JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CLOUD_RUNTIME_SKILL_CATALOG_JSON must be an object")
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([name, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Cloud skill registry entry ${name} must be an object`)
      }
      const entry = value as Partial<SkillEntry>
      if (!entry.title) throw new Error(`Cloud skill registry entry ${name} requires title`)
      if (!entry.path) throw new Error(`Cloud skill registry entry ${name} requires path`)
      return [
        name,
        {
          title: entry.title,
          ...(entry.description ? { description: entry.description } : {}),
          path: entry.path,
        },
      ]
    }),
  )
}

export function fromEnv(input: Env) {
  const catalog = parseCatalog(input.CLOUD_RUNTIME_SKILL_CATALOG_JSON)
  const allowed = parseAllowed(input.CLOUD_RUNTIME_ALLOWED_SKILLS)
  return {
    tools: {
      skills: Object.fromEntries(Object.entries(catalog).map(([name, entry]) => [name, entry.path])),
    },
    toolCatalog: {
      catalog: {
        skills: catalog,
      },
      policy: {
        skills: allowed,
      },
    },
  }
}

export function merge<
  Tools extends { skills: Record<string, string> },
  ToolCatalog extends {
    catalog: { skills: Record<string, { title: string; description?: string; path?: string }> }
    policy: { skills: string[] }
  },
>(input: {
  tools: Tools
  toolCatalog: ToolCatalog
  registry: ReturnType<typeof fromEnv>
}) {
  return {
    tools: {
      ...input.tools,
      skills: {
        ...input.tools.skills,
        ...input.registry.tools.skills,
      },
    },
    toolCatalog: {
      ...input.toolCatalog,
      catalog: {
        ...input.toolCatalog.catalog,
        skills: {
          ...input.toolCatalog.catalog.skills,
          ...input.registry.toolCatalog.catalog.skills,
        },
      },
      policy: {
        ...input.toolCatalog.policy,
        skills: Array.from(new Set([...input.toolCatalog.policy.skills, ...input.registry.toolCatalog.policy.skills])),
      },
    },
  }
}

export * as CloudSkillRegistry from "./skill-registry"
