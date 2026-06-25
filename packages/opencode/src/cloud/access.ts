type TenantResource = {
  id?: string
  tenantID?: string
}

type UserResource = TenantResource & {
  userID?: string
}

export function assertTenant<T extends TenantResource>(input: { tenantID: string; resource: T }) {
  if (!input.resource.tenantID) throw new Error("Cloud resource is missing tenant ownership")
  if (input.resource.tenantID !== input.tenantID) {
    throw new Error(`Cloud resource tenant mismatch: ${input.resource.tenantID} !== ${input.tenantID}`)
  }
  return input.resource as T & { tenantID: string }
}

export function filterTenant<T extends TenantResource>(input: { tenantID: string; resources: T[] }) {
  return input.resources.filter((resource): resource is T & { tenantID: string } => resource.tenantID === input.tenantID)
}

export function assertUser<T extends UserResource>(input: { tenantID: string; userID: string; resource: T }) {
  const resource = assertTenant(input)
  if (!resource.userID) throw new Error("Cloud resource is missing user ownership")
  if (resource.userID !== input.userID) {
    throw new Error(`Cloud resource user mismatch: ${resource.userID} !== ${input.userID}`)
  }
  return resource as T & { tenantID: string; userID: string }
}

export * as CloudAccess from "./access"
