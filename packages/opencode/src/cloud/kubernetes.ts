import type { CloudWorker } from "./worker"

type LaunchPlan = CloudWorker.LaunchPlan

function name(input: string) {
  const result = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
  return result || "job"
}

function image(input: LaunchPlan) {
  if (!input.sandbox.imageDigest) return input.sandbox.image
  return `${input.sandbox.image}@${input.sandbox.imageDigest}`
}

function env(input: Record<string, string>) {
  return Object.entries(input)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({
      name: key,
      value,
    }))
}

function runtimeClass(input: LaunchPlan) {
  if (input.sandbox.isolation === "container") return {}
  return {
    runtimeClassName: input.sandbox.isolation,
  }
}

export function pod(input: {
  namespace: string
  launch: LaunchPlan
  serviceAccountName?: string
  labels?: Record<string, string>
}) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `opencode-${name(input.launch.sandbox.jobID)}`,
      namespace: input.namespace,
      labels: {
        ...input.labels,
        "cloud.opencode.ai/job-id": input.launch.sandbox.jobID,
        "cloud.opencode.ai/tenant-id": input.launch.sandbox.tenantID,
      },
    },
    spec: {
      restartPolicy: "Never",
      ...(input.serviceAccountName ? { serviceAccountName: input.serviceAccountName } : {}),
      ...runtimeClass(input.launch),
      activeDeadlineSeconds: Math.ceil(input.launch.sandbox.resources.timeoutMS / 1000),
      securityContext: {
        runAsNonRoot: input.launch.sandbox.security.runAsNonRoot,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "opencode",
          image: image(input.launch),
          command: [input.launch.command],
          args: input.launch.args,
          workingDir: input.launch.cwd,
          volumeMounts: [
            {
              name: "workspace",
              mountPath: input.launch.cwd,
            },
          ],
          env: env(input.launch.env),
          resources: {
            requests: {
              cpu: String(input.launch.sandbox.resources.cpu),
              memory: `${input.launch.sandbox.resources.memoryMB}Mi`,
              "ephemeral-storage": `${input.launch.sandbox.resources.diskMB}Mi`,
            },
            limits: {
              cpu: String(input.launch.sandbox.resources.cpu),
              memory: `${input.launch.sandbox.resources.memoryMB}Mi`,
              "ephemeral-storage": `${input.launch.sandbox.resources.diskMB}Mi`,
            },
          },
          securityContext: {
            allowPrivilegeEscalation: input.launch.sandbox.security.allowPrivilegeEscalation,
            readOnlyRootFilesystem: input.launch.sandbox.security.readOnlyRootFilesystem,
            runAsNonRoot: input.launch.sandbox.security.runAsNonRoot,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
      volumes: [
        {
          name: "workspace",
          emptyDir: {},
        },
      ],
    },
  }
}

export function networkPolicy(input: { namespace: string; launch: LaunchPlan; labels?: Record<string, string> }) {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: `opencode-${name(input.launch.sandbox.jobID)}-egress`,
      namespace: input.namespace,
      labels: {
        ...input.labels,
        "cloud.opencode.ai/job-id": input.launch.sandbox.jobID,
        "cloud.opencode.ai/tenant-id": input.launch.sandbox.tenantID,
      },
      annotations: {
        "cloud.opencode.ai/allow-hosts": input.launch.sandbox.network.allowHosts.join(","),
      },
    },
    spec: {
      podSelector: {
        matchLabels: {
          "cloud.opencode.ai/job-id": input.launch.sandbox.jobID,
        },
      },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              ipBlock: {
                cidr: "0.0.0.0/0",
              },
            },
          ],
          ports: [{ protocol: "TCP", port: 443 }],
        },
      ],
    },
  }
}

export * as CloudKubernetes from "./kubernetes"
