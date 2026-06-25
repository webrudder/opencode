const routeOperations = [
  ["post", "/v1/workspaces", "createWorkspace", "Workspaces"],
  ["post", "/v1/sessions", "createSession", "Sessions"],
  ["post", "/v1/files", "createFile", "Files"],
  ["get", "/v1/files", "listFiles", "Files"],
  ["post", "/v1/jobs", "createJob", "Jobs"],
  ["get", "/v1/jobs/{id}", "getJob", "Jobs"],
  ["post", "/v1/jobs/{id}/cancel", "cancelJob", "Jobs"],
  ["get", "/v1/jobs/{id}/events", "listJobEvents", "Jobs"],
  ["get", "/v1/jobs/{id}/events/stream", "streamJobEvents", "Jobs"],
  ["post", "/v1/sessions/{id}/messages", "createSessionMessage", "Sessions"],
  ["get", "/v1/sessions/{id}/messages", "listSessionMessages", "Sessions"],
  ["get", "/v1/artifacts", "listArtifacts", "Artifacts"],
  ["get", "/v1/artifacts/{id}/download", "downloadArtifact", "Artifacts"],
  ["get", "/v1/tools", "listTools", "Tools"],
  ["post", "/v1/llm-credentials", "createLLMCredential", "LLM Credentials"],
  ["get", "/v1/llm-credentials", "listLLMCredentials", "LLM Credentials"],
  ["get", "/v1/llm-credentials/{id}", "getLLMCredential", "LLM Credentials"],
  ["patch", "/v1/llm-credentials/{id}", "updateLLMCredential", "LLM Credentials"],
  ["delete", "/v1/llm-credentials/{id}", "deleteLLMCredential", "LLM Credentials"],
  ["post", "/v1/llm-credentials/{id}/test", "testLLMCredential", "LLM Credentials"],
  ["post", "/v1/webhooks", "createWebhook", "Webhooks"],
  ["get", "/v1/webhooks", "listWebhooks", "Webhooks"],
  ["patch", "/v1/webhooks/{id}", "updateWebhook", "Webhooks"],
  ["delete", "/v1/webhooks/{id}", "deleteWebhook", "Webhooks"],
  ["get", "/admin/runtime-pools", "adminGetRuntimePool", "Admin"],
  ["post", "/admin/runtime-pools/reconcile", "adminReconcileRuntimePool", "Admin"],
  ["post", "/admin/runtime-pools/apply-plan", "adminApplyRuntimePoolPlan", "Admin"],
  ["get", "/admin/runtimes", "adminListRuntimes", "Admin"],
  ["get", "/admin/runtimes/{id}", "adminGetRuntime", "Admin"],
  ["post", "/admin/runtimes/{id}/drain", "adminDrainRuntime", "Admin"],
  ["post", "/admin/runtimes/{id}/restart", "adminRestartRuntime", "Admin"],
  ["get", "/admin/sessions/{id}/runtime", "adminGetSessionRuntime", "Admin"],
  ["post", "/admin/sessions/{id}/release-runtime", "adminReleaseSessionRuntime", "Admin"],
  ["get", "/admin/integrators/{id}/runtime-policy", "adminGetIntegratorRuntimePolicy", "Admin"],
  ["patch", "/admin/integrators/{id}/runtime-policy", "adminUpdateIntegratorRuntimePolicy", "Admin"],
] as const

function pathItem(input: (typeof routeOperations)[number]) {
  return {
    [input[0]]: {
      operationId: input[2],
      tags: [input[3]],
      responses: {
        "200": {
          description: "Successful Cloud Runtime response",
        },
        "400": {
          description: "Bad request",
        },
        "401": {
          description: "Unauthorized",
        },
        "404": {
          description: "Resource not found",
        },
      },
      security: input[1] === "/v1/tools" ? [] : [{ bearerAuth: [] }],
    },
  }
}

export function document(input: { version: string }) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Cloud OpenCode Runtime API",
      version: input.version,
    },
    paths: routeOperations.reduce<Record<string, Record<string, unknown>>>((result, route) => {
      return {
        ...result,
        [route[1]]: {
          ...(result[route[1]] ?? {}),
          ...pathItem(route),
        },
      }
    }, {}),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
    },
  }
}

export * as CloudOpenAPI from "./openapi"
