import { createHmac, timingSafeEqual } from "node:crypto"
import type { JobEvent } from "./api"

type Subscription = {
  id: string
  tenantID: string
  url: string
  secretRef: string
  events: Array<JobEvent["type"] | "*">
  enabled: boolean
}

function sign(input: { secret: string; timestamp: number; body: string }) {
  return `sha256=${createHmac("sha256", input.secret).update(`${input.timestamp}.${input.body}`).digest("hex")}`
}

export function delivery(input: {
  id: string
  tenantID: string
  event: JobEvent
  secret: string
  timestamp: number
}) {
  const body = JSON.stringify({
    id: input.id,
    tenantID: input.tenantID,
    event: input.event,
  })

  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-cloud-runtime-delivery": input.id,
      "x-cloud-runtime-timestamp": input.timestamp.toString(),
      "x-cloud-runtime-signature": sign({
        secret: input.secret,
        timestamp: input.timestamp,
        body,
      }),
    },
  }
}

export function verify(input: { body: string; secret: string; timestamp: number; signature: string }) {
  const expected = Buffer.from(sign(input), "utf8")
  const actual = Buffer.from(input.signature, "utf8")
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

export function retryDelayMS(input: { attempt: number; baseDelayMS: number; maxDelayMS: number }) {
  return Math.min(input.maxDelayMS, input.baseDelayMS * 2 ** Math.max(0, input.attempt - 1))
}

export function dispatchPlan(input: {
  tenantID: string
  event: JobEvent
  subscriptions: Subscription[]
  now: number
}) {
  return input.subscriptions
    .filter((subscription) => subscription.enabled)
    .filter((subscription) => subscription.tenantID === input.tenantID)
    .filter((subscription) => subscription.events.includes("*") || subscription.events.includes(input.event.type))
    .map((subscription) => ({
      id: `${subscription.id}:${input.event.id}`,
      tenantID: input.tenantID,
      subscriptionID: subscription.id,
      url: subscription.url,
      secretRef: subscription.secretRef,
      event: input.event,
      attempt: 1,
      nextAttemptAt: input.now,
    }))
}

export * as CloudWebhook from "./webhook"
