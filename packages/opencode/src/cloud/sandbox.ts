import type { JobSpec } from "./runtime"
import { CloudRuntime } from "./runtime"

type Resources = {
  cpu: number
  memoryMB: number
  diskMB: number
  timeoutMS: number
}

const profiles: Record<JobSpec["runtime"]["profile"], Resources> = {
  small: {
    cpu: 1,
    memoryMB: 2048,
    diskMB: 5120,
    timeoutMS: 15 * 60 * 1000,
  },
  standard: {
    cpu: 2,
    memoryMB: 4096,
    diskMB: 10240,
    timeoutMS: 30 * 60 * 1000,
  },
  large: {
    cpu: 4,
    memoryMB: 16384,
    diskMB: 51200,
    timeoutMS: 60 * 60 * 1000,
  },
  gpu: {
    cpu: 8,
    memoryMB: 32768,
    diskMB: 102400,
    timeoutMS: 2 * 60 * 60 * 1000,
  },
}

function resources(input: { profile: JobSpec["runtime"]["profile"]; overrides?: Partial<Resources> }) {
  return {
    ...profiles[input.profile],
    ...input.overrides,
  }
}

function assertMaximum(input: { resources: Resources; maximum?: Resources }) {
  if (!input.maximum) return
  if (input.resources.cpu > input.maximum.cpu) throw new Error("Cloud sandbox cpu limit exceeded")
  if (input.resources.memoryMB > input.maximum.memoryMB) throw new Error("Cloud sandbox memory limit exceeded")
  if (input.resources.diskMB > input.maximum.diskMB) throw new Error("Cloud sandbox disk limit exceeded")
  if (input.resources.timeoutMS > input.maximum.timeoutMS) throw new Error("Cloud sandbox timeout limit exceeded")
}

export function plan(
  spec: JobSpec,
  input?: {
    isolation?: "container" | "gvisor" | "kata" | "firecracker"
    overrides?: {
      resources?: Partial<Resources>
    }
    maximum?: Resources
  },
) {
  const nextResources = resources({
    profile: spec.runtime.profile,
    overrides: input?.overrides?.resources,
  })
  assertMaximum({ resources: nextResources, maximum: input?.maximum })
  return {
    jobID: spec.id,
    tenantID: spec.tenantID,
    image: spec.runtime.image,
    ...(spec.runtime.imageDigest ? { imageDigest: spec.runtime.imageDigest } : {}),
    isolation: input?.isolation ?? "container",
    resources: nextResources,
    security: {
      runAsNonRoot: true,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
    },
    network: CloudRuntime.networkPolicy(spec),
  }
}

export * as CloudSandbox from "./sandbox"
