import type { ConfigMCP } from "@/config/mcp"
import type { CloudAPI } from "./api"
import { CloudConnector } from "./connector"
import { CloudModelCredential, type Credential as LLMCredential, type Context as ModelContext } from "./model-credential"
import { CloudRuntime } from "./runtime"
import { CloudRuntimeVersion } from "./runtime-version"
import { CloudToolPolicy } from "./tool-policy"

type Tenant = {
  id: string
  defaultRuntimeVersion: string
  defaultRuntimeImage: string
  defaultModel: {
    provider: string
    model: string
  }
  allowedModels: string[]
}

type Session = {
  id: string
  workspaceID: string
  model?: {
    provider: string
    model: string
  }
}

type ToolCatalog = {
  mcp: Record<string, ConfigMCP.Info>
  skills: Record<string, string>
}

type ToolPolicy = Parameters<typeof CloudToolPolicy.apply>[0]["policy"]
type RuntimePolicy = Omit<Parameters<typeof CloudRuntimeVersion.select>[0], "tenantID" | "requestVersion">
type ConnectorGrant = ReturnType<typeof CloudConnector.grant>

function modelKey(input: { provider: string; model: string }) {
  return `${input.provider}/${input.model}`
}

function skill(input: string, path: string) {
  const [name, version = "latest"] = input.split("@")
  if (!name) throw new Error(`Invalid skill: ${input}`)
  return { name, version, path }
}

export function planJob(input: {
  id: string
  tenant: Tenant
  session: Session
  request: CloudAPI.CreateJobRequest
  tools: ToolCatalog
  toolPolicy?: ToolPolicy
  runtime?: RuntimePolicy
  connectorGrants?: Record<string, ConnectorGrant>
  modelCredentials?: LLMCredential[]
  modelContext?: ModelContext
  now?: number
}) {
  const modelSelection = input.modelCredentials?.length
    ? CloudModelCredential.select({
        context: input.modelContext ?? {},
        credentials: input.modelCredentials,
        request: input.request.model,
        sessionDefault: input.session.model,
        tenantDefault: input.tenant.defaultModel,
      })
    : undefined
  const model: { provider: string; model: string; credentialID?: string } = modelSelection
    ? { provider: modelSelection.provider, model: modelSelection.model, credentialID: modelSelection.credentialID }
    : (input.request.model ?? input.session.model ?? input.tenant.defaultModel)
  if (!modelSelection && !input.tenant.allowedModels.includes(modelKey(model))) {
    throw new Error(`Model ${modelKey(model)} is not allowed for tenant ${input.tenant.id}`)
  }
  const tools = input.toolPolicy
    ? CloudToolPolicy.apply({ request: input.request.tools, policy: input.toolPolicy })
    : input.request.tools
  const runtime = input.runtime
    ? CloudRuntimeVersion.select({
        tenantID: input.tenant.id,
        requestVersion: input.request.runtime.version,
        ...input.runtime,
      })
    : {
        version: input.request.runtime.version ?? input.tenant.defaultRuntimeVersion,
        image: input.tenant.defaultRuntimeImage,
        imageDigest: undefined,
      }

  return CloudRuntime.decodeJobSpec({
    id: input.id,
    tenantID: input.tenant.id,
    workspaceID: input.session.workspaceID,
    sessionID: input.session.id,
    runtime: {
      engine: "opencode",
      version: runtime.version,
      image: runtime.image,
      imageDigest: runtime.imageDigest,
      profile: input.request.runtime.profile,
    },
    model: {
      provider: model.provider,
      model: model.model,
      credentialID: model.credentialID,
    },
    modelConfigSnapshot: modelSelection
      ? CloudModelCredential.snapshot({ jobID: input.id, selection: modelSelection, now: input.now ?? Date.now() })
      : undefined,
    tools: {
      webfetch: tools.webfetch,
      websearch: tools.websearch,
      mcp: Object.fromEntries(
        tools.mcp.map((name) => {
          const mcp = input.tools.mcp[name]
          if (!mcp) throw new Error(`Unknown MCP server: ${name}`)
          const grant = input.connectorGrants?.[name]
          if (!grant || mcp.type !== "remote") return [name, mcp]
          return [
            name,
            {
              ...mcp,
              headers: {
                ...mcp.headers,
                ...CloudConnector.mcpHeaders({ connector: name, grant }),
              },
            },
          ]
        }),
      ),
      skills: tools.skills.map((item) => {
        const path = input.tools.skills[item]
        if (!path) throw new Error(`Unknown skill: ${item}`)
        return skill(item, path)
      }),
    },
    permissions: {
      filesystem: "workspace_only",
      shell: "restricted",
      network: ["mcp.internal", "storage.internal"],
    },
    inputs: input.request.inputs,
    outputs: input.request.outputs,
  })
}

export * as CloudOrchestrator from "./orchestrator"
