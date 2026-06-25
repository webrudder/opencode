import type { JobSpec } from "./runtime"

export type ExecutionMode = "shared_session_pool" | "isolated_job_runtime" | "local_dev"

export type RunJobInput = {
  spec: JobSpec
  prompt: string
}

export type RunJobResult = {
  jobID: string
  status: "succeeded" | "failed" | "canceled" | "expired"
  error?: string
}

export type RuntimeStatus = {
  runtimeID: string
  healthy: boolean
}

export type RuntimeExecutor = {
  runJob: (input: RunJobInput) => Promise<RunJobResult>
  cancelJob: (input: { jobID: string }) => Promise<{ canceled: boolean }>
  getRuntimeStatus: (input: { runtimeID: string }) => Promise<RuntimeStatus>
  heartbeat: (input: { runtimeID: string; now: number }) => Promise<RuntimeStatus>
}

const modes = new Set<ExecutionMode>(["shared_session_pool", "isolated_job_runtime", "local_dev"])

export function mode(env: Record<string, string | undefined>) {
  const value = env.CLOUD_RUNTIME_DEPLOYMENT_MODE ?? "shared_session_pool"
  if (modes.has(value as ExecutionMode)) return value as ExecutionMode
  throw new Error(`Unsupported cloud runtime deployment mode: ${value}`)
}

export * as CloudRuntimeExecutor from "./runtime-executor"
