type Connector = {
  name: string
  authRef: string
  scopes: string[]
}

type Grant = {
  tenantID: string
  jobID: string
  sessionID: string
  connector: string
  scopes: string[]
  expiresAt: number
  headers: Record<string, string>
}

function assertScopes(input: { allowed: string[]; requested: string[] }) {
  input.requested.map((scope) => {
    if (!input.allowed.includes(scope)) throw new Error(`Cloud connector scope denied: ${scope}`)
  })
}

export function grant(input: {
  tenantID: string
  connector: Connector
  request: {
    jobID: string
    sessionID: string
    scopes: string[]
  }
  token: {
    value: string
    expiresAt: number
  }
}): Grant {
  assertScopes({ allowed: input.connector.scopes, requested: input.request.scopes })
  return {
    tenantID: input.tenantID,
    jobID: input.request.jobID,
    sessionID: input.request.sessionID,
    connector: input.connector.name,
    scopes: input.request.scopes,
    expiresAt: input.token.expiresAt,
    headers: {
      "x-cloud-connector": input.connector.name,
      "x-cloud-connector-token": input.token.value,
    },
  }
}

export function mcpHeaders(input: { connector: string; grant: Grant }) {
  if (input.connector !== input.grant.connector) throw new Error("Cloud connector grant mismatch")
  return input.grant.headers
}

export * as CloudConnector from "./connector"
