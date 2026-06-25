import path from "path"
import type { JobSpec } from "./runtime"
import { CloudRuntime } from "./runtime"
import { CloudSandbox } from "./sandbox"

export type LaunchPlan = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  artifactManifest: string
  network: ReturnType<typeof CloudRuntime.networkPolicy>
  sandbox: ReturnType<typeof CloudSandbox.plan>
}

function env(input?: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(input ?? {}).filter((entry): entry is [string, string] => !!entry[1]))
}

function modelessSmokeScript(input: { spec: JobSpec }) {
  const manifest = `{"version":1,"jobID":"${input.spec.id}","artifacts":[{"name":"modeless-smoke-report.md","kind":"md","path":"modeless-smoke-report.md","mime":"text/markdown"}]}`
  return [
    "mkdir -p .opencode-cloud",
    `printf '%s\\n' '# cloud-runtime-modeless-smoke' 'job: ${input.spec.id}' > modeless-smoke-report.md`,
    `printf '%s\\n' '${manifest}' > .opencode-cloud/artifacts.json`,
    `printf '%s' '::cloud-runtime-artifacts{"manifest":${manifest},"files":[{"path":"modeless-smoke-report.md","contentBase64":"'`,
    `base64 < modeless-smoke-report.md | tr -d '\\n'`,
    `printf '%s\\n' '"}]}'`,
  ].join(" && ")
}

export function launchPlan(
  spec: JobSpec,
  input: {
    workdir: string
    prompt: string
    baseEnv?: Record<string, string | undefined>
    modelCredentialEnv?: Record<string, string | undefined>
  },
): LaunchPlan {
  const baseEnv = env(input.baseEnv)
  if (baseEnv.CLOUD_RUNTIME_ALLOW_MODELLESS_SMOKE === "1") {
    return {
      command: "/bin/sh",
      args: ["-lc", modelessSmokeScript({ spec })],
      cwd: input.workdir,
      env: {
        ...baseEnv,
        ...CloudRuntime.opencodeEnvironment(spec, input.baseEnv),
      },
      artifactManifest: path.join(input.workdir, ".opencode-cloud", "artifacts.json"),
      network: CloudRuntime.networkPolicy(spec),
      sandbox: CloudSandbox.plan(spec),
    }
  }
  return {
    command: input.baseEnv?.CLOUD_RUNTIME_OPENCODE_COMMAND ?? "opencode",
    args: ["run", input.prompt],
    cwd: input.workdir,
    env: {
      ...baseEnv,
      ...CloudRuntime.opencodeEnvironment(spec, input.baseEnv),
      ...env(input.modelCredentialEnv),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(CloudRuntime.opencodeConfig(spec)),
    },
    artifactManifest: path.join(input.workdir, ".opencode-cloud", "artifacts.json"),
    network: CloudRuntime.networkPolicy(spec),
    sandbox: CloudSandbox.plan(spec),
  }
}

export * as CloudWorker from "./worker"
