import type { JobEvent } from "./api"
import type { Lease } from "./lease"
import type { Job } from "./schema"

export type MetricPoint = {
  name: string
  value: number
  attributes: Record<string, string>
}
type Fetcher = (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function jobAttributes(input: Job) {
  return {
    tenant_id: input.tenantID,
    workspace_id: input.workspaceID,
    session_id: input.sessionID,
    job_id: input.id,
    job_status: input.status,
    runtime_engine: input.runtime.engine,
    runtime_version: input.runtime.version,
    runtime_profile: input.runtime.profile,
  }
}

export function job(input: Job): MetricPoint[] {
  return [
    {
      name: "cloud_runtime_job_duration_ms",
      value: input.time.updated - input.time.created,
      attributes: jobAttributes(input),
    },
    {
      name: "cloud_runtime_job_cost_usd",
      value: input.cost.estimatedUSD,
      attributes: jobAttributes(input),
    },
    {
      name: "cloud_runtime_job_tokens_total",
      value:
        input.cost.tokens.input +
        input.cost.tokens.output +
        input.cost.tokens.reasoning +
        input.cost.tokens.cacheRead +
        input.cost.tokens.cacheWrite,
      attributes: jobAttributes(input),
    },
  ]
}

export function event(input: JobEvent): MetricPoint {
  return {
    name: "cloud_runtime_job_events_total",
    value: 1,
    attributes: {
      job_id: input.jobID,
      event_type: input.type,
    },
  }
}

export function lease(input: { lease: Lease; now: number }): MetricPoint[] {
  return [
    {
      name: "cloud_runtime_lease_remaining_ms",
      value: Math.max(0, input.lease.expiresAt - input.now),
      attributes: {
        job_id: input.lease.jobID,
        worker_id: input.lease.workerID,
      },
    },
    {
      name: "cloud_runtime_lease_heartbeat_age_ms",
      value: Math.max(0, input.now - input.lease.heartbeatAt),
      attributes: {
        job_id: input.lease.jobID,
        worker_id: input.lease.workerID,
      },
    },
  ]
}

export function autoscale(input: {
  tenantID: string
  queue: {
    depth: number
    oldestQueuedAgeMS: number
  }
  workers: {
    current: number
    busy: number
  }
  decision: {
    desired: number
    reason: string
  }
}): MetricPoint[] {
  const attributes = {
    tenant_id: input.tenantID,
    scale_reason: input.decision.reason,
  }
  return [
    {
      name: "cloud_runtime_queue_depth",
      value: input.queue.depth,
      attributes,
    },
    {
      name: "cloud_runtime_queue_oldest_age_ms",
      value: input.queue.oldestQueuedAgeMS,
      attributes,
    },
    {
      name: "cloud_runtime_workers_current",
      value: input.workers.current,
      attributes,
    },
    {
      name: "cloud_runtime_workers_busy",
      value: input.workers.busy,
      attributes,
    },
    {
      name: "cloud_runtime_workers_desired",
      value: input.decision.desired,
      attributes,
    },
  ]
}

function stringAttribute(input: { key: string; value: string }) {
  return {
    key: input.key,
    value: { stringValue: input.value },
  }
}

export function otlp(input: {
  serviceName: string
  timeUnixNano: number
  metrics: MetricPoint[]
}) {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            stringAttribute({ key: "service.name", value: input.serviceName }),
          ],
        },
        scopeMetrics: [
          {
            scope: {
              name: "cloud-opencode-runtime",
            },
            metrics: input.metrics.map((item) => ({
              name: item.name,
              gauge: {
                dataPoints: [
                  {
                    timeUnixNano: String(input.timeUnixNano),
                    asDouble: item.value,
                    attributes: Object.entries(item.attributes).map(([key, value]) => stringAttribute({ key, value })),
                  },
                ],
              },
            })),
          },
        ],
      },
    ],
  }
}

export async function exportOTLP(input: {
  endpoint: string
  token?: string
  serviceName: string
  timeUnixNano: number
  metrics: MetricPoint[]
  fetch?: Fetcher
}) {
  const response = await (input.fetch ?? fetch)(input.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    },
    body: JSON.stringify(otlp(input)),
  })
  if (!response.ok) throw new Error(`Cloud metrics OTLP export failed: ${response.status} ${await response.text()}`)
  return {
    accepted: true,
    status: response.status,
  }
}

export * as CloudMetrics from "./metrics"
