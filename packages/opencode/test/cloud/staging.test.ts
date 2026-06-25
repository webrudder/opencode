import { describe, expect, test } from "bun:test"
import { CloudStaging } from "../../src/cloud/staging"

const file = {
  id: "file_abc",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  name: "report input.csv",
  mime: "text/csv",
  size: 100,
  objectKey: "tenant_abc/workspace_abc/session_abc/file_abc/input.csv",
  sha256: "abc",
  time: { created: 1, updated: 1 },
}

describe("CloudStaging", () => {
  test("plans sandbox paths for input files", () => {
    expect(
      CloudStaging.plan({
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        sandboxRoot: "/sandbox/jobs",
        files: [file],
      }),
    ).toEqual({
      workdir: "/sandbox/jobs/tenant_abc/workspace_abc/session_abc/job_abc/work",
      artifactManifest: "/sandbox/jobs/tenant_abc/workspace_abc/session_abc/job_abc/work/.opencode-cloud/artifacts.json",
      outputObjectKeyPrefix: "tenant_abc/workspace_abc/session_abc/job_abc/artifacts",
      inputs: [
        {
          fileID: "file_abc",
          objectKey: "tenant_abc/workspace_abc/session_abc/file_abc/input.csv",
          sandboxPath:
            "/sandbox/jobs/tenant_abc/workspace_abc/session_abc/job_abc/work/input/file_abc-report-input.csv",
        },
      ],
    })
  })

  test("rejects files outside the requested tenant workspace or session", () => {
    expect(() =>
      CloudStaging.plan({
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        sandboxRoot: "/sandbox/jobs",
        files: [{ ...file, tenantID: "tenant_xyz" }],
      }),
    ).toThrow("Cloud staged file tenant mismatch")

    expect(() =>
      CloudStaging.plan({
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        sandboxRoot: "/sandbox/jobs",
        files: [{ ...file, sessionID: "session_xyz" }],
      }),
    ).toThrow("Cloud staged file session mismatch")
  })

  test("sanitizes unsafe file names and rejects unsafe sandbox roots", () => {
    expect(
      CloudStaging.inputName({
        id: "file_abc",
        name: "../weird name!!.csv",
      }),
    ).toBe("file_abc-weird-name.csv")

    expect(() =>
      CloudStaging.plan({
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        sandboxRoot: "relative/root",
        files: [file],
      }),
    ).toThrow("Cloud sandbox root must be absolute")
  })
})
