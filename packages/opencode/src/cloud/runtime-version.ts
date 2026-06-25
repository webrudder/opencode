type RuntimeImage = {
  version: string
  image: string
  imageDigest?: string
}

type Source = "request" | "tenant_pin" | "rollback" | "canary" | "default"

function cohort(input: string) {
  return Array.from(input).reduce((total, char) => (total * 31 + char.charCodeAt(0)) % 100, 0)
}

function resolve(input: { version: string; versions: Record<string, RuntimeImage>; source: Source }) {
  const runtime = input.versions[input.version]
  if (!runtime) throw new Error(`Unknown cloud runtime version: ${input.version}`)
  return {
    ...runtime,
    source: input.source,
  }
}

export function select(input: {
  tenantID: string
  requestVersion?: string
  tenantPinnedVersion?: string
  emergencyRollbackVersion?: string
  defaults: RuntimeImage
  canary?: {
    version: string
    percent: number
  }
  versions: Record<string, RuntimeImage>
}) {
  if (input.requestVersion) return resolve({ version: input.requestVersion, versions: input.versions, source: "request" })
  if (input.tenantPinnedVersion) {
    return resolve({ version: input.tenantPinnedVersion, versions: input.versions, source: "tenant_pin" })
  }
  if (input.emergencyRollbackVersion) {
    return resolve({ version: input.emergencyRollbackVersion, versions: input.versions, source: "rollback" })
  }
  if (input.canary && cohort(input.tenantID) < input.canary.percent) {
    return resolve({ version: input.canary.version, versions: input.versions, source: "canary" })
  }
  return {
    ...input.defaults,
    source: "default" as const,
  }
}

export * as CloudRuntimeVersion from "./runtime-version"
