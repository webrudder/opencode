import { describe, expect, test } from "bun:test"
import path from "path"
import { CloudObjectStorage } from "../../src/cloud/object-storage"
import { CloudS3StorageRunner } from "../../src/cloud/s3-storage-runner"
import { CloudStorageService } from "../../src/cloud/storage-service"

describe("CloudStorageService", () => {
  test("stages API file uploads through an S3-compatible runner", async () => {
    const calls: unknown[] = []
    const result = await CloudStorageService.stageFile({
      bucket: "runtime-artifacts",
      fileID: "file_abc",
      request: {
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        name: "input.csv",
        mime: "text/csv",
        contentBase64: Buffer.from("a,b\n1,2\n").toString("base64"),
      },
      run: (input) => {
        calls.push(input)
        return CloudS3StorageRunner.run({
          ...input,
          client: {
            putObject: async (operation) => {
              calls.push(operation)
              return { etag: "etag_abc" }
            },
          },
        })
      },
    })

    expect(result).toEqual({
      objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/input.csv",
      size: 8,
    })
    expect(calls).toEqual([
      {
        operations: [
          {
            action: "put",
            bucket: "runtime-artifacts",
            objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/input.csv",
            contentType: "text/csv",
            contentLength: 8,
            metadata: {
              "tenant-id": "tenant_abc",
              "workspace-id": "workspace_abc",
              "session-id": "session_abc",
            },
          },
        ],
        bodies: {
          "tenant_abc/workspace_abc/session_abc/files/file_abc/input.csv": new Uint8Array(Buffer.from("a,b\n1,2\n")),
        },
      },
      {
        bucket: "runtime-artifacts",
        objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/input.csv",
        body: new Uint8Array(Buffer.from("a,b\n1,2\n")),
        contentType: "text/csv",
        contentLength: 8,
        metadata: {
          "tenant-id": "tenant_abc",
          "workspace-id": "workspace_abc",
          "session-id": "session_abc",
        },
      },
    ])
  })

  test("signs artifact downloads through an S3-compatible runner", async () => {
    expect(
      await CloudStorageService.signArtifactDownload({
        bucket: "runtime-artifacts",
        artifact: {
          objectKey: CloudObjectStorage.artifactKey({
            tenantID: "tenant_abc",
            workspaceID: "workspace_abc",
            sessionID: "session_abc",
            jobID: "job_abc",
            artifactID: "artifact_abc",
            name: "report.md",
          }),
        },
        expiresAt: 1000,
        run: (input) =>
          CloudS3StorageRunner.run({
            ...input,
            client: {
              signDownload: async (operation) =>
                `https://storage.example.com/${operation.bucket}/${operation.objectKey}?expires=${operation.expiresAt}`,
            },
          }),
      }),
    ).toBe(
      "https://storage.example.com/runtime-artifacts/tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/artifact_abc/report.md?expires=1000",
    )
  })

  test("uploads completed worker artifacts from the local workdir", async () => {
    const workdir = path.join(process.env.TMPDIR ?? "/tmp", "opencode-storage-service-artifacts")
    await Bun.write(path.join(workdir, "report.md"), "# Report\n")
    const calls: unknown[] = []

    await CloudStorageService.uploadArtifacts({
      bucket: "runtime-artifacts",
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      jobID: "job_abc",
      workdir,
      objectKeyPrefix: "tenant_abc/job_abc/artifacts",
      manifest: {
        version: 1,
        jobID: "job_abc",
        artifacts: [{ name: "report.md", path: "report.md", kind: "md", mime: "text/markdown", sha256: "sha_abc" }],
      },
      sizeByPath: { "report.md": 9 },
      run: (input) => {
        calls.push(input)
        return CloudS3StorageRunner.run({
          ...input,
          client: {
            putObject: async (operation) => {
              calls.push(operation)
              return { etag: "etag_abc" }
            },
          },
        })
      },
    })

    expect(calls).toEqual([
      {
        operations: [
          {
            action: "put",
            bucket: "runtime-artifacts",
            objectKey: "tenant_abc/job_abc/artifacts/report.md",
            contentType: "text/markdown",
            contentLength: 9,
            metadata: {
              "tenant-id": "tenant_abc",
              "workspace-id": "workspace_abc",
              "session-id": "session_abc",
              "job-id": "job_abc",
              sha256: "sha_abc",
            },
          },
        ],
        bodies: {
          "tenant_abc/job_abc/artifacts/report.md": new Uint8Array(Buffer.from("# Report\n")),
        },
      },
      {
        bucket: "runtime-artifacts",
        objectKey: "tenant_abc/job_abc/artifacts/report.md",
        body: new Uint8Array(Buffer.from("# Report\n")),
        contentType: "text/markdown",
        contentLength: 9,
        metadata: {
          "tenant-id": "tenant_abc",
          "workspace-id": "workspace_abc",
          "session-id": "session_abc",
          "job-id": "job_abc",
          sha256: "sha_abc",
        },
      },
    ])
  })
})
