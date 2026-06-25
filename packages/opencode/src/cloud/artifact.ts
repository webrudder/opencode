import path from "path"
import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const ManifestItem = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: Schema.String,
  mime: Schema.optional(Schema.String),
  sha256: Schema.optional(Schema.String),
})
  .annotate({ identifier: "CloudArtifactManifestItem" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ManifestItem = Schema.Schema.Type<typeof ManifestItem>

export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  jobID: Schema.String,
  artifacts: Schema.Array(ManifestItem),
})
  .annotate({ identifier: "CloudArtifactManifest" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Manifest = Schema.Schema.Type<typeof Manifest>

const decode = Schema.decodeUnknownSync(Manifest)

function validatePath(item: ManifestItem) {
  if (path.isAbsolute(item.path)) throw new Error(`Artifact path must be relative: ${item.path}`)
  const parts = item.path.split(/[\\/]+/).filter(Boolean)
  if (parts.includes("..")) throw new Error(`Artifact path cannot contain parent traversal: ${item.path}`)
  return item
}

export function decodeManifest(input: unknown) {
  const manifest = decode(input)
  return {
    ...manifest,
    artifacts: manifest.artifacts.map(validatePath),
  }
}

export function decodeManifestForJob(jobID: string, input: unknown) {
  const manifest = decodeManifest(input)
  if (manifest.jobID !== jobID) throw new Error(`Artifact manifest job mismatch: ${manifest.jobID} !== ${jobID}`)
  return manifest
}

export * as CloudArtifact from "./artifact"
