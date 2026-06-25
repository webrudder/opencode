import { describe, expect, test } from "bun:test"
import { CloudEvent } from "../../src/cloud/event"
import { CloudMetrics } from "../../src/cloud/metrics"

const job = {
  id: "job_abc",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  status: "succeeded" as const,
  runtime: { engine: "opencode" as const, version: "1.14.28", profile: "standard" as const },
  cost: {
    estimatedUSD: 0.25,
    tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 20, cacheWrite: 5 },
  },
  time: { created: 1000, updated: 5000 },
}

describe("CloudMetrics", () => {
  test("exports stable job metrics with tenant and runtime attributes", () => {
    expect(CloudMetrics.job(job)).toEqual([
      {
        name: "cloud_runtime_job_duration_ms",
        value: 4000,
        attributes: {
          tenant_id: "tenant_abc",
          workspace_id: "workspace_abc",
          session_id: "session_abc",
          job_id: "job_abc",
          job_status: "succeeded",
          runtime_engine: "opencode",
          runtime_version: "1.14.28",
          runtime_profile: "standard",
        },
      },
      {
        name: "cloud_runtime_job_cost_usd",
        value: 0.25,
        attributes: {
          tenant_id: "tenant_abc",
          workspace_id: "workspace_abc",
          session_id: "session_abc",
          job_id: "job_abc",
          job_status: "succeeded",
          runtime_engine: "opencode",
          runtime_version: "1.14.28",
          runtime_profile: "standard",
        },
      },
      {
        name: "cloud_runtime_job_tokens_total",
        value: 185,
        attributes: {
          tenant_id: "tenant_abc",
          workspace_id: "workspace_abc",
          session_id: "session_abc",
          job_id: "job_abc",
          job_status: "succeeded",
          runtime_engine: "opencode",
          runtime_version: "1.14.28",
          runtime_profile: "standard",
        },
      },
    ])
  })

  test("exports event and lease metrics", () => {
    expect(CloudMetrics.event(CloudEvent.status({ jobID: "job_abc", sequence: 1, status: "running", time: 100 }))).toEqual({
      name: "cloud_runtime_job_events_total",
      value: 1,
      attributes: {
        job_id: "job_abc",
        event_type: "job.status",
      },
    })

    expect(
      CloudMetrics.lease({
        lease: { jobID: "job_abc", workerID: "worker_abc", expiresAt: 1500, heartbeatAt: 1000 },
        now: 1200,
      }),
    ).toEqual([
      {
        name: "cloud_runtime_lease_remaining_ms",
        value: 300,
        attributes: {
          job_id: "job_abc",
          worker_id: "worker_abc",
        },
      },
      {
        name: "cloud_runtime_lease_heartbeat_age_ms",
        value: 200,
        attributes: {
          job_id: "job_abc",
          worker_id: "worker_abc",
        },
      },
    ])
  })

  test("exports autoscaling decision metrics", () => {
    expect(
      CloudMetrics.autoscale({
        tenantID: "tenant_abc",
        queue: { depth: 20, oldestQueuedAgeMS: 60_000 },
        workers: { current: 2, busy: 2 },
        decision: { desired: 5, reason: "queue_depth" },
      }),
    ).toEqual([
      {
        name: "cloud_runtime_queue_depth",
        value: 20,
        attributes: { tenant_id: "tenant_abc", scale_reason: "queue_depth" },
      },
      {
        name: "cloud_runtime_queue_oldest_age_ms",
        value: 60000,
        attributes: { tenant_id: "tenant_abc", scale_reason: "queue_depth" },
      },
      {
        name: "cloud_runtime_workers_current",
        value: 2,
        attributes: { tenant_id: "tenant_abc", scale_reason: "queue_depth" },
      },
      {
        name: "cloud_runtime_workers_busy",
        value: 2,
        attributes: { tenant_id: "tenant_abc", scale_reason: "queue_depth" },
      },
      {
        name: "cloud_runtime_workers_desired",
        value: 5,
        attributes: { tenant_id: "tenant_abc", scale_reason: "queue_depth" },
      },
    ])
  })

  test("exports metrics through an OTLP HTTP client", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null; body: Record<string, unknown> }> = []
    const result = await CloudMetrics.exportOTLP({
      endpoint: "https://otel.example/v1/metrics",
      token: "otel_token",
      serviceName: "cloud-opencode-runtime",
      timeUnixNano: 123_000_000,
      metrics: [
        {
          name: "cloud_runtime_queue_depth",
          value: 3,
          attributes: {
            tenant_id: "tenant_abc",
            scale_reason: "queue_depth",
          },
        },
      ],
      fetch: async (request, init) => {
        requests.push({
          url: String(request),
          method: init?.method ?? "GET",
          authorization: new Headers(init?.headers).get("authorization"),
          body: await new Response(init?.body).json() as Record<string, unknown>,
        })
        return new Response(JSON.stringify({ partialSuccess: {} }))
      },
    })

    expect(result).toEqual({ accepted: true, status: 200 })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: "https://otel.example/v1/metrics",
      method: "POST",
      authorization: "Bearer otel_token",
    })
    expect(requests[0].body).toMatchObject({
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "cloud-opencode-runtime" } },
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "cloud_runtime_queue_depth",
                  gauge: {
                    dataPoints: [
                      {
                        timeUnixNano: "123000000",
                        asDouble: 3,
                        attributes: [
                          { key: "tenant_id", value: { stringValue: "tenant_abc" } },
                          { key: "scale_reason", value: { stringValue: "queue_depth" } },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    })
  })

  test("returns a diagnostic error when OTLP export fails", async () => {
    await expect(
      CloudMetrics.exportOTLP({
        endpoint: "https://otel.example/v1/metrics",
        serviceName: "cloud-opencode-runtime",
        timeUnixNano: 123,
        metrics: [],
        fetch: async () => new Response("collector unavailable", { status: 503 }),
      }),
    ).rejects.toThrow("Cloud metrics OTLP export failed: 503 collector unavailable")
  })
})
