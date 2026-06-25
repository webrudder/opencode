import path from "path"
import { mkdir, rm } from "fs/promises"
import { CloudObjectStorageAdapter } from "./object-storage-adapter"
import type { CloudS3StorageRunner } from "./s3-storage-runner"
import type { Artifact, File } from "./schema"
import { CloudStaging } from "./staging"

type RunnerInput = Parameters<typeof CloudS3StorageRunner.run>[0]
type RunnerOutput = Awaited<ReturnType<typeof CloudS3StorageRunner.run>>

function segment(input: string) {
  return input
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-+\./g, ".")
    .replace(/^-+|-+$/g, "")
}

function assertFile(input: {
  tenantID: string
  workspaceID: string
  sessionID: string
  file: File
}) {
  if (input.file.tenantID !== input.tenantID) throw new Error("Cloud session workspace file tenant mismatch")
  if (input.file.workspaceID !== input.workspaceID) throw new Error("Cloud session workspace file workspace mismatch")
  if (input.file.sessionID && input.file.sessionID !== input.sessionID) throw new Error("Cloud session workspace file session mismatch")
}

function assertArtifact(input: {
  tenantID: string
  workspaceID: string
  sessionID: string
  artifact: Artifact
}) {
  if (input.artifact.tenantID !== input.tenantID) throw new Error("Cloud session workspace artifact tenant mismatch")
  if (input.artifact.workspaceID !== input.workspaceID) throw new Error("Cloud session workspace artifact workspace mismatch")
  if (input.artifact.sessionID !== input.sessionID) throw new Error("Cloud session workspace artifact session mismatch")
}

export function plan(input: {
  tenantID: string
  workspaceID: string
  sessionID: string
  jobID: string
  runtimeRoot: string
  files: File[]
  artifacts: Artifact[]
}) {
  if (!path.isAbsolute(input.runtimeRoot)) throw new Error("Cloud session runtime root must be absolute")

  input.files.map((file) => assertFile({ ...input, file }))
  input.artifacts.map((artifact) => assertArtifact({ ...input, artifact }))

  const sessionRoot = path.join(input.runtimeRoot, "sessions", segment(input.sessionID))
  const workspaceDir = path.join(sessionRoot, "workspace")
  const jobDir = path.join(sessionRoot, "jobs", segment(input.jobID))
  const inputDir = path.join(jobDir, "input")
  const outputDir = path.join(jobDir, "output")

  return {
    sessionRoot,
    workspaceDir,
    jobDir,
    inputDir,
    outputDir,
    artifactManifest: path.join(jobDir, ".opencode-cloud", "artifacts.json"),
    downloads: [
      ...input.files.map((file) => ({
        source: "file" as const,
        id: file.id,
        objectKey: file.objectKey,
        targetPath: path.join(inputDir, CloudStaging.inputName({ id: file.id, name: file.name })),
      })),
      ...input.artifacts.map((artifact) => ({
        source: "artifact" as const,
        id: artifact.id,
        objectKey: artifact.objectKey,
        targetPath: path.join(
          workspaceDir,
          "artifacts",
          segment(artifact.jobID),
          CloudStaging.inputName({ id: artifact.id, name: artifact.name }),
        ),
      })),
    ],
    preserve: [workspaceDir],
    cleanup: [
      {
        path: jobDir,
        reason: "job_temporary" as const,
      },
    ],
  }
}

export async function restore(input: {
  bucket: string
  plan: ReturnType<typeof plan>
  run: (input: Omit<RunnerInput, "client">) => Promise<RunnerOutput>
}) {
  const directories = [
    input.plan.workspaceDir,
    input.plan.inputDir,
    input.plan.outputDir,
    path.dirname(input.plan.artifactManifest),
    ...input.plan.downloads.map((download) => path.dirname(download.targetPath)),
  ].filter((item, index, all) => all.indexOf(item) === index)

  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })))
  await input.run({
    operations: CloudObjectStorageAdapter.stageInputs({
      bucket: input.bucket,
      inputs: input.plan.downloads.map((download) => ({
        objectKey: download.objectKey,
        sandboxPath: download.targetPath,
      })),
    }),
  })

  return {
    directories: directories.length,
    downloads: input.plan.downloads.length,
  }
}

export async function cleanup(input: { plan: ReturnType<typeof plan> }) {
  await Promise.all(input.plan.cleanup.map((item) => rm(item.path, { recursive: true, force: true })))
  return {
    removed: input.plan.cleanup.map((item) => item.path),
  }
}

export function cacheCleanupPlan(input: {
  runtimeRoot: string
  now: number
  ttlMS: number
  sessions: Array<{ sessionID: string; lastUsedAt: number }>
}) {
  if (!path.isAbsolute(input.runtimeRoot)) throw new Error("Cloud session runtime root must be absolute")
  return {
    expired: input.sessions
      .map((session) => ({
        sessionID: session.sessionID,
        path: path.join(input.runtimeRoot, "sessions", segment(session.sessionID)),
        ageMS: Math.max(0, input.now - session.lastUsedAt),
      }))
      .filter((session) => session.ageMS >= input.ttlMS),
  }
}

export async function cleanupCache(input: { plan: ReturnType<typeof cacheCleanupPlan> }) {
  await Promise.all(input.plan.expired.map((session) => rm(session.path, { recursive: true, force: true })))
  return {
    removed: input.plan.expired.map((session) => session.path),
  }
}

export * as CloudSessionWorkspace from "./session-workspace"
