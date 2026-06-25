import { mkdir } from "fs/promises"
import path from "path"
import { CloudArtifact, type Manifest } from "./artifact"
import type { LaunchPlan } from "./worker"

export type SpawnResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type Result =
  | {
      status: "succeeded"
      manifest: Manifest
      sizeByPath: Record<string, number>
    }
  | {
      status: "failed"
      exitCode?: number
      message: string
      stdout?: string
      stderr?: string
    }

type Spawn = (input: { launch: LaunchPlan }) => Promise<SpawnResult>

function message(input: SpawnResult) {
  const detail = input.stderr.trim() || input.stdout.trim()
  if (!detail) return `Local opencode executor exited with code ${input.exitCode}`
  return `Local opencode executor exited with code ${input.exitCode}: ${detail}`
}

function outputDetail(input: SpawnResult) {
  const detail = input.stderr.trim() || input.stdout.trim()
  if (!detail) return ""
  return `: ${detail.slice(0, 4000)}`
}

async function spawn(input: { launch: LaunchPlan }): Promise<SpawnResult> {
  const proc = Bun.spawn({
    cmd: [input.launch.command, ...input.launch.args],
    cwd: input.launch.cwd,
    env: input.launch.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function fileSize(input: { root: string; path: string }) {
  return (await Bun.file(path.join(input.root, input.path)).arrayBuffer()).byteLength
}

export async function execute(input: {
  jobID: string
  launch: LaunchPlan
  spawn?: Spawn
}): Promise<Result> {
  await mkdir(input.launch.cwd, { recursive: true })
  const result = await (input.spawn ?? spawn)({ launch: input.launch })
  if (result.exitCode !== 0) {
    return {
      status: "failed",
      exitCode: result.exitCode,
      message: message(result),
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }
  const manifestFile = Bun.file(input.launch.artifactManifest)
  if (!(await manifestFile.exists())) {
    return {
      status: "failed",
      message: `Local opencode executor artifact manifest not found${outputDetail(result)}`,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }
  try {
    const manifest = CloudArtifact.decodeManifestForJob(input.jobID, await manifestFile.json())
    return {
      status: "succeeded",
      manifest,
      sizeByPath: Object.fromEntries(
        await Promise.all(
          manifest.artifacts.map(async (artifact) => [artifact.path, await fileSize({ root: input.launch.cwd, path: artifact.path })]),
        ),
      ),
    }
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }
}

export * as CloudLocalExecutor from "./local-executor"
