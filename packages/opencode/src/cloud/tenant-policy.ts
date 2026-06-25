type Model = {
  provider: string
  model: string
}

type RuntimeImage = {
  version: string
  image: string
  imageDigest?: string
}
export type ExecutionMode = "shared_session_pool" | "isolated_job_runtime" | "local_dev"
export type IntegratorRuntimePolicyUpdate = {
  defaultExecutionMode: ExecutionMode
  allowedExecutionModes: ExecutionMode[]
  maxActiveJobs: number
  maxSessions: number
  maxConcurrentJobsPerSession: number
}

type Tenant = {
  id: string
  defaultModel: Model
  allowedModels: string[]
  budget?: {
    dailyUSD?: number
    jobUSD?: number
  }
  runtime: {
    defaultVersion: string
    defaultImage: string
    defaultImageDigest?: string
    pinnedVersion?: string
    emergencyRollbackVersion?: string
  }
  tools: {
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
  rateLimits?: Record<string, { limit: number; windowMS: number }>
}

function modelKey(input: Model) {
  return `${input.provider}/${input.model}`
}

function assertPositiveInteger(input: { name: string; value: number }) {
  if (Number.isInteger(input.value) && input.value > 0) return input.value
  throw new Error(`Cloud runtime policy invalid ${input.name}: ${input.value}`)
}

function assertExecutionMode(input: unknown): ExecutionMode {
  if (input === "shared_session_pool" || input === "isolated_job_runtime" || input === "local_dev") return input
  throw new Error(`Cloud runtime policy invalid execution mode: ${String(input)}`)
}

export function assertModel(input: { tenant: Tenant; model: Model }) {
  const key = modelKey(input.model)
  if (!input.tenant.allowedModels.includes(key)) throw new Error(`Cloud tenant model denied: ${key}`)
  return input.model
}

export function budget(input: Tenant) {
  return {
    tenantBudgetUSD: input.budget?.dailyUSD,
    jobBudgetUSD: input.budget?.jobUSD,
  }
}

export function rateLimit(input: { tenant: Tenant; action: string }) {
  const policy = input.tenant.rateLimits?.[input.action]
  if (!policy) return undefined
  return {
    tenantID: input.tenant.id,
    action: input.action,
    limit: policy.limit,
    windowMS: policy.windowMS,
  }
}

export function integratorRuntimePolicy(input: {
  tenantID: string
  integratorID: string
} & IntegratorRuntimePolicyUpdate) {
  const allowedExecutionModes = input.allowedExecutionModes.map(assertExecutionMode)
  const defaultExecutionMode = assertExecutionMode(input.defaultExecutionMode)
  if (!allowedExecutionModes.includes(defaultExecutionMode)) {
    throw new Error(`Cloud runtime policy default execution mode denied: ${defaultExecutionMode}`)
  }
  return {
    tenantID: input.tenantID,
    integratorID: input.integratorID,
    defaultExecutionMode,
    allowedExecutionModes,
    maxActiveJobs: assertPositiveInteger({ name: "maxActiveJobs", value: input.maxActiveJobs }),
    maxSessions: assertPositiveInteger({ name: "maxSessions", value: input.maxSessions }),
    maxConcurrentJobsPerSession: assertPositiveInteger({
      name: "maxConcurrentJobsPerSession",
      value: input.maxConcurrentJobsPerSession,
    }),
  }
}

export function orchestrator(input: { tenant: Tenant; runtimeVersions: Record<string, RuntimeImage> }) {
  return {
    tenant: {
      id: input.tenant.id,
      defaultRuntimeVersion: input.tenant.runtime.defaultVersion,
      defaultRuntimeImage: input.tenant.runtime.defaultImage,
      defaultModel: input.tenant.defaultModel,
      allowedModels: input.tenant.allowedModels,
    },
    toolPolicy: input.tenant.tools,
    runtime: {
      defaults: {
        version: input.tenant.runtime.defaultVersion,
        image: input.tenant.runtime.defaultImage,
        ...(input.tenant.runtime.defaultImageDigest ? { imageDigest: input.tenant.runtime.defaultImageDigest } : {}),
      },
      ...(input.tenant.runtime.pinnedVersion ? { tenantPinnedVersion: input.tenant.runtime.pinnedVersion } : {}),
      ...(input.tenant.runtime.emergencyRollbackVersion
        ? { emergencyRollbackVersion: input.tenant.runtime.emergencyRollbackVersion }
        : {}),
      versions: input.runtimeVersions,
    },
  }
}

export * as CloudTenantPolicy from "./tenant-policy"
