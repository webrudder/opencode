import { describe, expect, test } from "bun:test"
import { CloudEvent } from "../../src/cloud/event"
import { CloudWebhook } from "../../src/cloud/webhook"

const event = CloudEvent.status({
  jobID: "job_abc",
  sequence: 1,
  status: "succeeded",
  time: 1_700_000_000,
})

describe("CloudWebhook", () => {
  test("builds a stable signed delivery", () => {
    expect(
      CloudWebhook.delivery({
        id: "delivery_abc",
        tenantID: "tenant_abc",
        event,
        secret: "secret_abc",
        timestamp: 1_700_000_000,
      }),
    ).toEqual({
      body: JSON.stringify({
        id: "delivery_abc",
        tenantID: "tenant_abc",
        event,
      }),
      headers: {
        "content-type": "application/json",
        "x-cloud-runtime-delivery": "delivery_abc",
        "x-cloud-runtime-timestamp": "1700000000",
        "x-cloud-runtime-signature": "sha256=8f578d179d685d14578712e3ec534ab123cc5308e1ec74910094ee14b6fdac5b",
      },
    })
  })

  test("verifies webhook signatures", () => {
    const delivery = CloudWebhook.delivery({
      id: "delivery_abc",
      tenantID: "tenant_abc",
      event,
      secret: "secret_abc",
      timestamp: 1_700_000_000,
    })

    expect(
      CloudWebhook.verify({
        body: delivery.body,
        secret: "secret_abc",
        timestamp: 1_700_000_000,
        signature: delivery.headers["x-cloud-runtime-signature"],
      }),
    ).toBe(true)
    expect(
      CloudWebhook.verify({
        body: delivery.body,
        secret: "wrong",
        timestamp: 1_700_000_000,
        signature: delivery.headers["x-cloud-runtime-signature"],
      }),
    ).toBe(false)
  })

  test("plans bounded exponential retry delays", () => {
    expect(CloudWebhook.retryDelayMS({ attempt: 1, baseDelayMS: 1000, maxDelayMS: 30_000 })).toBe(1000)
    expect(CloudWebhook.retryDelayMS({ attempt: 4, baseDelayMS: 1000, maxDelayMS: 30_000 })).toBe(8000)
    expect(CloudWebhook.retryDelayMS({ attempt: 10, baseDelayMS: 1000, maxDelayMS: 30_000 })).toBe(30_000)
  })

  test("plans webhook dispatches for enabled matching subscriptions", () => {
    expect(
      CloudWebhook.dispatchPlan({
        tenantID: "tenant_abc",
        event,
        subscriptions: [
          {
            id: "webhook_abc",
            tenantID: "tenant_abc",
            url: "https://saas.example.com/hooks/runtime",
            secretRef: "secret/webhook/abc",
            events: ["job.status", "job.artifact"],
            enabled: true,
          },
          {
            id: "webhook_disabled",
            tenantID: "tenant_abc",
            url: "https://saas.example.com/hooks/disabled",
            secretRef: "secret/webhook/disabled",
            events: ["job.status"],
            enabled: false,
          },
          {
            id: "webhook_other",
            tenantID: "tenant_other",
            url: "https://saas.example.com/hooks/other",
            secretRef: "secret/webhook/other",
            events: ["job.status"],
            enabled: true,
          },
        ],
        now: 100,
      }),
    ).toEqual([
      {
        id: "webhook_abc:job_abc:000000000001",
        tenantID: "tenant_abc",
        subscriptionID: "webhook_abc",
        url: "https://saas.example.com/hooks/runtime",
        secretRef: "secret/webhook/abc",
        event,
        attempt: 1,
        nextAttemptAt: 100,
      },
    ])
  })

  test("supports wildcard webhook subscriptions without leaking disabled endpoints", () => {
    expect(
      CloudWebhook.dispatchPlan({
        tenantID: "tenant_abc",
        event,
        subscriptions: [
          {
            id: "webhook_all",
            tenantID: "tenant_abc",
            url: "https://saas.example.com/hooks/all",
            secretRef: "secret/webhook/all",
            events: ["*"],
            enabled: true,
          },
        ],
        now: 100,
      }).map((item) => item.subscriptionID),
    ).toEqual(["webhook_all"])
  })
})
