import { CloudAPIKey } from "./api-key"

const defaultAllowMethods = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
const defaultAllowHeaders = ["authorization", "content-type", "x-cloud-runtime-tenant"]
const defaultExposeHeaders = ["x-request-id"]

function allowedOrigin(input: { request: Request; origins: string[] }) {
  const origin = input.request.headers.get("origin")
  if (!origin) return undefined
  if (!input.origins.includes(origin)) return undefined
  return origin
}

export function requestID(input: {
  request: Request
  id: () => string
}) {
  return input.request.headers.get("x-request-id") ?? input.id()
}

export function withRequestID(input: {
  response: Response
  requestID: string
}) {
  const headers = new Headers(input.response.headers)
  headers.set("x-request-id", input.requestID)
  return new Response(input.response.body, {
    status: input.response.status,
    statusText: input.response.statusText,
    headers,
  })
}

export function unauthorized() {
  return Response.json(
    {
      error: {
        code: "unauthorized",
        message: "Cloud API key is missing or invalid",
      },
    },
    { status: 401 },
  )
}

export function withCORS(input: {
  request: Request
  response: Response
  origins?: string[]
  exposeHeaders?: string[]
}) {
  const origin = allowedOrigin({ request: input.request, origins: input.origins ?? [] })
  if (!origin) return input.response
  const headers = new Headers(input.response.headers)
  headers.set("access-control-allow-origin", origin)
  headers.set("vary", "origin")
  headers.set("access-control-expose-headers", (input.exposeHeaders ?? defaultExposeHeaders).join(", "))
  return new Response(input.response.body, {
    status: input.response.status,
    statusText: input.response.statusText,
    headers,
  })
}

export function cors(input: {
  origins?: string[]
  allowHeaders?: string[]
  exposeHeaders?: string[]
  allowMethods?: string[]
}) {
  if (!input.origins?.length) return undefined
  const origins = input.origins
  return (request: Request) => {
    if (request.method !== "OPTIONS") return undefined
    const origin = allowedOrigin({ request, origins })
    if (!origin) return undefined
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": (input.allowMethods ?? defaultAllowMethods).join(", "),
        "access-control-allow-headers": (input.allowHeaders ?? defaultAllowHeaders).join(", "),
        "access-control-expose-headers": (input.exposeHeaders ?? defaultExposeHeaders).join(", "),
        vary: "origin",
      },
    })
  }
}

export function apiKeyGuard(input: {
  apiKeys?: ReturnType<typeof CloudAPIKey.issue>["record"][]
}) {
  if (!input.apiKeys?.length) return undefined
  const records = input.apiKeys
  return (request: Request) => {
    try {
      CloudAPIKey.authenticate({
        records,
        authorization: request.headers.get("authorization") ?? undefined,
      })
      return undefined
    } catch {
      return unauthorized()
    }
  }
}

export * as CloudGateway from "./gateway"
