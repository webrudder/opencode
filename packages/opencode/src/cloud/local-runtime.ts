import { CloudServer } from "./server"
import { CloudStore } from "./store"
import { CloudWorkerLoop } from "./worker-loop"

type ServerInput = Parameters<typeof CloudServer.create>[0]
type WorkerInput = {
  tenantID?: string
  workerID?: string
  leaseTTLMS?: number
  sandboxRoot?: string
  bucket?: string
  namespace?: string
  baseEnv?: Record<string, string | undefined>
}

const DefaultWorker = {
  tenantID: "tenant_local",
  workerID: "local-worker-1",
  leaseTTLMS: 30_000,
  sandboxRoot: "/tmp/cloud-runtime",
  bucket: "runtime-artifacts",
  namespace: "cloud-runtime",
}

export function create(input?: {
  server?: ServerInput
  worker?: WorkerInput
}) {
  const store = input?.server?.store ?? CloudStore.create()
  const now = input?.server?.now ?? Date.now
  const server = CloudServer.create({
    ...input?.server,
    store,
    now,
  })
  const worker = {
    ...DefaultWorker,
    ...input?.worker,
  }

  return {
    ...server,
    tickWorker(overrides?: WorkerInput) {
      const current = {
        ...worker,
        ...overrides,
      }
      return CloudWorkerLoop.tick({
        store,
        tenantID: current.tenantID,
        workerID: current.workerID,
        leaseTTLMS: current.leaseTTLMS,
        now,
        sandboxRoot: current.sandboxRoot,
        bucket: current.bucket,
        namespace: current.namespace,
        baseEnv: current.baseEnv,
      })
    },
    heartbeatWorker(input: { jobID: string; workerID?: string; leaseTTLMS?: number }) {
      return CloudWorkerLoop.heartbeat({
        store,
        workerID: input.workerID ?? worker.workerID,
        leaseTTLMS: input.leaseTTLMS ?? worker.leaseTTLMS,
        now,
        jobID: input.jobID,
      })
    },
  }
}

export * as CloudLocalRuntime from "./local-runtime"
