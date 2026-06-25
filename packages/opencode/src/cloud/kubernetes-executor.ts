import pathModule from "path"
import { mkdir } from "fs/promises"
import { CloudKubernetes } from "./kubernetes"
import { CloudArtifact } from "./artifact"
import type { CloudWorker } from "./worker"

type LaunchPlan = CloudWorker.LaunchPlan
type StartOperation = ReturnType<typeof start>[number]
type LogsOperation = ReturnType<typeof logs>
type StopOperation = ReturnType<typeof stop>[number]
type ScaleDeploymentOperation = ReturnType<typeof scaleDeployment>
type Operation = StartOperation | LogsOperation | StopOperation | ScaleDeploymentOperation
type PodStatus = {
  phase?: string
  exitCode?: number
  reason?: string
}
type LogArtifactBundle = {
  manifest: CloudArtifact.Manifest
  sizeByPath: Record<string, number>
}
type Fetcher = (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const LogArtifactPrefix = "::cloud-runtime-artifacts"

export type Client = {
  applyNetworkPolicy(input: {
    namespace: string
    name: string
    manifest: ReturnType<typeof CloudKubernetes.networkPolicy>
  }): Promise<{ name: string }>
  createPod(input: {
    namespace: string
    name: string
    manifest: ReturnType<typeof CloudKubernetes.pod>
  }): Promise<{ name: string }>
  watchPod(input: {
    namespace: string
    name: string
    until: readonly string[]
  }): Promise<PodStatus>
  logs(input: {
    namespace: string
    name: string
    container: string
    sinceTime?: number
  }): Promise<{ text: string }>
  deletePod(input: {
    namespace: string
    name: string
    propagationPolicy: "Background"
    gracePeriodSeconds: number
  }): Promise<{ name: string }>
  deleteNetworkPolicy(input: {
    namespace: string
    name: string
    propagationPolicy: "Background"
  }): Promise<{ name: string }>
  patchDeploymentScale(input: {
    namespace: string
    name: string
    replicas: number
  }): Promise<{ name: string; replicas: number }>
}

function name(input: string) {
  const result = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
  return result || "job"
}

function podName(input: string) {
  return `opencode-${name(input)}`
}

function networkPolicyName(input: string) {
  return `${podName(input)}-egress`
}

function record(input: unknown) {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) return input as Record<string, unknown>
  return {}
}

function path(input: string) {
  return encodeURIComponent(input)
}

function podStatus(input: unknown): PodStatus {
  const pod = record(input)
  const statusRecord = record(pod.status)
  const container = Array.isArray(statusRecord.containerStatuses) ? record(statusRecord.containerStatuses[0]) : {}
  const terminated = record(record(container.state).terminated)
  const phase = typeof statusRecord.phase === "string" ? statusRecord.phase : undefined
  const exitCode = typeof terminated.exitCode === "number" ? terminated.exitCode : undefined
  const reason = typeof terminated.reason === "string" ? terminated.reason : undefined
  return {
    ...(phase ? { phase } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(reason ? { reason } : {}),
  }
}

function headers(input: { token?: string; contentType?: string }) {
  return {
    ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    ...(input.contentType ? { "content-type": input.contentType } : {}),
  }
}

function logArtifactPayload(input: string) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(LogArtifactPrefix))
    ?.slice(LogArtifactPrefix.length)
}

function stringField(input: unknown, name: string) {
  const result = record(input)[name]
  if (typeof result === "string") return result
  throw new Error(`Kubernetes log artifact ${name} must be a string`)
}

