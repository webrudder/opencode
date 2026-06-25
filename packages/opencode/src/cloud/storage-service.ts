import type { CloudAPI } from "./api"
import path from "path"
import { CloudArtifact, type Manifest } from "./artifact"
import { CloudObjectStorage } from "./object-storage"
import { CloudObjectStorageAdapter } from "./object-storage-adapter"
import type { CloudS3StorageRunner } from "./s3-storage-runner"

type RunnerInput = Parameters<typeof CloudS3StorageRunner.run>[0]
type RunnerOutput = Awaited<ReturnType<typeof CloudS3StorageRunner.run>>

function content(input: CloudAPI.CreateFileRequest) {
  if (!input.contentBase64) return new Uint8Array()
  return new Uint8Array(Buffer.from(input.contentBase64, "base64"))
}

export async function stageFile(input: {
  bucket: string
  fileID: string
  request: CloudAPI.CreateFileRequest & { tenantID: string }
  run: (input: Omit<RunnerInput, "client">) => Promise<RunnerOutput>
}) {
  const body = content(input.request)
  const objectKey = CloudObjectStorage.fileKey({
    tenantID: input.request.tenantID,
    workspaceID: input.request.workspaceID,
    sessionID: input.request.sessionID,
    fileID: input.fileID,
    name: input.request.name,
  })
  await input.run({
    operations: [
      CloudObjectStorageAdapter.putInput({
        bucket: input.bucket,
        tenantID: input.request.tenantID,
        workspaceID: input.request.workspaceID,
        sessionID: input.request.sessionID,
        objectKey,
        contentType: input.request.mime,
        contentLength: body.byteLength,
      }),
    ],
    bodies: { [objectKey]: body },
  })
  return {
    objectKey,
    size: body.byteLength,
  }
}

export async function signArtifactDownload(input: {
  bucket: string
  artifact: { objectKey: string }
  expiresAt: number
  run: (input: Omit<RunnerInput, "client">) => Promise<RunnerOutput>
}) {
  return (
    await input.run({
      operations: [
        CloudObjectStorageAdapter.signDownload({
          bucket: input.bucket,
          objectKey: input.artifact.objectKey,
          expiresAt: input.expiresAt,
        }),
      ],
    })
  ).signedDownloads[0]?.url
}

async function artifactBodies(input: {
  workdir: string
  objectKeyPrefix: string
  artifacts: Manifest["artifacts"]
}) {
  return Object.fromEntries(
    await Promise.all(
      input.artifacts.map(async (artifact) => [
        `${input.objectKeyPrefix.replace(/\/+$/, "")}/${artifact.path}`,
        new Uint8Array(await Bun.file(path.join(input.workdir, artifact.path)).arrayBuffer()),
      ]),
    ),
  )
}

export async function uploadArtifacts(input: {
  bucket: string
  tenantID: string
  workspaceID: string
  sessionID: string
  jobID: string
  workdir: string
  objectKeyPrefix: string
  manifest: Manifest
  sizeByPath: Record<string, number>
  run: (input: Omit<RunnerInput, "client">) => Promise<RunnerOutput>
}) {
  const manifest = CloudArtifact.decodeManifestForJob(input.jobID, input.manifest)
  await input.run({
    operations: manifest.artifacts.map((artifact) =>
      CloudObjectStorageAdapter.putArtifact({
        bucket: input.bucket,
        tenantID: input.tenantID,
        workspaceID: input.workspaceID,
        sessionID: input.sessionID,
        jobID: input.jobID,
        objectKey: `${input.objectKeyPrefix.replace(/\/+$/, "")}/${artifact.path}`,
        contentType: artifact.mime,
        contentLength: input.sizeByPath[artifact.path] ?? 0,
        sha256: artifact.sha256,
      }),
    ),
    bodies: await artifactBodies({
      workdir: input.workdir,
      objectKeyPrefix: input.objectKeyPrefix,
      artifacts: manifest.artifacts,
    }),
  })
}

export * as CloudStorageService from "./storage-service"
