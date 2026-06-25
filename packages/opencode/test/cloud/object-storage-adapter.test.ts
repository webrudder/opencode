import { describe, expect, test } from "bun:test"
import { CloudObjectStorageAdapter } from "../../src/cloud/object-storage-adapter"

describe("CloudObjectStorageAdapter", () => {
  test("plans input upload with tenant metadata", () => {
    expect(
      CloudObjectStorageAdapter.putInput({
        bucket: "runtime",
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/input.csv",
        contentType: "text/csv",
        contentLength: 100,
        sha256: "sha256_abc",
      }),
    ).toEqual({
      action: "put",
      bucket: "runtime",
      objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/input.csv",
      contentType: "text/csv",
      contentLength: 100,
      metadata: {
        "tenant-id": "tenant_abc",
        "workspace-id": "workspace_abc",
        "session-id": "session_abc",
        sha256: "sha256_abc",
      },
    })
  })

  test("plans worker input staging and artifact upload operations", () => {
    expect(
      CloudObjectStorageAdapter.workerIO({
        bucket: "runtime",
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        stagedInputs: [
          {
            objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/input.csv",
            sandboxPath: "/sandbox/work/input/file_abc-input.csv",
          },
        ],
        artifacts: [
          {
            objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/report.md",
            contentType: "text/markdown",
            contentLength: 200,
            sha256: "sha256_report",
          },
        ],
      }),
    ).toEqual([
      {
        action: "get",
        bucket: "runtime",
        objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/input.csv",
        destinationPath: "/sandbox/work/input/file_abc-input.csv",
      },
      {
        action: "put",
        bucket: "runtime",
        objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/report.md",
        contentType: "text/markdown",
        contentLength: 200,
        metadata: {
          "tenant-id": "tenant_abc",
          "workspace-id": "workspace_abc",
          "session-id": "session_abc",
          "job-id": "job_abc",
          sha256: "sha256_report",
        },
      },
    ])
  })

  test("plans signed downloads and retention cleanup", () => {
    expect(
      CloudObjectStorageAdapter.signDownload({
        bucket: "runtime",
        objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/report.md",
        expiresAt: 2000,
      }),
    ).toEqual({
      action: "sign_download",
      bucket: "runtime",
      objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/report.md",
      expiresAt: 2000,
    })

    expect(
      CloudObjectStorageAdapter.expireWorkspace({
        bucket: "runtime",
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        notBefore: 10000,
      }),
    ).toEqual({
      action: "delete_prefix",
      bucket: "runtime",
      prefix: "tenant_abc/workspace_abc/",
      notBefore: 10000,
    })
  })
})