async function materializeLogArtifacts(input: {
  jobID: string
  logs: string
  workdir: string
  artifactManifest: string
}): Promise<LogArtifactBundle | undefined> {
  const payload = logArtifactPayload(input.logs)
  if (!payload) return undefined
  const parsed = record(JSON.parse(payload))
  const manifest = CloudArtifact.decodeManifestForJob(input.jobID, parsed.manifest)
  const allowed = new Set(manifest.artifacts.map((artifact) => artifact.path))
  const files = Array.isArray(parsed.files) ? parsed.files : []
  await mkdir(pathModule.dirname(input.artifactManifest), { recursive: true })
  await Bun.write(input.artifactManifest, JSON.stringify(manifest))
  return {
    manifest,
    sizeByPath: Object.fromEntries(
      await Promise.all(
        files.map(async (file) => {
          const artifactPath = stringField(file, "path")
          if (!allowed.has(artifactPath)) throw new Error(`Kubernetes log artifact file not declared in manifest: ${artifactPath}`)
          const body = new Uint8Array(Buffer.from(stringField(file, "contentBase64"), "base64"))
          await mkdir(pathModule.dirname(pathModule.join(input.workdir, artifactPath)), { recursive: true })
          await Bun.write(pathModule.join(input.workdir, artifactPath), body)
          return [artifactPath, body.byteLength] as const
        }),
      ),
    ),
  }
}

async function response(input: {
  fetch: Fetcher
  serverURL: string
  token?: string
  method: string
  path: string
  query?: URLSearchParams
  body?: unknown
  contentType?: string
}) {
  const url = `${input.serverURL.replace(/\/+$/, "")}${input.path}${input.query?.size ? `?${input.query}` : ""}`
  const result = await input.fetch(url, {
    method: input.method,
    headers: headers({ token: input.token, contentType: input.contentType }),
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })
  if (result.ok) return result
  throw new Error(`Kubernetes ${input.method} ${input.path} failed: ${result.status} ${await result.text()}`)
}

export function start(input: {
  namespace: string
  launch: LaunchPlan
  serviceAccountName?: string
  labels?: Record<string, string>
}) {
  return [
    {
      action: "apply" as const,
      resource: "network_policy" as const,
      manifest: CloudKubernetes.networkPolicy({
        namespace: input.namespace,
        launch: input.launch,
        labels: input.labels,
      }),
    },
    {
      action: "create" as const,
      resource: "pod" as const,
      manifest: CloudKubernetes.pod({
        namespace: input.namespace,
        launch: input.launch,
        serviceAccountName: input.serviceAccountName,
        labels: input.labels,
      }),
    },
    {
      action: "watch" as const,
      resource: "pod" as const,
      namespace: input.namespace,
      name: podName(input.launch.sandbox.jobID),
      until: ["Succeeded", "Failed"],
    },
  ]
}

export function logs(input: { namespace: string; jobID: string; container?: string; sinceTime?: number }) {
  return {
    action: "logs" as const,
    resource: "pod" as const,
    namespace: input.namespace,
    name: podName(input.jobID),
    container: input.container ?? "opencode",
    ...(input.sinceTime ? { sinceTime: input.sinceTime } : {}),
  }
}

export function stop(input: { namespace: string; jobID: string; gracePeriodSeconds?: number }) {
  return [
    {
      action: "delete" as const,
      resource: "pod" as const,
      namespace: input.namespace,
      name: podName(input.jobID),
      propagationPolicy: "Background" as const,
      gracePeriodSeconds: input.gracePeriodSeconds ?? 5,
    },
    {
      action: "delete" as const,
      resource: "network_policy" as const,
      namespace: input.namespace,
      name: networkPolicyName(input.jobID),
      propagationPolicy: "Background" as const,
    },
  ]
}

export function scaleDeployment(input: {
  namespace: string
  name: string
  replicas: number
}) {
  return {
    action: "patch" as const,
    resource: "deployment_scale" as const,
    namespace: input.namespace,
    name: input.name,
    replicas: input.replicas,
  }
}

export function status(input: {
  phase?: string
  exitCode?: number
  reason?: string
}) {
  if (input.phase === "Succeeded" && input.exitCode === 0) return "succeeded" as const
  if (input.phase === "Failed" || (input.exitCode !== undefined && input.exitCode !== 0)) return "failed" as const
  if (input.reason === "DeadlineExceeded") return "expired" as const
  return "running" as const
}

