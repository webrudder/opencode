import type { Manifest } from "./artifact"
import { CloudPostgresRepository } from "./postgres-repository"
import type { QueryClient } from "./postgres-runner"
import { CloudRuntimePool } from "./runtime-pool"
import { CloudSharedRuntimeClient } from "./shared-runtime-client"
import type { CloudWorker } from "./worker"

type RuntimeResult =
  | {
      status: "succeeded"
      manifest: Manifest
      sizeByPath: Record<string, number>
    }
  | {
      status: "failed"
      message: string
      runtimeUnavailable?: true
    }

export async function run(input: {
  client: QueryClient
  tenantID: string
  sessionID: string
  jobID: string
  launch: CloudWorker.LaunchPlan
  now: () => number
  runtime?: (request: { runtimeID: string; jobID: string; launch: CloudWorker.LaunchPlan }) => Promise<RuntimeResult>
  runtimeClient?: ReturnType<typeof CloudSharedRuntimeClient.create>
}) {
  const runtimes = await CloudPostgresRepository.listRuntimeWorkers({ client: input.client, tenantID: input.tenantID })
  const assignment = CloudRuntimePool.assign({
    tenantID: input.tenantID,
    sessionID: input.sessionID,
    runtimes,
    bindings: await CloudPostgresRepository.listSessionRuntimeBindings({ client: input.client, tenantID: input.tenantID }),
  })
  if (!assignment.assigned) {
    return {
      status: "failed" as const,
      runtimeID: "unassigned",
      message: "Cloud runtime capacity exhausted",
    }
  }
  await CloudPostgresRepository.bindSessionRuntime({
    client: input.client,
    binding: CloudRuntimePool.bindSession({
      tenantID: input.tenantID,
      sessionID: input.sessionID,
      runtimeID: assignment.runtimeID,
      now: input.now(),
    }),
  })
  const runtime = runtimes.find((item) => item.id === assignment.runtimeID)
  const result = input.runtime
    ? await input.runtime({
        runtimeID: assignment.runtimeID,
        jobID: input.jobID,
        launch: input.launch,
      })
    : runtime?.endpoint
      ? await (input.runtimeClient ?? CloudSharedRuntimeClient.create()).runJob({
          endpoint: runtime.endpoint,
          runtimeID: assignment.runtimeID,
          jobID: input.jobID,
          launch: input.launch,
        })
      : {
          status: "failed" as const,
          message: `Shared session runtime ${assignment.runtimeID} has no endpoint`,
        }
  if (result.status === "failed" && result.runtimeUnavailable) {
    await CloudPostgresRepository.releaseSessionRuntime({
      client: input.client,
      tenantID: input.tenantID,
      sessionID: input.sessionID,
    })
    await CloudPostgresRepository.markRuntimeOffline({
      client: input.client,
      tenantID: input.tenantID,
      runtimeID: assignment.runtimeID,
      now: input.now(),
    })
  }
  return {
    ...result,
    runtimeID: assignment.runtimeID,
  }
}

export * as CloudPostgresSharedRuntime from "./postgres-shared-runtime"
