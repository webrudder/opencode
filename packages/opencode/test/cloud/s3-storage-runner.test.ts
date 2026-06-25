import { describe, expect, test } from "bun:test"
import { CloudObjectStorageAdapter } from "../../src/cloud/object-storage-adapter"
import { CloudS3StorageRunner } from "../../src/cloud/s3-storage-runner"

describe("CloudS3StorageRunner", () => {
  test("executes put, copy, sign, and delete-prefix operations through an S3-compatible client", async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = []
    const result = await CloudS3StorageRunner.run({
      client: {
        putObject: async (input) => {
          calls.push({ action: "put", input })
          return { etag: "etag_put" }
        },
        copyObject: async (input) => {
          calls.push({ action: "copy", input })
          return { etag: "etag_copy" }
        },
        signDownload: async (input) => {
          calls.push({ action: "sign", input })
          return `https://storage.example.com/${input.bucket}/${input.objectKey}?expires=${input.expiresAt}`
        },
        listObjects: async (input) => {
          calls.push({ action: "list", input })
          return [{ objectKey: "tenant_abc/workspace_abc/old.txt" }]
        },
        deleteObjects: async (input) => {
          calls.push({ action: "delete", input })
          return { deleted: input.objectKeys.length }
        },
      },
      bodies: {
        "tenant_abc/workspace_abc/input.csv": "a,b\n1,2\n",
      },
      operations: [
        CloudObjectStorageAdapter.putInput({
          bucket: "runtime",
          tenantID: "tenant_abc",
          workspaceID: "workspace_abc",
          objectKey: "tenant_abc/workspace_abc/input.csv",
          contentType: "text/csv",
          contentLength: 8,
          sha256: "sha256_input",
        }),
        CloudObjectStorageAdapter.copyArtifact({
          sourceBucket: "runtime",
          sourceObjectKey: "tmp/report.md",
          bucket: "runtime",
          objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/report.md",
          tenantID: "tenant_abc",
          workspaceID: "workspace_abc",
          sessionID: "session_abc",
          jobID: "job_abc",
        }),
        CloudObjectStorageAdapter.signDownload({
          bucket: "runtime",
          objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/report.md",
          expiresAt: 2000,
        }),
        CloudObjectStorageAdapter.expireWorkspace({
          bucket: "runtime",
          tenantID: "tenant_abc",
          workspaceID: "workspace_abc",
          notBefore: 1000,
        }),
      ],
    })

    expect(result).toEqual({
      puts: 1,
      gets: 0,
      copies: 1,
      signedDownloads: [
        {
          bucket: "runtime",
          objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/report.md",
          url: "https://storage.example.com/runtime/tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/report.md?expires=2000",
          expiresAt: 2000,
        },
      ],
      deleted: 1,
    })
    expect(calls).toEqual([
      {
        action: "put",
        input: {
          bucket: "runtime",
          objectKey: "tenant_abc/workspace_abc/input.csv",
          body: "a,b\n1,2\n",
          contentType: "text/csv",
          contentLength: 8,
          metadata: {
            "tenant-id": "tenant_abc",
            "workspace-id": "workspace_abc",
            sha256: "sha256_input",
          },
        },
      },
      {
        action: "copy",
        input: {
          sourceBucket: "runtime",
          sourceObjectKey: "tmp/report.md",
          bucket: "runtime",
          objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/report.md",
          metadata: {
            "tenant-id": "tenant_abc",
            "workspace-id": "workspace_abc",
            "session-id": "session_abc",
            "job-id": "job_abc",
          },
        },
      },
      {
        action: "sign",
        input: {
          bucket: "runtime",
          objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/report.md",
          expiresAt: 2000,
        },
      },
      {
        action: "list",
        input: {
          bucket: "runtime",
          prefix: "tenant_abc/workspace_abc/",
          notBefore: 1000,
        },
      },
      {
        action: "delete",
        input: {
          bucket: "runtime",
          objectKeys: ["tenant_abc/workspace_abc/old.txt"],
        },
      },
    ])
  })

  test("stages get operations to local files using the downloaded body", async () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/opencode-s3-runner/input.csv`

    const result = await CloudS3StorageRunner.run({
      client: {
        getObject: async () => "a,b\n1,2\n",
      },
      operations: [
        {
          action: "get",
          bucket: "runtime",
          objectKey: "tenant_abc/workspace_abc/input.csv",
          destinationPath: path,
        },
      ],
    })

    expect(result.gets).toBe(1)
    expect(await Bun.file(path).text()).toBe("a,b\n1,2\n")
  })

  test("fails put operations when no body is provided for the object key", async () => {
    await expect(
      CloudS3StorageRunner.run({
        client: {
          putObject: async () => ({ etag: "etag" }),
        },
        operations: [
          CloudObjectStorageAdapter.putInput({
            bucket: "runtime",
            tenantID: "tenant_abc",
            workspaceID: "workspace_abc",
            objectKey: "tenant_abc/workspace_abc/missing.csv",
            contentLength: 0,
          }),
        ],
      }),
    ).rejects.toThrow("Cloud S3 object body not found")
  })
})
