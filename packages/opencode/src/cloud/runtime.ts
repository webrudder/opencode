import { Schema } from "effect"
import type { Config } from "@/config/config"
import { ConfigMCP } from "@/config/mcp"
import { withStatics } from "@/util/schema"
import { zod } from "@/util/effect-zod"

const RuntimeProfile = Schema.Literals(["small", "standard", "large", "gpu"])
const OutputKind = Schema.Literals(["csv", "xlsx", "png", "html", "md", "pdf", "json"])

const Runtime = Schema.Struct({
  engine: Schema.Literal("opencode"),
  version: Schema.String,
  image: Schema.String,
  imageDigest: Schema.optional(Schema.String),
  profile: RuntimeProfile,
})

const Model = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  credentialID: Schema.optional(Schema.String),
  maxTokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  budgetUSD: Schema.optional(Schema.Number),
})

const ModelConfigSnapshot = Schema.Struct({
  jobID: Schema.String,
  credentialID: Schema.String,
  credentialVersion: Schema.Number,
  providerType: Schema.String,
  provider: Schema.String,
  baseURL: Schema.optional(Schema.String),
  secretRef: Schema.String,
  model: Schema.String,
  time: Schema.Struct({
    created: Schema.Number,
    updated: Schema.Number,
  }),
})

const WebFetch = Schema.Struct({
  enabled: Schema.Boolean,
  allowDomains: Schema.Array(Schema.String),
})

const WebSearch = Schema.Struct({
  enabled: Schema.Boolean,
  provider: Schema.optional(Schema.String),
})

const Skill = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  path: Schema.String,
})

const Tools = Schema.Struct({
  webfetch: WebFetch,
  websearch: WebSearch,
  mcp: Schema.Record(Schema.String, ConfigMCP.Info),
  skills: Schema.Array(Skill),
})

const Permissions = Schema.Struct({
  filesystem: Schema.Literals(["workspace_only", "read_only"]),
  shell: Schema.Literals(["disabled", "restricted", "allow"]),
  network: Schema.Array(Schema.String),
})

export const JobStatus = Schema.Literals([
  "queued",
  "leasing",
  "starting",
  "running",
  "uploading",
  "succeeded",
  "failed",
  "canceled",
  "expired",
])
  .annotate({ identifier: "CloudRuntimeJobStatus" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type JobStatus = Schema.Schema.Type<typeof JobStatus>

export const JobSpec = Schema.Struct({
  id: Schema.String,
  tenantID: Schema.String,
  workspaceID: Schema.String,
  sessionID: Schema.String,
  runtime: Runtime,
  model: Model,
  modelConfigSnapshot: Schema.optional(ModelConfigSnapshot),
  tools: Tools,
  permissions: Permissions,
  inputs: Schema.Array(Schema.String),
  outputs: Schema.Array(OutputKind),
})
  .annotate({ identifier: "CloudRuntimeJobSpec" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type JobSpec = Schema.Schema.Type<typeof JobSpec>

export function decodeJobSpec(input: unknown) {
  return Schema.decodeUnknownSync(JobSpec)(input)
}

function webfetchPermission(input: JobSpec) {
  return input.tools.webfetch.enabled ? "allow" : "deny"
}

function shellPermission(input: JobSpec) {
  if (input.permissions.shell === "allow") return { "*": "allow" as const }
  if (input.permissions.shell === "restricted") return { "*": "ask" as const }
  return { "*": "deny" as const }
}

function filesystemPermission(input: JobSpec) {
  if (input.permissions.filesystem === "read_only") {
    return {
      read: { "*": "allow" as const },
      edit: { "*": "deny" as const },
      external_directory: { "*": "deny" as const },
    }
  }
  return {
    read: { "*": "allow" as const },
    edit: { "*": "allow" as const },
    external_directory: { "*": "deny" as const },
  }
}

export function opencodeConfig(input: JobSpec): Partial<Config.Info> {
  return {
    autoupdate: false,
    model: `${input.model.provider}/${input.model.model}`,
    ...(input.modelConfigSnapshot
      ? {
          provider: {
            [input.model.provider]: {
              ...(input.modelConfigSnapshot.baseURL
                ? {
                    options: {
                      baseURL: input.modelConfigSnapshot.baseURL,
                    },
                  }
                : {}),
              models: {
                [input.model.model]: {
                  id: input.modelConfigSnapshot.model,
                  name: input.model.model,
                  tool_call: true,
                  temperature: true,
                  limit: {
                    context: 200_000,
                    output: input.model.maxTokens ?? 8_192,
                  },
                },
              },
            },
          },
        }
      : {}),
    mcp: input.tools.mcp,
    permission: {
      ...filesystemPermission(input),
      bash: shellPermission(input),
      webfetch: webfetchPermission(input),
      websearch: input.tools.websearch.enabled ? "allow" : "deny",
    },
    skills: {
      paths: input.tools.skills.map((item) => item.path),
    },
    tool_output: {
      max_bytes: 1024 * 1024,
      max_lines: 4000,
    },
  }
}

export function networkPolicy(input: JobSpec) {
  return {
    allowHosts: Array.from(new Set([...input.permissions.network, ...input.tools.webfetch.allowDomains])).toSorted(),
  }
}

function parseAttributes(input: string | undefined) {
  if (!input) return {}
  return Object.fromEntries(
    input
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .flatMap((entry) => {
        const index = entry.indexOf("=")
        if (index < 1) return []
        return [[entry.slice(0, index), entry.slice(index + 1)]]
      }),
  )
}

function formatAttributes(input: Record<string, string>) {
  return Object.entries(input)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(",")
}

export function opencodeEnvironment(input: JobSpec, base?: Record<string, string | undefined>) {
  const attrs = {
    ...parseAttributes(base?.OTEL_RESOURCE_ATTRIBUTES),
    "tenant.id": input.tenantID,
    "workspace.id": input.workspaceID,
    "session.id": input.sessionID,
    "job.id": input.id,
    "runtime.engine": input.runtime.engine,
    "runtime.version": input.runtime.version,
    "runtime.profile": input.runtime.profile,
    ...(input.runtime.imageDigest ? { "container.image.digest": input.runtime.imageDigest } : {}),
  }

  return {
    OPENCODE_CLIENT: "cloud-runtime",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_RUNTIME_JOB_ID: input.id,
    OPENCODE_RUNTIME_TENANT_ID: input.tenantID,
    OPENCODE_RUNTIME_SESSION_ID: input.sessionID,
    OPENCODE_RUNTIME_WORKSPACE_ID: input.workspaceID,
    OPENCODE_RUNTIME_VERSION: input.runtime.version,
    OTEL_RESOURCE_ATTRIBUTES: formatAttributes(attrs),
  }
}

export * as CloudRuntime from "./runtime"
