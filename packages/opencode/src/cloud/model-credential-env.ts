import type { JobSpec } from "./runtime"

type Snapshot = NonNullable<JobSpec["modelConfigSnapshot"]>
type ResolveSecret = (secretRef: string, snapshot: Snapshot) => Promise<string | undefined> | string | undefined

export function envName(input: { provider: string; providerType: string }) {
  if (input.provider === "anthropic" || input.providerType === "anthropic") return "ANTHROPIC_API_KEY"
  if (
    input.provider === "openai" ||
    input.provider === "openai-compatible" ||
    input.providerType === "openai" ||
    input.providerType === "openai-compatible"
  ) return "OPENAI_API_KEY"
  return `${input.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`
}

function baseURLEnvName(input: { provider: string; providerType: string }) {
  if (
    input.provider === "openai" ||
    input.provider === "openai-compatible" ||
    input.providerType === "openai" ||
    input.providerType === "openai-compatible"
  ) return "OPENAI_BASE_URL"
  return undefined
}

export async function resolve(input: {
  snapshot?: Snapshot
  resolveSecret: ResolveSecret
}) {
  if (!input.snapshot) {
    return {
      env: {},
      evidence: undefined,
    }
  }
  const secret = await input.resolveSecret(input.snapshot.secretRef, input.snapshot)
  if (!secret) throw new Error(`model_credential_secret_missing: ${input.snapshot.secretRef}`)
  const key = envName(input.snapshot)
  const baseURLKey = input.snapshot.baseURL ? baseURLEnvName(input.snapshot) : undefined
  const env = {
    [key]: secret,
    ...(baseURLKey && input.snapshot.baseURL ? { [baseURLKey]: input.snapshot.baseURL } : {}),
  }
  return {
    env,
    evidence: {
      credentialID: input.snapshot.credentialID,
      credentialVersion: input.snapshot.credentialVersion,
      provider: input.snapshot.provider,
      model: input.snapshot.model,
      envKeys: Object.keys(env).toSorted(),
    },
  }
}

function secretEnvName(input: string) {
  return `CLOUD_RUNTIME_MODEL_SECRET_${input.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
}

export function envSecretResolver(input?: { env?: Record<string, string | undefined> }): ResolveSecret {
  const env = input?.env ?? Bun.env
  return (secretRef) => env[secretEnvName(secretRef)]
}

export * as CloudModelCredentialEnv from "./model-credential-env"
