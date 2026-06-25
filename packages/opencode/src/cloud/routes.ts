import { Hono } from "hono"
import { CloudAPI } from "./api"
import { CloudRuntimePool } from "./runtime-pool"
import type { CloudService } from "./service"
import { CloudToolCatalog } from "./tool-catalog"
import { CloudView } from "./view"

type Service = Pick<
  ReturnType<typeof CloudService.create>,
  | "createWorkspace"
  | "createSession"
  | "createFile"
  | "listFiles"
  | "createJob"
  | "getJob"
  | "cancelJob"
  | "listJobEvents"
  | "createSessionMessage"
  | "listSessionMessages"
  | "listArtifacts"
  | "getArtifactDownload"
  | "createWebhook"
  | "listWebhooks"
  | "updateWebhook"
  | "deleteWebhook"
  | "createLLMCredential"
  | "listLLMCredentials"
  | "getLLMCredential"
  | "updateLLMCredential"
  | "deleteLLMCredential"
  | "testLLMCredential"
  | "listRuntimeWorkers"
  | "getRuntimeWorker"
  | "drainRuntimeWorker"
  | "restartRuntimeWorker"
  | "reconcileRuntimePool"
  | "applyRuntimePoolPlan"
  | "getSessionRuntimeBinding"
  | "listSessionRuntimeBindings"
  | "releaseSessionRuntime"
  | "getIntegratorRuntimePolicy"
  | "updateIntegratorRuntimePolicy"
>
type ToolCatalog = Parameters<typeof CloudToolCatalog.publicCatalog>[0]
type Awaitable<T> = T | Promise<T>
type AsyncService = {
  [Key in keyof Service]: (...args: Parameters<Service[Key]>) => Awaitable<ReturnType<Service[Key]>>
}

function errorBody(error: Error) {
  const notFound = error.message.toLowerCase().includes("not found")
  return {
    status: notFound ? 404 : 400,
    body: {
      error: {
        code: notFound ? "not_found" : "bad_request",
        message: error.message,
      },
    },
  }
}

function number(input: string | undefined) {
  const value = Number(input)
  if (Number.isInteger(value) && value > 0) return value
  return undefined
}

