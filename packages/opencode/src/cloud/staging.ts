import path from "path"
import type { File } from "./schema"

function segment(input: string) {
  return input
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-+\./g, ".")
    .replace(/^-+|-+$/g, "")
}

export function inputName(input: { id: string; name: string }) {
  return `${segment(input.id)}-${segment(path.basename(input.name)) || "input"}`
}

export function plan(input: {
  tenantID: string
  workspaceID: string
  sessionID: string
  jobID: string
  sandboxRoot: string
  files: File[]
}) {
  if (!path.isAbsolute(input.sandboxRoot)) throw new Error("Cloud sandbox root must be absolute")

  input.files.map((file) => {
    if (file.tenantID !== input.tenantID) throw new Error("Cloud staged file tenant mismatch")
    if (file.workspaceID !== input.workspaceID) throw new Error("Cloud staged file workspace mismatch")
    if (file.sessionID && file.sessionID !== input.sessionID) throw new Error("Cloud staged file session mismatch")
  })

  const workdir = path.join(
    input.sandboxRoot,
    segment(input.tenantID),
    segment(input.workspaceID),
    segment(input.sessionID),
    segment(input.jobID),
    "work",
  )

  return {
    workdir,
    artifactManifest: path.join(workdir, ".opencode-cloud", "artifacts.json"),
    outputObjectKeyPrefix: [input.tenantID, input.workspaceID, input.sessionID, input.jobID, "artifacts"].map(segment).join("/"),
    inputs: input.files.map((file) => ({
      fileID: file.id,
      objectKey: file.objectKey,
      sandboxPath: path.join(workdir, "input", inputName({ id: file.id, name: file.name })),
    })),
  }
}

export * as CloudStaging from "./staging"
