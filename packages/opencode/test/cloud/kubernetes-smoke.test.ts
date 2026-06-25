import { describe, expect, test } from "bun:test"
import { CloudKubernetesSmoke } from "../../src/cloud/kubernetes-smoke"
import type { Client } from "../../src/cloud/kubernetes-smoke"

function client(input?: { phase?: string; exitCode?: number; logs?: string }) {
  const calls: string[] = []
  return {
    calls,
    client: {
      applyNetworkPolicy: async (request) => {
        calls.push(`apply:${request.name}:${request.namespace}`)
        return { name: request.name }
      },
      createPod: async (request) => {
        calls.push(`create:${request.name}:${request.manifest.spec.containers[0].command.join(" ")}`)
        return { name: request.name }
      },
      watchPod: async (request) => {
        calls.push(`watch:${request.name}:${request.until.join(",")}`)
        return { phase: input?.phase ?? "Succeeded", exitCode: input?.exitCode ?? 0 }
      },
      logs: async (request) => {
        calls.push(`logs:${request.name}:${request.container}`)
        return { text: input?.logs ?? "cloud-runtime-k8s-smoke" }
      },
      deletePod: async (request) => {
        calls.push(`delete-pod:${request.name}:${request.gracePeriodSeconds}`)
        return { name: request.name }
      },
      deleteNetworkPolicy: async (request) => {
        calls.push(`delete-netpol:${request.name}`)
        return { name: request.name }
      },
      patchDeploymentScale: async (request) => {
        calls.push(`scale:${request.name}:${request.replicas}`)
        return { name: request.name, replicas: request.replicas }
      },
    } satisfies Client,
  }
}

const env = {
  CLOUD_RUNTIME_K8S_SERVER_URL: "https://kubernetes.example.com",
  CLOUD_RUNTIME_K8S_TOKEN: "token_abc",
  CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
  CLOUD_RUNTIME_K8S_SMOKE_IMAGE: "cloud-runtime-opencode:1.14.28",
  CLOUD_RUNTIME_K8S_SMOKE_JOB_ID: "k8s_smoke_123",
}

describe("CloudKubernetesSmoke", () => {
  test("requires confirmation and Kubernetes config before creating smoke pods", async () => {
    const result = await CloudKubernetesSmoke.run({ env: {} })

    expect(result.status).toBe("failed")
    expect(result.readiness.filter((item) => item.status === "failed").map((item) => item.name)).toEqual([
      "confirmation",
      "server-url",
      "token",
    ])
    expect(result.result).toBeUndefined()
  })

  test("runs a Kubernetes sandbox lifecycle through an injected client", async () => {
    const subject = client()
    const result = await CloudKubernetesSmoke.run({
      env: {
        ...env,
        CLOUD_RUNTIME_CONFIRM_K8S_SMOKE: "1",
      },
      client: subject.client,
      now: () => 1000,
    })

    expect(result.status).toBe("passed")
    expect(result.target).toEqual({
      namespace: "cloud-runtime",
      image: "cloud-runtime-opencode:1.14.28",
      jobID: "k8s_smoke_123",
    })
    expect(result.result).toMatchObject({
      jobID: "k8s_smoke_123",
      podName: "opencode-k8s-smoke-123",
      status: "succeeded",
      logs: "cloud-runtime-k8s-smoke",
    })
    expect(subject.calls).toEqual([
      "apply:opencode-k8s-smoke-123-egress:cloud-runtime",
      "create:opencode-k8s-smoke-123:/bin/sh",
      "watch:opencode-k8s-smoke-123:Succeeded,Failed",
      "logs:opencode-k8s-smoke-123:opencode",
      "delete-pod:opencode-k8s-smoke-123:5",
      "delete-netpol:opencode-k8s-smoke-123-egress",
    ])
  })

  test("allows tokenless smoke through an explicit local kubectl proxy", async () => {
    const result = await CloudKubernetesSmoke.run({
      env: {
        CLOUD_RUNTIME_CONFIRM_K8S_SMOKE: "1",
        CLOUD_RUNTIME_K8S_SERVER_URL: "http://127.0.0.1:18001",
        CLOUD_RUNTIME_K8S_ALLOW_LOCAL_PROXY: "1",
        CLOUD_RUNTIME_NAMESPACE: "cloud-runtime",
        CLOUD_RUNTIME_K8S_SMOKE_IMAGE: "cloud-runtime-opencode:1.14.28",
        CLOUD_RUNTIME_K8S_SMOKE_JOB_ID: "k8s_smoke_123",
      },
      client: client().client,
    })

    expect(result.status).toBe("passed")
    expect(result.readiness.find((item) => item.name === "token")).toMatchObject({
      status: "passed",
      detail: "tokenless local kubectl proxy allowed",
    })
  })

  test("renders failed evidence when the pod fails", async () => {
    const result = await CloudKubernetesSmoke.run({
      env: {
        ...env,
        CLOUD_RUNTIME_CONFIRM_K8S_SMOKE: "1",
      },
      client: client({ phase: "Failed", exitCode: 1, logs: "boom" }).client,
    })

    expect(result.status).toBe("failed")
    expect(result.result).toMatchObject({
      status: "failed",
      logs: "boom",
      podStatus: { phase: "Failed", exitCode: 1 },
    })
  })

  test("renders JSON evidence from the CLI", async () => {
    const result = await CloudKubernetesSmoke.runCLI({
      env: {
        ...env,
        CLOUD_RUNTIME_CONFIRM_K8S_SMOKE: "1",
      },
      client: client().client,
      json: true,
    })
    const evidence = JSON.parse(result.output) as { schemaVersion: number; status: string; result: { status: string } }

    expect(result.exitCode).toBe(0)
    expect(evidence.schemaVersion).toBe(1)
    expect(evidence.status).toBe("passed")
    expect(evidence.result.status).toBe("succeeded")
  })

  test("exposes package scripts for Kubernetes smoke", async () => {
    const scripts = (await Bun.file(new URL("../../package.json", import.meta.url)).json()).scripts

    expect(scripts["cloud:k8s:smoke"]).toBe("bun run ./src/cloud/kubernetes-smoke.ts")
    expect(scripts["cloud:k8s:smoke:json"]).toBe("bun run ./src/cloud/kubernetes-smoke.ts --json")
  })
})
