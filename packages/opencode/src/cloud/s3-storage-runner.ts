import type { CloudObjectStorageAdapter } from "./object-storage-adapter"

type Body = string | Uint8Array | ArrayBuffer | Blob

export type Client = {
  putObject?: (input: {
    bucket: string
    objectKey: string
    body: Body
    contentType?: string
    contentLength: number
    metadata: Record<string, string>
  }) => Promise<{ etag?: string }>
  getObject?: (input: { bucket: string; objectKey: string }) => Promise<Body>
  copyObject?: (input: {
    sourceBucket: string
    sourceObjectKey: string
    bucket: string
    objectKey: string
    metadata: Record<string, string>
  }) => Promise<{ etag?: string }>
  signDownload?: (input: { bucket: string; objectKey: string; expiresAt: number }) => Promise<string>
  listObjects?: (input: { bucket: string; prefix: string; notBefore: number }) => Promise<Array<{ objectKey: string }>>
  deleteObjects?: (input: { bucket: string; objectKeys: string[] }) => Promise<{ deleted: number }>
}

function body(input: {
  bodies?: Record<string, Body>
  operation: CloudObjectStorageAdapter.Operation & { action: "put" }
}) {
  const result = input.bodies?.[input.operation.objectKey]
  if (result !== undefined) return result
  throw new Error(`Cloud S3 object body not found: ${input.operation.objectKey}`)
}

async function writeFile(input: { destinationPath: string; body: Body }) {
  await Bun.write(
    input.destinationPath,
    input.body instanceof Blob || typeof input.body === "string" ? input.body : new Uint8Array(input.body),
  )
}

function requireMethod<T>(input: T | undefined, name: string): T {
  if (input) return input
  throw new Error(`Cloud S3 client ${name} is not configured`)
}

export async function run(input: {
  client: Client
  operations: CloudObjectStorageAdapter.Operation[]
  bodies?: Record<string, Body>
}) {
  const result = {
    puts: 0,
    gets: 0,
    copies: 0,
    signedDownloads: [] as Array<{ bucket: string; objectKey: string; url: string; expiresAt: number }>,
    deleted: 0,
  }

  for (const operation of input.operations) {
    if (operation.action === "put") {
      await requireMethod(input.client.putObject, "putObject")({
        bucket: operation.bucket,
        objectKey: operation.objectKey,
        body: body({ bodies: input.bodies, operation }),
        contentType: operation.contentType,
        contentLength: operation.contentLength,
        metadata: operation.metadata,
      })
      result.puts += 1
      continue
    }
    if (operation.action === "get") {
      await writeFile({
        destinationPath: operation.destinationPath,
        body: await requireMethod(input.client.getObject, "getObject")({
          bucket: operation.bucket,
          objectKey: operation.objectKey,
        }),
      })
      result.gets += 1
      continue
    }
    if (operation.action === "copy") {
      await requireMethod(input.client.copyObject, "copyObject")({
        sourceBucket: operation.sourceBucket,
        sourceObjectKey: operation.sourceObjectKey,
        bucket: operation.bucket,
        objectKey: operation.objectKey,
        metadata: operation.metadata,
      })
      result.copies += 1
      continue
    }
    if (operation.action === "sign_download") {
      result.signedDownloads.push({
        bucket: operation.bucket,
        objectKey: operation.objectKey,
        url: await requireMethod(input.client.signDownload, "signDownload")({
          bucket: operation.bucket,
          objectKey: operation.objectKey,
          expiresAt: operation.expiresAt,
        }),
        expiresAt: operation.expiresAt,
      })
      continue
    }
    const objects = await requireMethod(input.client.listObjects, "listObjects")({
      bucket: operation.bucket,
      prefix: operation.prefix,
      notBefore: operation.notBefore,
    })
    if (objects.length === 0) continue
    result.deleted += (
      await requireMethod(input.client.deleteObjects, "deleteObjects")({
        bucket: operation.bucket,
        objectKeys: objects.map((item) => item.objectKey),
      })
    ).deleted
  }

  return result
}

export * as CloudS3StorageRunner from "./s3-storage-runner"
