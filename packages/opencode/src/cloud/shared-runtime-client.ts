import { CloudArtifact, type Manifest } from "./artifact"
import type { CloudWorker } from "./worker"

type Fetcher = (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Result =
  | {
      status: "succeeded"
      manifest: Manifest
      sizeByPath: Record<string, number>
    }
  | {
      status: "failed"
      message: string
      runtimeUnavailable?: true
    }

function record(input: unknown) {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) return input as Record<string, unknown>
  return {}
}

function sizes(input: unknown) {
  return Object.fromEntries(
    Object.entries(record(input)).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  )
}

function endpoint(input: string) {
  return `${input.replace(/\/+$/, "")}/v1/runtime/jobs`
}

function secretValues(input: CloudWorker.LaunchPlan) {
  return Object.entries(input.env)
    .filter(([key, value]) => key.endsWith("_API_KEY") && value)
    .map((entry) => entry[1])
}

function redactMessage(input: { message: string; launch: CloudWorker.LaunchPlan }) {
  return secretValues(input.launch).reduce(
    (message, value) => message.replaceAll(value, "[redacted]"),
    input.message.replaceAll(/([A-Z0-9_]*API_KEY=)[^\s,;]+/g, "$1[redacted]"),
  )
}

export function create(input?: { fetch?: Fetcher }) {
  const fetcher = input?.fetch ?? fetch
  return {
    async runJob(request: {
      endpoint: string
      runtimeID: string
      jobID: string
      launch: CloudWorker.LaunchPlan
    }): Promise<Result> {
      const result = await fetcher(endpoint(request.endpoint), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtimeID: request.runtimeID,
          jobID: request.jobID,
          launch: request.launch,
        }),
      }).catch((error) => new Response(error instanceof Error ? error.message : String(error), { status: 503 }))
      if (!result.ok) {
        return {
          status: "failed",
          message: redactMessage({
            message: `Shared runtime ${request.runtimeID} POST /v1/runtime/jobs failed: ${result.status} ${await result.text()}`,
            launch: request.launch,
          }),
          runtimeUnavailable: true,
        }
      }
      const body = record(await result.json())
      if (body.status === "failed") {
        return {
          status: "failed",
          message: typeof body.message === "string" ? body.message : "Shared runtime job failed",
        }
      }
      return {
        status: "succeeded",
        manifest: CloudArtifact.decodeManifestForJob(request.jobID, body.manifest),
        sizeByPath: sizes(body.sizeByPath),
      }
    },
  }
}

export * as CloudSharedRuntimeClient from "./shared-runtime-client"
