import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, stat, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { CloudSessionWorkspace } from "../../src/cloud/session-workspace"

const file = {
  id: "file_abc",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  name: "claims export.csv",
  mime: "text/csv",
  size: 123,
  objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/claims.csv",
  time: { created: 1, updated: 1 },
}

const artifact = {
  id: "artifact_abc",
  tenantID: "tenant_abc",
  workspaceID: "workspace_abc",
  sessionID: "session_abc",
  jobID: "job_prev",
  name: "report.md",
  kind: "md",
  size: 456,
  objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_prev/artifacts/artifact_abc/report.md",
  time: { created: 1, updated: 1 },
}

describe("CloudSessionWorkspace", () => {
  test("plans shared session workspace paths and restore targets", () => {
    expect(
      CloudSessionWorkspace.plan({
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        runtimeRoot: "/runtime",
        files: [file],
        artifacts: [artifact],
      }),
    ).toEqual({
      sessionRoot: "/runtime/sessions/session_abc",
      workspaceDir: "/runtime/sessions/session_abc/workspace",
      jobDir: "/runtime/sessions/session_abc/jobs/job_abc",
      inputDir: "/runtime/sessions/session_abc/jobs/job_abc/input",
      outputDir: "/runtime/sessions/session_abc/jobs/job_abc/output",
      artifactManifest: "/runtime/sessions/session_abc/jobs/job_abc/.opencode-cloud/artifacts.json",
      downloads: [
        {
          source: "file",
          id: "file_abc",
          objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/claims.csv",
          targetPath: "/runtime/sessions/session_abc/jobs/job_abc/input/file_abc-claims-export.csv",
        },
        {
          source: "artifact",
          id: "artifact_abc",
          objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_prev/artifacts/artifact_abc/report.md",
          targetPath: "/runtime/sessions/session_abc/workspace/artifacts/job_prev/artifact_abc-report.md",
        },
      ],
      preserve: ["/runtime/sessions/session_abc/workspace"],
      cleanup: [
        {
          path: "/runtime/sessions/session_abc/jobs/job_abc",
          reason: "job_temporary",
        },
      ],
    })
  })

  test("rejects cross-boundary restore inputs and unsafe runtime roots", () => {
    expect(() =>
      CloudSessionWorkspace.plan({
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        runtimeRoot: "relative",
        files: [file],
        artifacts: [],
      }),
    ).toThrow("Cloud session runtime root must be absolute")

    expect(() =>
      CloudSessionWorkspace.plan({
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        runtimeRoot: "/runtime",
        files: [{ ...file, tenantID: "tenant_other" }],
        artifacts: [],
      }),
    ).toThrow("Cloud session workspace file tenant mismatch")

    expect(() =>
      CloudSessionWorkspace.plan({
        tenantID: "tenant_abc",
        workspaceID: "workspace_abc",
        sessionID: "session_abc",
        jobID: "job_abc",
        runtimeRoot: "/runtime",
        files: [],
        artifacts: [{ ...artifact, sessionID: "session_other" }],
      }),
    ).toThrow("Cloud session workspace artifact session mismatch")
  })

  test("restores inputs and previous artifacts then cleans temporary job directories", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-session-workspace-"))
    const plan = CloudSessionWorkspace.plan({
      tenantID: "tenant_abc",
      workspaceID: "workspace_abc",
      sessionID: "session_abc",
      jobID: "job_abc",
      runtimeRoot,
      files: [file],
      artifacts: [artifact],
    })
    const operations: Array<{ objectKey: string; destinationPath: string }> = []

    const restored = await CloudSessionWorkspace.restore({
      bucket: "runtime",
      plan,
      run: async (input) => {
        operations.push(
          ...input.operations
            .filter((operation) => operation.action === "get")
            .map((operation) => ({
              objectKey: operation.objectKey,
              destinationPath: operation.destinationPath,
            })),
        )
        await Promise.all(
          input.operations
            .filter((operation) => operation.action === "get")
            .map((operation) => Bun.write(operation.destinationPath, `body:${operation.objectKey}`)),
        )
        return { puts: 0, gets: input.operations.length, copies: 0, signedDownloads: [], deleted: 0 }
      },
    })

    expect(restored).toEqual({ directories: 5, downloads: 2 })
    expect(operations).toEqual([
      {
        objectKey: "tenant_abc/workspace_abc/session_abc/files/file_abc/claims.csv",
        destinationPath: path.join(runtimeRoot, "sessions/session_abc/jobs/job_abc/input/file_abc-claims-export.csv"),
      },
      {
        objectKey: "tenant_abc/workspace_abc/session_abc/jobs/job_prev/artifacts/artifact_abc/report.md",
        destinationPath: path.join(runtimeRoot, "sessions/session_abc/workspace/artifacts/job_prev/artifact_abc-report.md"),
      },
    ])
    expect(await Bun.file(path.join(runtimeRoot, "sessions/session_abc/jobs/job_abc/input/file_abc-claims-export.csv")).text()).toBe(
      "body:tenant_abc/workspace_abc/session_abc/files/file_abc/claims.csv",
    )
    expect(
      await Bun.file(path.join(runtimeRoot, "sessions/session_abc/workspace/artifacts/job_prev/artifact_abc-report.md")).text(),
    ).toBe("body:tenant_abc/workspace_abc/session_abc/jobs/job_prev/artifacts/artifact_abc/report.md")

    await mkdir(path.join(plan.jobDir, "nested"), { recursive: true })
    await writeFile(path.join(plan.jobDir, "nested/temp.txt"), "temporary")

    expect(await CloudSessionWorkspace.cleanup({ plan })).toEqual({ removed: [plan.jobDir] })
    expect(await Bun.file(path.join(plan.jobDir, "nested/temp.txt")).exists()).toBe(false)
    expect((await stat(plan.workspaceDir)).isDirectory()).toBe(true)
  })

  test("plans and removes expired shared session workspace caches", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-session-cache-"))
    await mkdir(path.join(runtimeRoot, "sessions/session_old/workspace"), { recursive: true })
    await mkdir(path.join(runtimeRoot, "sessions/session_fresh/workspace"), { recursive: true })
    await writeFile(path.join(runtimeRoot, "sessions/session_old/workspace/cache.txt"), "old")
    await writeFile(path.join(runtimeRoot, "sessions/session_fresh/workspace/cache.txt"), "fresh")

    const plan = CloudSessionWorkspace.cacheCleanupPlan({
      runtimeRoot,
      now: 10_000,
      ttlMS: 3_000,
      sessions: [
        { sessionID: "session_old", lastUsedAt: 6_000 },
        { sessionID: "session_fresh", lastUsedAt: 8_000 },
      ],
    })

    expect(plan).toEqual({
      expired: [
        {
          sessionID: "session_old",
          path: path.join(runtimeRoot, "sessions/session_old"),
          ageMS: 4_000,
        },
      ],
    })
    expect(await CloudSessionWorkspace.cleanupCache({ plan })).toEqual({
      removed: [path.join(runtimeRoot, "sessions/session_old")],
    })
    expect(await Bun.file(path.join(runtimeRoot, "sessions/session_old/workspace/cache.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(runtimeRoot, "sessions/session_fresh/workspace/cache.txt")).text()).toBe("fresh")
  })
})
