import path from "path"

function segment(input: string) {
  return input
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-+\./g, ".")
    .replace(/^-+|-+$/g, "")
}

function objectName(input: string) {
  const base = path.basename(input)
  if (base === "." || base === "..") throw new Error("Cloud object name is empty")
  const result = segment(base)
  if (!result) throw new Error("Cloud object name is empty")
  return result
}

function parts(input: string[]) {
  return input.map(segment).join("/")
}

export function assertTenantObjectKey(input: { tenantID: string; objectKey: string }) {
  if (!input.objectKey.startsWith(`${segment(input.tenantID)}/`)) throw new Error("Cloud object key tenant mismatch")
  return input.objectKey
}

export function fileKey(input: {
  tenantID: string
  workspaceID: string
  sessionID?: string
  fileID: string
  name: string
}) {
  return parts([
    input.tenantID,
    input.workspaceID,
    input.sessionID ?? "workspace",
    "files",
    input.fileID,
    objectName(input.name),
  ])
}

export function artifactKey(input: {
  tenantID: string
  workspaceID: string
  sessionID: string
  jobID: string
  artifactID: string
  name: string
}) {
  return parts([
    input.tenantID,
    input.workspaceID,
    input.sessionID,
    "jobs",
    input.jobID,
    "artifacts",
    input.artifactID,
    objectName(input.name),
  ])
}

export function uploadPlan(input: {
  bucket: string
  objectKey: string
  contentType?: string
  contentLength: number
  sha256?: string
}) {
  return {
    bucket: input.bucket,
    objectKey: input.objectKey,
    ...(input.contentType ? { contentType: input.contentType } : {}),
    contentLength: input.contentLength,
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    metadata: {
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
    },
  }
}

export function downloadPlan(input: {
  bucket: string
  objectKey: string
  expiresAt: number
  sign: (input: { bucket: string; objectKey: string; expiresAt: number }) => string
}) {
  return {
    bucket: input.bucket,
    objectKey: input.objectKey,
    expiresAt: input.expiresAt,
    url: input.sign({
      bucket: input.bucket,
      objectKey: input.objectKey,
      expiresAt: input.expiresAt,
    }),
  }
}

export * as CloudObjectStorage from "./object-storage"