function flag(input: string | undefined) {
  return input === "true"
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function eventPage(input: {
  service: AsyncService
  jobID: string
  cursor?: string
  limit: number
}) {
  const events = await input.service.listJobEvents({ jobID: input.jobID, cursor: input.cursor, limit: input.limit + 1 })
  const items = events.slice(0, input.limit).map(CloudView.event)
  return CloudAPI.decodeJobEventPageResponse({
    items,
    nextCursor: items.at(-1)?.id,
    hasMore: events.length > input.limit,
  })
}

function eventStream(input: CloudAPI.JobEvent[]) {
  return input
    .map((event) =>
      [`id: ${event.id}`, `event: ${event.type}`, `data: ${JSON.stringify(event)}`, "", ""].join("\n"),
    )
    .join("")
}

function runtimeWorker(input: ReturnType<Service["listRuntimeWorkers"]>[number]) {
  return {
    id: input.id,
    executionMode: input.executionMode,
    status: input.status,
    version: input.version,
    profile: input.profile,
    maxActiveJobs: input.maxActiveJobs,
    maxSessions: input.maxSessions,
    metrics: input.metrics,
    capacity: CloudRuntimePool.capacity({ runtime: input }),
    updated: input.time.updated,
  }
}

function sessionBinding(input: NonNullable<ReturnType<Service["getSessionRuntimeBinding"]>>) {
  return {
    sessionID: input.sessionID,
    runtimeID: input.runtimeID,
    updated: input.time.updated,
  }
}

function runtimePool(input: {
  runtimes: Awaited<ReturnType<Service["listRuntimeWorkers"]>>
  bindings: Awaited<ReturnType<Service["listSessionRuntimeBindings"]>>
}) {
  return {
    runtimes: input.runtimes.length,
    healthy: input.runtimes.filter((runtime) => runtime.status === "healthy").length,
    draining: input.runtimes.filter((runtime) => runtime.status === "draining").length,
    overloaded: input.runtimes.filter((runtime) => runtime.status === "overloaded").length,
    offline: input.runtimes.filter((runtime) => runtime.status === "offline").length,
    activeJobs: input.runtimes.reduce((total, runtime) => total + runtime.metrics.activeJobs, 0),
    busySessions: input.runtimes.reduce((total, runtime) => total + runtime.metrics.busySessions, 0),
    idleSessions: input.runtimes.reduce((total, runtime) => total + runtime.metrics.idleSessions, 0),
    plan: CloudRuntimePool.poolPlan({
      tenantID: input.runtimes[0]?.tenantID ?? input.bindings[0]?.tenantID ?? "",
      runtimes: input.runtimes,
      bindings: input.bindings,
    }),
  }
}

function runtimePolicyRequest(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("Cloud runtime policy request must be an object")
  const body = input as Record<string, unknown>
  return {
    defaultExecutionMode: body.defaultExecutionMode,
    allowedExecutionModes: Array.isArray(body.allowedExecutionModes) ? body.allowedExecutionModes : [],
    maxActiveJobs: body.maxActiveJobs,
    maxSessions: body.maxSessions,
    maxConcurrentJobsPerSession: body.maxConcurrentJobsPerSession,
  } as Parameters<Service["updateIntegratorRuntimePolicy"]>[1]
}

function applyRuntimePoolPlanRequest(input: unknown) {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {}
  return {
    target: body.target === "kubernetes" ? "kubernetes" as const : "local" as const,
    ...(typeof body.currentRuntimes === "number" ? { currentRuntimes: body.currentRuntimes } : {}),
    ...(typeof body.namespace === "string" ? { namespace: body.namespace } : {}),
    ...(typeof body.deploymentName === "string" ? { deploymentName: body.deploymentName } : {}),
  }
}

function terminalEvent(input: CloudAPI.JobEvent) {
  const status = input.type === "job.status" ? input.data.status : undefined
  return status === "succeeded" || status === "failed" || status === "canceled" || status === "expired"
}

function followEventStream(input: {
  service: AsyncService
  jobID: string
  cursor?: string
  limit: number
  pollMS: number
  timeoutMS: number
}) {
  const encoder = new TextEncoder()
  const started = Date.now()
  return new ReadableStream({
    async start(controller) {
      async function poll(cursor?: string): Promise<void> {
        const events = (await input.service.listJobEvents({ jobID: input.jobID, cursor, limit: input.limit })).map(
          CloudView.event,
        )
        if (events.length) controller.enqueue(encoder.encode(eventStream(events)))
        if (events.some(terminalEvent) || Date.now() - started >= input.timeoutMS) {
          controller.close()
          return
        }
        await sleep(input.pollMS)
        return poll(events.at(-1)?.id ?? cursor)
      }
      return poll(input.cursor)
    },
  })
}

async function filePage(input: {
  service: AsyncService
  workspaceID?: string
  sessionID?: string
  cursor?: string
  limit: number
}) {
  const files = await input.service.listFiles({
    workspaceID: input.workspaceID,
    sessionID: input.sessionID,
    cursor: input.cursor,
    limit: input.limit + 1,
  })
  const items = files.slice(0, input.limit).map(CloudView.file)
  return CloudAPI.decodeFilePageResponse({
    items,
    nextCursor: items.at(-1)?.id,
    hasMore: files.length > input.limit,
  })
}

async function artifactPage(input: {
  service: AsyncService
  jobID?: string
  cursor?: string
  limit: number
}) {
  const artifacts = await input.service.listArtifacts({
    jobID: input.jobID,
    cursor: input.cursor,
    limit: input.limit + 1,
  })
  const items = artifacts.slice(0, input.limit).map(CloudView.artifact)
  return CloudAPI.decodeArtifactPageResponse({
    items,
    nextCursor: items.at(-1)?.id,
    hasMore: artifacts.length > input.limit,
  })
}

export function create(input: {
  service: AsyncService
  toolCatalog: ToolCatalog
  beforeRequest?: (request: Request) => Response | undefined | Promise<Response | undefined>
}) {
  return new Hono()
    .onError((error, c) => {
      const result = errorBody(error)
      if (result.status === 404) return c.json(result.body, 404)
      return c.json(result.body, 400)
    })
    .use("*", async (c, next) => {
      const response = await input.beforeRequest?.(c.req.raw)
      if (response) return response
      return next()
    })
    .post("/v1/workspaces", async (c) => {
      return c.json(CloudView.workspace(await input.service.createWorkspace(CloudAPI.decodeCreateWorkspaceRequest(await c.req.json()))))
    })
    .post("/v1/sessions", async (c) => {
      return c.json(CloudView.session(await input.service.createSession(CloudAPI.decodeCreateSessionRequest(await c.req.json()))))
    })
    .post("/v1/files", async (c) => {
      return c.json(CloudView.file(await input.service.createFile(CloudAPI.decodeCreateFileRequest(await c.req.json()))))
    })
    .get("/v1/files", async (c) => {
      const limit = number(c.req.query("limit"))
      if (limit) {
        return c.json(
          await filePage({
            service: input.service,
            workspaceID: c.req.query("workspaceID"),
            sessionID: c.req.query("sessionID"),
            cursor: c.req.query("cursor"),
            limit,
          }),
        )
      }
      return c.json(
        (await input.service.listFiles({ workspaceID: c.req.query("workspaceID"), sessionID: c.req.query("sessionID") })).map(
          CloudView.file,
        ),
      )
    })
    .post("/v1/jobs", async (c) => {
      return c.json(CloudView.job(await input.service.createJob(CloudAPI.decodeCreateJobRequest(await c.req.json()))))
    })
    .get("/v1/jobs/:id", async (c) => {
      return c.json(CloudView.job(await input.service.getJob({ jobID: c.req.param("id") })))
    })
    .post("/v1/jobs/:id/cancel", async (c) => {
      return c.json(CloudView.job(await input.service.cancelJob({ jobID: c.req.param("id") })))
    })
    .get("/v1/jobs/:id/events", async (c) => {
      const limit = number(c.req.query("limit"))
      if (limit) {
        return c.json(
          await eventPage({
            service: input.service,
            jobID: c.req.param("id"),
            cursor: c.req.query("cursor"),
            limit,
          }),
        )
      }
      return c.json(await input.service.listJobEvents({ jobID: c.req.param("id"), cursor: c.req.query("cursor") }))
    })
    .get("/v1/jobs/:id/events/stream", async (c) => {
      if (flag(c.req.query("follow"))) {
        return new Response(
          followEventStream({
            service: input.service,
            jobID: c.req.param("id"),
            cursor: c.req.query("cursor"),
            limit: number(c.req.query("limit")) ?? 100,
            pollMS: number(c.req.query("pollMS")) ?? 1000,
            timeoutMS: number(c.req.query("timeoutMS")) ?? 30_000,
          }),
          {
            headers: {
              "cache-control": "no-cache",
              "content-type": "text/event-stream; charset=utf-8",
            },
          },
        )
      }
      return new Response(
        eventStream(
          (await input.service.listJobEvents({
            jobID: c.req.param("id"),
            cursor: c.req.query("cursor"),
            limit: number(c.req.query("limit")) ?? 100,
          })).map(CloudView.event),
        ),
        {
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/event-stream; charset=utf-8",
          },
        },
      )
    })
    .post("/v1/sessions/:id/messages", async (c) => {
      return c.json(
        CloudView.message(
          await input.service.createSessionMessage(
            c.req.param("id"),
            CloudAPI.decodeCreateSessionMessageRequest(await c.req.json()),
          ),
        ),
      )
    })
    .get("/v1/sessions/:id/messages", async (c) => {
      return c.json((await input.service.listSessionMessages({ sessionID: c.req.param("id") })).map(CloudView.message))
    })
    .get("/v1/artifacts", async (c) => {
      const limit = number(c.req.query("limit"))
      if (limit) {
        return c.json(
          await artifactPage({
            service: input.service,
            jobID: c.req.query("jobID"),
            cursor: c.req.query("cursor"),
            limit,
          }),
        )
      }
      return c.json((await input.service.listArtifacts({ jobID: c.req.query("jobID") })).map(CloudView.artifact))
    })
    .get("/v1/artifacts/:id/download", async (c) => {
      return c.json(await input.service.getArtifactDownload({ artifactID: c.req.param("id"), ttlMS: 15 * 60 * 1000 }))
    })
    .get("/v1/tools", (c) => {
      return c.json(CloudToolCatalog.publicCatalog(input.toolCatalog))
    })
    .post("/v1/llm-credentials", async (c) => {
      return c.json(
        CloudView.llmCredential(await input.service.createLLMCredential(CloudAPI.decodeCreateLLMCredentialRequest(await c.req.json()))),
      )
    })
    .get("/v1/llm-credentials", async (c) => {
      return c.json((await input.service.listLLMCredentials()).map(CloudView.llmCredential))
    })
    .get("/v1/llm-credentials/:id", async (c) => {
      return c.json(CloudView.llmCredential(await input.service.getLLMCredential({ credentialID: c.req.param("id") })))
    })
    .patch("/v1/llm-credentials/:id", async (c) => {
      return c.json(
        CloudView.llmCredential(
          await input.service.updateLLMCredential(
            c.req.param("id"),
            CloudAPI.decodeUpdateLLMCredentialRequest(await c.req.json()),
          ),
        ),
      )
    })
    .delete("/v1/llm-credentials/:id", async (c) => {
      return c.json(CloudView.llmCredential(await input.service.deleteLLMCredential({ credentialID: c.req.param("id") })))
    })
    .post("/v1/llm-credentials/:id/test", async (c) => {
      return c.json(await input.service.testLLMCredential({ credentialID: c.req.param("id") }))
    })
    .get("/admin/runtime-pools", async (c) => {
      return c.json(
        runtimePool({
          runtimes: await input.service.listRuntimeWorkers(),
          bindings: await input.service.listSessionRuntimeBindings(),
        }),
      )
    })
    .get("/admin/runtimes", async (c) => {
      return c.json((await input.service.listRuntimeWorkers()).map(runtimeWorker))
    })
    .get("/admin/runtimes/:id", async (c) => {
      return c.json(runtimeWorker(await input.service.getRuntimeWorker({ runtimeID: c.req.param("id") })))
    })
    .post("/admin/runtimes/:id/drain", async (c) => {
      return c.json(runtimeWorker(await input.service.drainRuntimeWorker({ runtimeID: c.req.param("id") })))
    })
    .post("/admin/runtimes/:id/restart", async (c) => {
      return c.json(runtimeWorker(await input.service.restartRuntimeWorker({ runtimeID: c.req.param("id") })))
    })
    .post("/admin/runtime-pools/reconcile", async (c) => {
      const body = await c.req.json().catch(() => ({}))
      return c.json(
        await input.service.reconcileRuntimePool({
          heartbeatTTLMS: typeof body.heartbeatTTLMS === "number" ? body.heartbeatTTLMS : 30_000,
        }),
      )
    })
    .post("/admin/runtime-pools/apply-plan", async (c) => {
      return c.json(await input.service.applyRuntimePoolPlan(applyRuntimePoolPlanRequest(await c.req.json().catch(() => ({})))))
    })
    .get("/admin/sessions/:id/runtime", async (c) => {
      const binding = await input.service.getSessionRuntimeBinding({ sessionID: c.req.param("id") })
      if (!binding) throw new Error("Cloud session runtime binding not found")
      return c.json(sessionBinding(binding))
    })
    .post("/admin/sessions/:id/release-runtime", async (c) => {
      return c.json(sessionBinding(await input.service.releaseSessionRuntime({ sessionID: c.req.param("id") })))
    })
    .get("/admin/integrators/:id/runtime-policy", async (c) => {
      const policy = await input.service.getIntegratorRuntimePolicy({ integratorID: c.req.param("id") })
      if (!policy) throw new Error("Cloud integrator runtime policy not found")
      return c.json(policy)
    })
    .patch("/admin/integrators/:id/runtime-policy", async (c) => {
      return c.json(await input.service.updateIntegratorRuntimePolicy(c.req.param("id"), runtimePolicyRequest(await c.req.json())))
    })
    .post("/v1/webhooks", async (c) => {
      return c.json(CloudView.webhook(await input.service.createWebhook(CloudAPI.decodeCreateWebhookRequest(await c.req.json()))))
    })
    .get("/v1/webhooks", async (c) => {
      return c.json((await input.service.listWebhooks()).map(CloudView.webhook))
    })
    .patch("/v1/webhooks/:id", async (c) => {
      return c.json(
        CloudView.webhook(
          await input.service.updateWebhook({
            webhookID: c.req.param("id"),
            ...CloudAPI.decodeUpdateWebhookRequest(await c.req.json()),
          }),
        ),
      )
    })
    .delete("/v1/webhooks/:id", async (c) => {
      return c.json(CloudView.webhook(await input.service.deleteWebhook({ webhookID: c.req.param("id") })))
    })
}

export * as CloudRoutes from "./routes"
