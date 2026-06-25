type AuthMode = "api_key" | "internal_jwt" | "none"

function normalizeBasePath(input: string) {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (!trimmed) return "/"
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

export function plan(input: {
  basePath?: string
  authMode: AuthMode
  corsOrigins?: string[]
  exposeHealth?: boolean
  exposeOpenAPI?: boolean
}) {
  const basePath = normalizeBasePath(input.basePath ?? "/")
  const routes = [
    { method: "GET", path: "/health", public: true },
    ...(input.exposeOpenAPI ? [{ method: "GET", path: "/openapi.json", public: true }] : []),
    { method: "POST", path: "/v1/workspaces", public: input.authMode === "none" },
    { method: "POST", path: "/v1/sessions", public: input.authMode === "none" },
    { method: "POST", path: "/v1/files", public: input.authMode === "none" },
    { method: "GET", path: "/v1/files", public: input.authMode === "none" },
    { method: "POST", path: "/v1/jobs", public: input.authMode === "none" },
    { method: "GET", path: "/v1/jobs/:id", public: input.authMode === "none" },
    { method: "GET", path: "/v1/jobs/:id/events", public: input.authMode === "none" },
    { method: "GET", path: "/v1/jobs/:id/events/stream", public: input.authMode === "none" },
    { method: "POST", path: "/v1/jobs/:id/cancel", public: input.authMode === "none" },
    { method: "POST", path: "/v1/sessions/:id/messages", public: input.authMode === "none" },
    { method: "GET", path: "/v1/sessions/:id/messages", public: input.authMode === "none" },
    { method: "GET", path: "/v1/artifacts", public: input.authMode === "none" },
    { method: "GET", path: "/v1/artifacts/:id/download", public: input.authMode === "none" },
    { method: "GET", path: "/v1/tools", public: input.authMode === "none" },
    { method: "POST", path: "/v1/webhooks", public: input.authMode === "none" },
    { method: "GET", path: "/v1/webhooks", public: input.authMode === "none" },
    { method: "PATCH", path: "/v1/webhooks/:id", public: input.authMode === "none" },
    { method: "DELETE", path: "/v1/webhooks/:id", public: input.authMode === "none" },
  ].filter((route) => input.exposeHealth !== false || route.path !== "/health")

  return {
    basePath,
    authMode: input.authMode,
    middleware: [
      ...(input.corsOrigins?.length
        ? [
            {
              name: "cors",
              allowOrigins: input.corsOrigins,
              allowHeaders: ["authorization", "content-type", "x-cloud-runtime-tenant"],
              exposeHeaders: ["x-request-id"],
            },
          ]
        : []),
      ...(input.authMode === "none"
        ? []
        : [
            {
              name: "auth",
              mode: input.authMode,
              requiredHeaders: input.authMode === "api_key" ? ["authorization"] : ["authorization", "x-cloud-runtime-tenant"],
            },
          ]),
    ],
    routes: routes.map((route) => ({
      ...route,
      mountedPath: basePath === "/" ? route.path : `${basePath}${route.path}`,
    })),
  }
}

export function health(input: { version: string; runtimeDefaultVersion: string; time: number }) {
  return {
    healthy: true,
    service: "cloud-opencode-runtime",
    version: input.version,
    runtimeDefaultVersion: input.runtimeDefaultVersion,
    time: input.time,
  }
}

export * as CloudAPIMount from "./api-mount"
