export type Operation =
  | {
      action: "put"
      bucket: string
      objectKey: string
      contentType?: string
      contentLength: number
      metadata: Record<string, string>
    }
  | {
      action: "get"
      bucket: string
      objectKey: string
      destinationPath: string
    }
  | {
      action: "copy"
      sourceBucket: string
      sourceObjectKey: string
      bucket: string
      objectKey: string
      metadata: Record<string, string>
    }
  | {
      action: "sign_download"
      bucket: string
      objectKey: string
      expiresAt: number
    }
  | {
      action: "delete_prefix"
      bucket: string
      prefix: string
      notBefore: number
    }

function metadata(input: { tenantID: string; workspaceID?: string; sessionID?: string; jobID?: string; sha256?: string }) {
  return {
    "tenant-id": input.tenantID,
    ...(input.workspaceID ? { "workspace-id": input.workspaceID } : {}),
    ...(input.sessionID ? { "session-id": input.sessionID } : {}),
    ...(input.jobID ? { "job-id": input.jobID } : {}),
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
  }
}

export function putInput(input: {
  bucket: string
  tenantID: string
  workspaceID: string
  sessionID?: string
  objectKey: string
  contentType?: string
  contentLength: number
  sha256?: string
}): Operation {
  return {
    action: "put",
    bucket: input.bucket,
    objectKey: input.objectKey,
    contentType: input.contentType,
    contentLength: input.contentLength,
    metadata: metadata(input),
  }
}

export function stageInputs(input: {
  bucket: string
  inputs: Array<{
    objectKey: string
    sandboxPath: string
  }>
}): Operation[] {
  return input.inputs.map((item) => ({
    action: "get",
    bucket: input.bucket,
    objectKey: item.objectKey,
    destinationPath: item.sandboxPath,
  }))
}

export function putArtifact(input: {
  bucket: string
  tenantID: string
  workspaceID: string
  sessionID: string
  jobID: string
  objectKey: string
  contentType?: string
  contentLength: number
  sha256?: string
}): Operation {
  return {
    action: "put",
    bucket: input.bucket,
    objectKey: input.objectKey,
    contentType: input.contentType,
    contentLength: input.contentLength,
    metadata: metadata(input),
  }
}

export function copyArtifact(input: {
  sourceBucket: string
  sourceObjectKey: string
  bucket: string
  objectKey: string
  tenantID: string
  workspaceID: string
  sessionID: string
  jobID: string
  sha256?: string
}): Operation {
  return {
    action: "copy",
    sourceBucket: input.sourceBucket,
    sourceObjectKey: input.sourceObjectKey,
    bucket: input.bucket,
    objectKey: input.objectKey,
    metadata: metadata(input),
  }
}

export function signDownload(input: { bucket: string; objectKey: string; expiresAt: number }): Operation {
  return {
    action: "sign_download",
    bucket: input.bucket,
    objectKey: input.objectKey,
    expiresAt: input.expiresAt,
  }
}

export function expireWorkspace(input: {
  bucket: string
  tenantID: string
  workspaceID: string
  notBefore: number
}): Operation {
  return {
    action: "delete_prefix",
    bucket: input.bucket,
    prefix: `${input.tenantID}/${input.workspaceID}/`,
    notBefore: input.notBefore,
  }
}

export function workerIO(input: {
  bucket: string
  tenantID: string
  workspaceID: string
  sessionID: string
  jobID: string
  stagedInputs: Array<{ objectKey: string; sandboxPath: string }>
  artifacts: Array<{ objectKey: string; contentType?: string; contentLength: number; sha256?: string }>
}) {
  return [
    ...stageInputs({ bucket: input.bucket, inputs: input.stagedInputs }),
    ...input.artifacts.map((artifact) =>
      putArtifact({
        bucket: input.bucket,
        tenantID: input.tenantID,
        workspaceID: input.workspaceID,
        sessionID: input.sessionID,
        jobID: input.jobID,
        objectKey: artifact.objectKey,
        contentType: artifact.contentType,
        contentLength: artifact.contentLength,
        sha256: artifact.sha256,
      }),
    ),
  ]
}

export * as CloudObjectStorageAdapter from "./object-storage-adapter"
