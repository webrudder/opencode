import { describe, expect, test } from "bun:test"
import { CloudOperationRunner } from "../../src/cloud/operation-runner"

describe("CloudOperationRunner", () => {
  test("builds provider tasks with stable idempotency keys", () => {
    const plan = CloudOperationRunner.plan({
      database: [{ action: "write", table: "cloud_job", key: { id: "job_abc" }, values: {}, conflict: "error" }],
      queue: [{ action: "lease", queue: "cloud-runtime:standard:tenant_abc", jobID: "job_abc" }],
      objectStorage: [{ action: "get", bucket: "runtime", objectKey: "tenant_abc/file.csv" }],
      kubernetes: [{ action: "watch", resource: "pod", name: "opencode-job-abc" }],
      secret: [{ action: "resolve", secretRef: "tenant_abc/user/key" }],
    })

    expect(plan.map((item) => [item.provider, item.id.split(":").slice(0, 3).join(":")])).toEqual([
      ["database", "database:write:cloud_job"],
      ["queue", "queue:lease:job_abc"],
      ["object_storage", "object_storage:get:tenant_abc/file.csv"],
      ["kubernetes", "kubernetes:watch:opencode-job-abc"],
      ["secret", "secret:resolve:tenant_abc/user/key"],
    ])
    expect(plan[0].id).toBe(
      CloudOperationRunner.task({
        provider: "database",
        operation: { action: "write", table: "cloud_job", key: { id: "job_abc" }, values: {}, conflict: "error" },
      }).id,
    )
  })

  test("summarizes operation results and separates retryable failures", () => {
    const results = [
      CloudOperationRunner.result({
        provider: "database",
        operation: { action: "write", table: "cloud_job" },
        status: "succeeded",
        durationMS: 10,
      }),
      CloudOperationRunner.result({
        provider: "kubernetes",
        operation: { action: "create", name: "opencode-job-abc" },
        status: "failed",
        durationMS: 20,
        error: "rate limited",
      }),
      CloudOperationRunner.result({
        provider: "object_storage",
        operation: { action: "put", objectKey: "tenant_abc/report.md" },
        status: "failed",
        retryable: false,
        durationMS: 5,
        error: "checksum mismatch",
      }),
      CloudOperationRunner.result({
        provider: "queue",
        operation: { action: "ack", jobID: "job_abc" },
        status: "skipped",
        durationMS: 1,
      }),
    ]

    expect(CloudOperationRunner.summarize({ results })).toEqual({
      total: 4,
      succeeded: 1,
      failed: 2,
      skipped: 1,
      retryable: 1,
      terminal: 1,
      durationMS: 36,
    })
    expect(CloudOperationRunner.retryPlan({ results })).toEqual([
      {
        id: results[1].id,
        provider: "kubernetes",
        action: "create",
        reason: "rate limited",
      },
    ])
  })
})
