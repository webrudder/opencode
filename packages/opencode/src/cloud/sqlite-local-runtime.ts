import { Database } from "bun:sqlite"
import { CloudSQLiteServer } from "./sqlite-server"
import { CloudSQLiteWorkerLoop } from "./sqlite-worker-loop"

type ServerInput = Parameters<typeof CloudSQLiteServer.create>[0]
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
  const db = input?.server?.db ?? new Database(":memory:")
  const now = input?.server?.now ?? Date.now
  const server = CloudSQLiteServer.create({
    ...input?.server,
    db,
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
      return CloudSQLiteWorkerLoop.tick({
        db,
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
      return CloudSQLiteWorkerLoop.heartbeat({
        db,
        workerID: input.workerID ?? worker.workerID,
        leaseTTLMS: input.leaseTTLMS ?? worker.leaseTTLMS,
        now,
        jobID: input.jobID,
      })
    },
  }
}

export * as CloudSQLiteLocalRuntime from "./sqlite-local-runtime"