async function execute(input: { client: Client; operation: Operation }) {
  if (input.operation.action === "apply") {
    const result = await input.client.applyNetworkPolicy({
      namespace: input.operation.manifest.metadata.namespace,
      name: input.operation.manifest.metadata.name,
      manifest: input.operation.manifest,
    })
    return {
      action: input.operation.action,
      resource: input.operation.resource,
      name: result.name,
    }
  }
  if (input.operation.action === "create") {
    const result = await input.client.createPod({
      namespace: input.operation.manifest.metadata.namespace,
      name: input.operation.manifest.metadata.name,
      manifest: input.operation.manifest,
    })
    return {
      action: input.operation.action,
      resource: input.operation.resource,
      name: result.name,
    }
  }
  if (input.operation.action === "watch") {
    const result = await input.client.watchPod({
      namespace: input.operation.namespace,
      name: input.operation.name,
      until: input.operation.until,
    })
    return {
      action: input.operation.action,
      resource: input.operation.resource,
      name: input.operation.name,
      podStatus: result,
      jobStatus: status(result),
    }
  }
  if (input.operation.action === "logs") {
    const result = await input.client.logs({
      namespace: input.operation.namespace,
      name: input.operation.name,
      container: input.operation.container,
      ...(input.operation.sinceTime ? { sinceTime: input.operation.sinceTime } : {}),
    })
    return {
      action: input.operation.action,
      resource: input.operation.resource,
      name: input.operation.name,
      text: result.text,
    }
  }
  if (input.operation.resource === "deployment_scale") {
    const result = await input.client.patchDeploymentScale({
      namespace: input.operation.namespace,
      name: input.operation.name,
      replicas: input.operation.replicas,
    })
    return {
      action: input.operation.action,
      resource: input.operation.resource,
      name: result.name,
      replicas: result.replicas,
    }
  }
  if (input.operation.resource === "pod") {
    const result = await input.client.deletePod({
      namespace: input.operation.namespace,
      name: input.operation.name,
      propagationPolicy: input.operation.propagationPolicy,
      gracePeriodSeconds: input.operation.gracePeriodSeconds,
    })
    return {
      action: input.operation.action,
      resource: input.operation.resource,
      name: result.name,
    }
  }
  const result = await input.client.deleteNetworkPolicy({
    namespace: input.operation.namespace,
    name: input.operation.name,
    propagationPolicy: input.operation.propagationPolicy,
  })
  return {
    action: input.operation.action,
    resource: input.operation.resource,
    name: result.name,
  }
}

export async function run(input: { client: Client; operations: Operation[] }) {
  return input.operations.reduce(
    async (results, operation) => [...await results, await execute({ client: input.client, operation })],
    Promise.resolve([] as Awaited<ReturnType<typeof execute>>[]),
  )
}

export async function runSandbox(input: {
  namespace: string
  launch: LaunchPlan
  client: Client
  serviceAccountName?: string
  labels?: Record<string, string>
}) {
  try {
    const startResults = await run({
      client: input.client,
      operations: start({
        namespace: input.namespace,
        launch: input.launch,
        serviceAccountName: input.serviceAccountName,
        labels: input.labels,
      }),
    })
    const logResults = await run({
      client: input.client,
      operations: [logs({ namespace: input.namespace, jobID: input.launch.sandbox.jobID })],
    })
    const watchResult = startResults.find((result) => result.action === "watch")
    const logResult = logResults.find((result) => result.action === "logs")
    const artifacts = logResult?.action === "logs" && watchResult?.action === "watch" && watchResult.jobStatus === "succeeded"
      ? await materializeLogArtifacts({
        jobID: input.launch.sandbox.jobID,
        logs: logResult.text,
        workdir: input.launch.cwd,
        artifactManifest: input.launch.artifactManifest,
      })
      : undefined
    return {
      jobID: input.launch.sandbox.jobID,
      podName: podName(input.launch.sandbox.jobID),
      status: watchResult?.action === "watch" ? watchResult.jobStatus : "failed",
      logs: logResult?.action === "logs" ? logResult.text : "",
      podStatus: watchResult?.action === "watch" ? watchResult.podStatus : {},
      ...(artifacts ? { manifest: artifacts.manifest, sizeByPath: artifacts.sizeByPath } : {}),
    }
  } finally {
    await run({
      client: input.client,
      operations: stop({ namespace: input.namespace, jobID: input.launch.sandbox.jobID }),
    }).catch(() => [])
  }
}

