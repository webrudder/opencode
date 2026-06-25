import { mkdtemp, mkdir, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import type { CloudWorker } from "../../src/cloud/worker"
import { CloudLocalExecutor } from "../../src/cloud/local-executor"

function launch(workdir: string): CloudWorker.LaunchPlan {
  return {
    command: "opencode",
    args: ["run", "Summarize"],
    cwd: workdir,
    env: { OPENCODE_DISABLE_AUTOUPDATE: "true" },
    artifactManifest: path.join(workdir, ".opencode-cloud", "artifacts.json"),
    network: { allowHosts: [] },
    sandbox: {
      jobID: "job_abc",
      tenantID: "tenant_abc",
      image: "cloud-runtime-opencode:1.14.28",
      isolation: "container",
      resources: { cpu: 2, memoryMB: 4096, diskMB: 10240, timeoutMS: 900000 },
      security: { runAsNonRoot: true, readOnlyRootFilesystem: false, allowPrivilegeEscalation: false },
      network: { allowHosts: [] },
    },
  }
}

describe("CloudLocalExecutor", () => {
  test("runs a launch plan and returns manifest with artifact sizes", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "cloud-local-executor-"))
    const result = await CloudLocalExecutor.execute({
      jobID: "job_abc",
      launch: launch(workdir),
      spawn: async (input) => {
        await mkdir(path.dirname(input.launch.artifactManifest), { recursive: true })
        await writeFile(path.join(input.launch.cwd, "summary.md"), "# Summary")
        await writeFile(
          input.launch.artifactManifest,
          JSON.stringify({
            version: 1,
            jobID: "job_abc",
            artifacts: [{ name: "summary.md", path: "summary.md", kind: "md", mime: "text/markdown" }],
          }),
        )
        return { exitCode: 0, stdout: "done", stderr: "" }
      },
    })

    expect(result).toMatchObject({
      status: "succeeded",
      manifest: {
        jobID: "job_abc",
        artifacts: [{ name: "summary.md", path: "summary.md", kind: "md" }],
      },
      sizeByPath: { "summary.md": 9 },
    })
  })

  test("returns failed when the process exits non-zero", async () => {
    const result = await CloudLocalExecutor.execute({
      jobID: "job_abc",
      launch: launch(await mkdtemp(path.join(os.tmpdir(), "cloud-local-executor-"))),
      spawn: async () => ({ exitCode: 2, stdout: "partial", stderr: "boom" }),
    })

    expect(result).toEqual({
      status: "failed",
      exitCode: 2,
      message: "Local opencode executor exited with code 2: boom",
      stdout: "partial",
      stderr: "boom",
    })
  })

  test("returns failed when the manifest is missing", async () => {
    const result = await CloudLocalExecutor.execute({
      jobID: "job_abc",
      launch: launch(await mkdtemp(path.join(os.tmpdir(), "cloud-local-executor-"))),
      spawn: async () => ({ exitCode: 0, stdout: "done", stderr: "" }),
    })

    expect(result).toMatchObject({
      status: "failed",
      message: "Local opencode executor artifact manifest not found: done",
    })
  })

  test("returns failed when the manifest does not match the job", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "cloud-local-executor-"))
    const result = await CloudLocalExecutor.execute({
      jobID: "job_abc",
      launch: launch(workdir),
      spawn: async (input) => {
        await mkdir(path.dirname(input.launch.artifactManifest), { recursive: true })
        await writeFile(input.launch.artifactManifest, JSON.stringify({ version: 1, jobID: "job_other", artifacts: [] }))
        return { exitCode: 0, stdout: "done", stderr: "" }
      },
    })

    expect(result).toMatchObject({
      status: "failed",
      message: "Artifact manifest job mismatch: job_other !== job_abc",
    })
  })
})
