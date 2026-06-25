type ApplyPlan = {
  desiredRuntimes: number
  action: "scale_up" | "scale_down" | "hold"
  reason: "capacity_exhausted" | "idle_capacity" | "partial_pressure" | "steady"
  drainedRuntimeIDs: string[]
  releasedSessionIDs: string[]
}
type Target = "local" | "kubernetes"
type KubernetesRunnable = ReturnType<typeof kubernetesPatch>

export function operations(input: {
  target: Target
  namespace?: string
  deploymentName?: string
  currentRuntimes: number
  plan: ApplyPlan
}) {
  return [
    ...(input.plan.desiredRuntimes === input.currentRuntimes
      ? []
      : [
          {
            action: "scale" as const,
            target: input.target,
            desiredRuntimes: input.plan.desiredRuntimes,
            currentRuntimes: input.currentRuntimes,
            ...(input.target === "kubernetes"
              ? {
                  namespace: input.namespace ?? "cloud-runtime",
                  deploymentName: input.deploymentName ?? "cloud-runtime-worker",
                }
              : {}),
          },
        ]),
    ...input.plan.drainedRuntimeIDs.map((runtimeID) => ({
      action: "drain" as const,
      target: input.target,
      runtimeID,
    })),
    ...input.plan.releasedSessionIDs.map((sessionID) => ({
      action: "release_session" as const,
      target: input.target,
      sessionID,
    })),
  ]
}

export function kubernetesPatch(input: {
  namespace: string
  deploymentName: string
  desiredRuntimes: number
}) {
  return {
    action: "patch" as const,
    resource: "deployment_scale" as const,
    namespace: input.namespace,
    name: input.deploymentName,
    patch: {
      spec: {
        replicas: input.desiredRuntimes,
      },
    },
  }
}

export function runnable(input: {
  target: Target
  namespace?: string
  deploymentName?: string
  currentRuntimes: number
  plan: ApplyPlan
}) {
  return operations(input).map((operation) => {
    if (operation.action !== "scale" || operation.target !== "kubernetes") return operation
    return kubernetesPatch({
      namespace: operation.namespace ?? input.namespace ?? "cloud-runtime",
      deploymentName: operation.deploymentName ?? input.deploymentName ?? "cloud-runtime-worker",
      desiredRuntimes: operation.desiredRuntimes,
    })
  })
}

export function kubernetesOperations(input: {
  namespace?: string
  deploymentName?: string
  currentRuntimes: number
  plan: ApplyPlan
}) {
  return runnable({
    target: "kubernetes",
    namespace: input.namespace,
    deploymentName: input.deploymentName,
    currentRuntimes: input.currentRuntimes,
    plan: input.plan,
  })
    .filter((operation): operation is KubernetesRunnable => operation.action === "patch" && operation.resource === "deployment_scale")
    .map((operation) => ({
      action: operation.action,
      resource: operation.resource,
      namespace: operation.namespace,
      name: operation.name,
      replicas: operation.patch.spec.replicas,
    }))
}

export * as CloudRuntimePoolScaler from "./runtime-pool-scaler"
