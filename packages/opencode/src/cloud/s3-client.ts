import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3"
import type { CloudS3StorageRunner } from "./s3-storage-runner"

function trim(input: string) {
  return input.replace(/\/+$/, "")
}

function objectURL(input: { endpoint: string; bucket: string; objectKey: string }) {
  return `${trim(input.endpoint)}/${encodeURIComponent(input.bucket)}/${input.objectKey.split("/").map(encodeURIComponent).join("/")}`
}

function body(input: Parameters<NonNullable<CloudS3StorageRunner.Client["putObject"]>>[0]["body"]): PutObjectCommandInput["Body"] {
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  return input
}

function transformable(input: unknown): input is { transformToByteArray(): Promise<Uint8Array> } {
  return typeof input === "object" && input !== null && "transformToByteArray" in input
}

async function getBody(input: { Body?: unknown }) {
  if (transformable(input.Body)) {
    return await input.Body.transformToByteArray()
  }
  return new Uint8Array()
}

export function create(input: {
  endpoint: string | undefined
  region?: string
  accessKeyID?: string
  secretAccessKey?: string
  forcePathStyle?: boolean
}): CloudS3StorageRunner.Client {
  if (!input.endpoint) throw new Error("CLOUD_RUNTIME_OBJECT_ENDPOINT is required for object storage")
  const client = new S3Client({
    endpoint: input.endpoint,
    region: input.region ?? "us-east-1",
    forcePathStyle: input.forcePathStyle ?? true,
    ...(input.accessKeyID && input.secretAccessKey
      ? {
          credentials: {
            accessKeyId: input.accessKeyID,
            secretAccessKey: input.secretAccessKey,
          },
        }
      : {}),
  })
  return {
    putObject: async (request) => {
      const result = await client.send(
        new PutObjectCommand({
          Bucket: request.bucket,
          Key: request.objectKey,
          Body: body(request.body),
          ContentType: request.contentType,
          ContentLength: request.contentLength,
          Metadata: request.metadata,
        }),
      )
      return { etag: result.ETag }
    },
    getObject: async (request) => await getBody(await client.send(new GetObjectCommand({ Bucket: request.bucket, Key: request.objectKey }))),
    copyObject: async (request) => {
      const result = await client.send(
        new CopyObjectCommand({
          Bucket: request.bucket,
          Key: request.objectKey,
          CopySource: `/${request.sourceBucket}/${request.sourceObjectKey}`,
          Metadata: request.metadata,
          MetadataDirective: "REPLACE",
        }),
      )
      return { etag: result.CopyObjectResult?.ETag }
    },
    signDownload: async (request) => `${objectURL({ endpoint: input.endpoint!, bucket: request.bucket, objectKey: request.objectKey })}?expires=${request.expiresAt}`,
    listObjects: async (request) =>
      (await client.send(new ListObjectsV2Command({ Bucket: request.bucket, Prefix: request.prefix }))).Contents
        ?.filter((item) => item.Key && Number(item.LastModified?.getTime() ?? 0) >= request.notBefore)
        .map((item) => ({ objectKey: item.Key! })) ?? [],
    deleteObjects: async (request) => {
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: request.bucket,
          Delete: { Objects: request.objectKeys.map((Key) => ({ Key })) },
        }),
      )
      return { deleted: result.Deleted?.length ?? 0 }
    },
  }
}

export * as CloudS3Client from "./s3-client"
