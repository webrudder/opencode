import { describe, expect, test } from "bun:test"
import { CloudArtifact } from "../../src/cloud/artifact"

describe("CloudArtifact", () => {
  test("decodes artifact manifests for a job", () => {
    expect(
      CloudArtifact.decodeManifest({
        version: 1,
        jobID: "job_123",
        artifacts: [
          {
            name: "summary.md",
            path: "reports/summary.md",
            kind: "md",
            mime: "text/markdown",
          },
          {
            name: "data.json",
            path: "data/output.json",
            kind: "json",
          },
        ],
      }).artifacts.map((item) => item.path),
    ).toEqual(["reports/summary.md", "data/output.json"])
  })

  test("rejects manifests for a different job", () => {
    expect(() =>
      CloudArtifact.decodeManifestForJob("job_expected", {
        version: 1,
        jobID: "job_actual",
        artifacts: [],
      }),
    ).toThrow("Artifact manifest job mismatch")
  })

  test("rejects absolute artifact paths", () => {
    expect(() =>
      CloudArtifact.decodeManifest({
        version: 1,
        jobID: "job_123",
        artifacts: [{ name: "secret", path: "/etc/passwd", kind: "txt" }],
      }),
    ).toThrow("Artifact path must be relative")
  })

  test("rejects artifact paths that escape the workdir", () => {
    expect(() =>
      CloudArtifact.decodeManifest({
        version: 1,
        jobID: "job_123",
        artifacts: [{ name: "secret", path: "../secret.txt", kind: "txt" }],
      }),
    ).toThrow("Artifact path cannot contain parent traversal")
  })
})