export function fetchClient(input: {
  serverURL: string
  token?: string
  fetch?: Fetcher
  pollIntervalMS?: number
  maxPolls?: number
}): Client {
  const fetcher = input.fetch ?? fetch
  const base = {
    fetch: fetcher,
    serverURL: input.serverURL,
    token: input.token,
  }

  async function watchPod(inputRequest: { namespace: string; name: string; until: readonly string[] }, attempt: number): Promise<PodStatus> {
    if (attempt > (input.maxPolls ?? 120)) throw new Error(`Kubernetes pod ${inputRequest.name} did not reach ${inputRequest.until.join(",")}`)
    const current = podStatus(
      await (await response({
        ...base,
        method: "GET",
        path: `/api/v1/namespaces/${path(inputRequest.namespace)}/pods/${path(inputRequest.name)}`,
      })).json(),
    )
    if (current.phase && inputRequest.until.includes(current.phase)) return current
    if ((input.pollIntervalMS ?? 1_000) > 0) await Bun.sleep(input.pollIntervalMS ?? 1_000)
    return watchPod(inputRequest, attempt + 1)
  }

  return {
    async applyNetworkPolicy(inputRequest) {
      await response({
        ...base,
        method: "PATCH",
        path: `/apis/networking.k8s.io/v1/namespaces/${path(inputRequest.namespace)}/networkpolicies/${path(inputRequest.name)}`,
        query: new URLSearchParams({
          fieldManager: "cloud-opencode-runtime",
          force: "true",
        }),
        body: inputRequest.manifest,
        contentType: "application/apply-patch+yaml",
      })
      return { name: inputRequest.name }
    },
    async createPod(inputRequest) {
      await response({
        ...base,
        method: "POST",
        path: `/api/v1/namespaces/${path(inputRequest.namespace)}/pods`,
        body: inputRequest.manifest,
        contentType: "application/json",
      })
      return { name: inputRequest.name }
    },
    async watchPod(inputRequest) {
      return watchPod(inputRequest, 1)
    },
    async logs(inputRequest) {
      const query = new URLSearchParams({
        container: inputRequest.container,
      })
      if (inputRequest.sinceTime) query.set("sinceTime", new Date(inputRequest.sinceTime).toISOString())
      return {
        text: await (await response({
          ...base,
          method: "GET",
          path: `/api/v1/namespaces/${path(inputRequest.namespace)}/pods/${path(inputRequest.name)}/log`,
          query,
        })).text(),
      }
    },
    async deletePod(inputRequest) {
      await response({
        ...base,
        method: "DELETE",
        path: `/api/v1/namespaces/${path(inputRequest.namespace)}/pods/${path(inputRequest.name)}`,
        body: {
          propagationPolicy: inputRequest.propagationPolicy,
          gracePeriodSeconds: inputRequest.gracePeriodSeconds,
        },
        contentType: "application/json",
      })
      return { name: inputRequest.name }
    },
    async deleteNetworkPolicy(inputRequest) {
      await response({
        ...base,
        method: "DELETE",
        path: `/apis/networking.k8s.io/v1/namespaces/${path(inputRequest.namespace)}/networkpolicies/${path(inputRequest.name)}`,
        body: {
          propagationPolicy: inputRequest.propagationPolicy,
        },
        contentType: "application/json",
      })
      return { name: inputRequest.name }
    },
    async patchDeploymentScale(inputRequest) {
      await response({
        ...base,
        method: "PATCH",
        path: `/apis/apps/v1/namespaces/${path(inputRequest.namespace)}/deployments/${path(inputRequest.name)}/scale`,
        body: {
          spec: {
            replicas: inputRequest.replicas,
          },
        },
        contentType: "application/merge-patch+json",
      })
      return { name: inputRequest.name, replicas: inputRequest.replicas }
    },
  }
}

export * as CloudKubernetesExecutor from "./kubernetes-executor"
