import { CloudSchema, type AuditEvent } from "./schema"

export function event(input: {
  id: string
  tenantID: string
  userID?: string
  resourceType: string
  resourceID: string
  action: string
  time: number
}) {
  return CloudSchema.decodeAuditEvent({
    id: input.id,
    tenantID: input.tenantID,
    userID: input.userID,
    resourceType: input.resourceType,
    resourceID: input.resourceID,
    action: input.action,
    time: {
      created: input.time,
      updated: input.time,
    },
  })
}

export function filter(input: {
  events: AuditEvent[]
  userID?: string
  resourceType?: string
  resourceID?: string
  action?: string
}) {
  return input.events.filter(
    (event) =>
      (!input.userID || event.userID === input.userID) &&
      (!input.resourceType || event.resourceType === input.resourceType) &&
      (!input.resourceID || event.resourceID === input.resourceID) &&
      (!input.action || event.action === input.action),
  )
}

export * as CloudAudit from "./audit"
