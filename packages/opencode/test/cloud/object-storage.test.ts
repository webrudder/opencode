import { describe, expect, test } from "bun:test"
import { CloudObjectStorage } from "../../src/cloud/object-storage"

describe("CloudObjectStorage", () => {
  test("builds stable object keys for input files and artifacts", () => {
    expect(
      CloudObjectStorage.fileKey({
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        fileID: "file_abc",
        name: "../input data.csv",
      }),
    ).toBe("tenant_abc/workspace_abc/session_abc/files/file_abc/input-data.csv")

    expect(
      CloudObjectStorage.artifactKey({
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        artifactID: "artifact_abc",
        name: "report final.md",
      }),
    ).toBe("tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/artifact_abc/report-final.md")
  })

  test("plans uploads without embedding file content", () => {
    expect(
      CloudObjectStorage.uploadPlan({
        bucket: "runtime-artifacts",
        objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/input.csv",
        contentType: "text/csv",
        contentLength: 12,
        sha256: "sha256_abc",
      }),
    ).toEqual({
      bucket: "runtime-artifacts",
      objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/input.csv",
      contentType: "text/csv",
      contentLength: 12,
      sha256: "sha256_abc",
      metadata: {
        sha256: "sha256_abc",
      },
    })
  })

  test("plans signed downloads from an injected signer", () => {
    expect(
      CloudObjectStorage.downloadPlan({
        bucket: "runtime-artifacts",
        objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/artifact_abc/report.md",
        expiresAt: 1010,
        sign: (input) => `https://storage.example.com/${input.bucket}/${input.objectKey}?expires=${input.expiresAt}`,
      }),
    ).toEqual({
      bucket: "runtime-artifacts",
      objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/artifact_abc/report.md",
      expiresAt: 1010,
      url: "https://storage.example.com/runtime-artifacts/tenant_abc/workspace_abc/session_abc/jobs/job_abc/artifacts/artifact_abc/report.md?expires=1010",
    })
  })

  test("rejects unsafe object key inputs and cross-tenant access", () => {
    expect(() =>
      CloudObjectStorage.fileKey({
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        fileID: "file_abc",
        name: "../../",
      }),
    ).toThrow("Cloud object name is empty")

    expect(() =>
      CloudObjectStorage.assertTenantObjectKey({
        tenantID: "tenant_abc",
        objectKey: "tenant_other/workspace_abc/session_abc/file.csv",
      }),
    ).toThrow("Cloud object key tenant mismatch")
  })
})
