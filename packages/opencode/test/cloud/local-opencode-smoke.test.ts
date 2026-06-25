import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import path from "path"
import { CloudLocalOpencodeSmoke } from "../../src/cloud/local-opencode-smoke"
import { CloudSQLiteSchema } from "../../src/cloud/sqlite-schema"

describe("CloudLocalOpencodeSmoke", () => {
  test("runs a SQLite API to local opencode worker artifact loop", async () => {
    const db = new Database(":memory:")
    CloudSQLiteSchema.apply({ db })
    const launches: Array<{ command: string; args: string[]; cwd: string; artifactManifest: string }> = []

    const result = await CloudLocalOpencodeSmoke.run({
      db,
      now: () => 100,
      id: (prefix) => `${prefix}_smoke`,
      sandboxRoot: "/tmp/cloud-opencode-smoke",
      localExecutor: async (input) => {
        launches.push({
          command: input.launch.command,
          args: input.launch.args,
          cwd: input.launch.cwd,
          artifactManifest: input.launch.artifactManifest,
        })
        return {
          status: "succeeded",
          manifest: {
            version: 1,
            jobID: input.jobID,
            artifacts: [
              {
                name: "local-opencode-smoke-report.md",
                path: "local-opencode-smoke-report.md",
                kind: "md",
                mime: "text/markdown",
              },
            ],
          },
          sizeByPath: {
            "local-opencode-smoke-report.md": 64,
          },
        }
      },
    })

    expect(result).toMatchObject({
      ok: true,
      workspaceID: "workspace_smoke",
      sessionID: "session_smoke",
      jobID: "job_smoke",
      jobStatus: "succeeded",
      sqlitePath: ":memory:",
      sandboxRoot: "/tmp/cloud-opencode-smoke",
      artifacts: 1,
    })
    expect(result.events).toBeGreaterThanOrEqual(3)
    expect(launches[0]).toMatchObject({
      command: "opencode",
      cwd: "/tmp/cloud-opencode-smoke/job_smoke/work",
      artifactManifest: "/tmp/cloud-opencode-smoke/job_smoke/work/.opencode-cloud/artifacts.json",
    })
    expect(launches[0].args.join(" ")).toContain("local-opencode-smoke-report.md")
    expect(launches[0].args.join(" ")).toContain('"jobID":"job_smoke"')
    expect(launches[0].args.join(" ")).toContain("Do not call bash")
  })

  test("renders compact local opencode smoke evidence", () => {
    expect(
      CloudLocalOpencodeSmoke.summary({
        ok: true,
        workspaceID: "workspace_smoke",
        sessionID: "session_smoke",
        jobID: "job_smoke",
        jobStatus: "succeeded",
        sqlitePath: ":memory:",
        sandboxRoot: "/tmp/cloud-opencode-smoke",
        artifacts: 1,
        events: 4,
        model: "anthropic/claude-sonnet-4-5",
        artifactNames: ["local-opencode-smoke-report.md"],
        lastEvents: ["job.status:running", "job.artifact:local-opencode-smoke-report.md", "job.status:succeeded"],
      }),
    ).toContain("local opencode smoke: passed")
    expect(
      CloudLocalOpencodeSmoke.summary({
        ok: true,
        workspaceID: "workspace_smoke",
        sessionID: "session_smoke",
        jobID: "job_smoke",
        jobStatus: "succeeded",
        sqlitePath: ":memory:",
        sandboxRoot: "/tmp/cloud-opencode-smoke",
        artifacts: 1,
        events: 4,
        model: "anthropic/claude-sonnet-4-5",
        artifactNames: ["local-opencode-smoke-report.md"],
        lastEvents: ["job.status:running", "job.artifact:local-opencode-smoke-report.md", "job.status:succeeded"],
      }),
    ).toContain("workspace=workspace_smoke session=session_smoke job=job_smoke status=succeeded artifacts=1 events=4")
    expect(
      CloudLocalOpencodeSmoke.summary({
        ok: true,
        workspaceID: "workspace_smoke",
        sessionID: "session_smoke",
        jobID: "job_smoke",
        jobStatus: "succeeded",
        sqlitePath: ":memory:",
        sandboxRoot: "/tmp/cloud-opencode-smoke",
        artifacts: 1,
        events: 4,
        model: "anthropic/claude-sonnet-4-5",
        artifactNames: ["local-opencode-smoke-report.md"],
        lastEvents: ["job.status:running", "job.artifact:local-opencode-smoke-report.md", "job.status:succeeded"],
      }),
    ).toContain("paths: sqlite=:memory: sandbox=/tmp/cloud-opencode-smoke")
    expect(
      CloudLocalOpencodeSmoke.summary({
        ok: true,
        workspaceID: "workspace_smoke",
        sessionID: "session_smoke",
        jobID: "job_smoke",
        jobStatus: "succeeded",
        sqlitePath: ":memory:",
        sandboxRoot: "/tmp/cloud-opencode-smoke",
        artifacts: 1,
        events: 4,
        model: "anthropic/claude-sonnet-4-5",
        artifactNames: ["local-opencode-smoke-report.md"],
        lastEvents: ["job.status:running", "job.artifact:local-opencode-smoke-report.md", "job.status:succeeded"],
      }),
    ).toContain("model: anthropic/claude-sonnet-4-5")
    expect(
      CloudLocalOpencodeSmoke.summary({
        ok: true,
        workspaceID: "workspace_smoke",
        sessionID: "session_smoke",
        jobID: "job_smoke",
        jobStatus: "succeeded",
        sqlitePath: ":memory:",
        sandboxRoot: "/tmp/cloud-opencode-smoke",
        artifacts: 1,
        events: 4,
        model: "anthropic/claude-sonnet-4-5",
        artifactNames: ["local-opencode-smoke-report.md"],
        lastEvents: ["job.status:running", "job.artifact:local-opencode-smoke-report.md", "job.status:succeeded"],
      }),
    ).toContain("artifacts: local-opencode-smoke-report.md")
    expect(
      CloudLocalOpencodeSmoke.summary({
        ok: true,
        workspaceID: "workspace_smoke",
        sessionID: "session_smoke",
        jobID: "job_smoke",
        jobStatus: "succeeded",
        sqlitePath: ":memory:",
        sandboxRoot: "/tmp/cloud-opencode-smoke",
        artifacts: 1,
        events: 4,
        model: "anthropic/claude-sonnet-4-5",
        artifactNames: ["local-opencode-smoke-report.md"],
        lastEvents: ["job.status:running", "job.artifact:local-opencode-smoke-report.md", "job.status:succeeded"],
      }),
    ).toContain("last events: job.status:running | job.artifact:local-opencode-smoke-report.md | job.status:succeeded")
  })

  test("returns diagnostic evidence when the real local opencode worker fails", async () => {
    const result = await CloudLocalOpencodeSmoke.run({
      db: new Database(":memory:"),
      now: () => 100,
      id: (prefix) => `${prefix}_smoke`,
      sandboxRoot: "/tmp/cloud-opencode-smoke",
      localExecutor: async () => ({
        status: "failed",
        code: 2,
        stdout: "partial stdout",
        stderr: "manifest missing",
        message: "opencode exited with code 2",
      }),
    })

    expect(result).toMatchObject({
      ok: false,
      jobStatus: "failed",
      model: "anthropic/claude-sonnet-4-5",
      artifactNames: [],
    })
    expect(result.error).toContain("opencode exited with code 2")
    expect(result.lastEvents).toContain("job.error:opencode exited with code 2")
    expect(CloudLocalOpencodeSmoke.summary(result)).toContain("last events:")
  })

  test("checks local opencode executable, model credentials, timeout, and writable paths before real execution", async () => {
    const result = await CloudLocalOpencodeSmoke.preflight({
      env: {
        ANTHROPIC_API_KEY: "sk-ant",
        CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "900000",
        CLOUD_RUNTIME_SQLITE_PATH: "/tmp/cloud-runtime-smoke.sqlite",
        CLOUD_RUNTIME_SANDBOX_ROOT: "/tmp/cloud-opencode-smoke",
      },
      commandExists: async (command) => command === "opencode",
      pathWritable: async (target) => target === "/tmp" || target === "/tmp/cloud-opencode-smoke",
    })

    expect(result).toEqual({
      ok: true,
      checks: [
        { name: "opencode-executable", status: "passed", detail: "opencode is available" },
        { name: "model-credentials", status: "passed", detail: "ANTHROPIC_API_KEY is configured" },
        { name: "execution-timeout", status: "passed", detail: "900000ms" },
        { name: "sqlite-path", status: "passed", detail: "/tmp/cloud-runtime-smoke.sqlite parent /tmp is writable" },
        { name: "sandbox-root", status: "passed", detail: "/tmp/cloud-opencode-smoke is writable" },
      ],
    })
  })

  test("uses local opencode smoke model overrides for plan and credential preflight", async () => {
    const plan = CloudLocalOpencodeSmoke.plan({
      env: {
        CLOUD_RUNTIME_MODEL_PROVIDER: "openai",
        CLOUD_RUNTIME_MODEL: "gpt-5",
      },
    })
    const result = await CloudLocalOpencodeSmoke.preflight({
      env: {
        CLOUD_RUNTIME_MODEL_PROVIDER: "openai",
        CLOUD_RUNTIME_MODEL: "gpt-5",
        OPENAI_API_KEY: "sk-openai",
        CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "600000",
        CLOUD_RUNTIME_SQLITE_PATH: ":memory:",
        CLOUD_RUNTIME_SANDBOX_ROOT: "/tmp/cloud-opencode-smoke",
      },
      commandExists: async (command) => command === "opencode",
      pathWritable: async (target) => target === "/tmp/cloud-opencode-smoke",
    })

    expect(plan).toMatchObject({
      model: "openai/gpt-5",
      requiredEnv: ["OPENAI_API_KEY", "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1"],
    })
    expect(result.checks.find((item) => item.name === "model-credentials")).toEqual({
      name: "model-credentials",
      status: "passed",
      detail: "OPENAI_API_KEY is configured",
    })
  })

  test("allows local opencode smoke credential environment name override", async () => {
    const plan = CloudLocalOpencodeSmoke.plan({
      env: {
        CLOUD_RUNTIME_MODEL_PROVIDER: "openai-compatible",
        CLOUD_RUNTIME_MODEL: "qwen-max",
        CLOUD_RUNTIME_MODEL_CREDENTIAL_ENV: "CUSTOMER_LLM_API_KEY",
      },
    })
    const result = await CloudLocalOpencodeSmoke.preflight({
      env: {
        CLOUD_RUNTIME_MODEL_PROVIDER: "openai-compatible",
        CLOUD_RUNTIME_MODEL: "qwen-max",
        CLOUD_RUNTIME_MODEL_CREDENTIAL_ENV: "CUSTOMER_LLM_API_KEY",
        CUSTOMER_LLM_API_KEY: "sk-customer",
        CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "600000",
        CLOUD_RUNTIME_SQLITE_PATH: ":memory:",
        CLOUD_RUNTIME_SANDBOX_ROOT: "/tmp/cloud-opencode-smoke",
      },
      commandExists: async (command) => command === "opencode",
      pathWritable: async (target) => target === "/tmp/cloud-opencode-smoke",
    })

    expect(plan).toMatchObject({
      model: "openai-compatible/qwen-max",
      requiredEnv: ["CUSTOMER_LLM_API_KEY", "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1"],
    })
    expect(result.checks.find((item) => item.name === "model-credentials")).toEqual({
      name: "model-credentials",
      status: "passed",
      detail: "CUSTOMER_LLM_API_KEY is configured",
    })
  })

  test("fails preflight before real opencode execution when prerequisites are missing", async () => {
    const result = await CloudLocalOpencodeSmoke.preflight({
      env: {
        CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "0",
        CLOUD_RUNTIME_SQLITE_PATH: "/locked/cloud-runtime-smoke.sqlite",
        CLOUD_RUNTIME_SANDBOX_ROOT: "/locked/cloud-opencode-smoke",
      },
      commandExists: async () => false,
      pathWritable: async () => false,
    })

    expect(result.ok).toBe(false)
    expect(result.checks).toEqual([
      { name: "opencode-executable", status: "failed", detail: "opencode executable not found in PATH" },
      { name: "model-credentials", status: "failed", detail: "ANTHROPIC_API_KEY is required for anthropic/claude-sonnet-4-5" },
      { name: "execution-timeout", status: "failed", detail: "CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS must be greater than 0" },
      { name: "sqlite-path", status: "failed", detail: "/locked/cloud-runtime-smoke.sqlite parent /locked is not writable" },
      { name: "sandbox-root", status: "failed", detail: "/locked/cloud-opencode-smoke is not writable" },
    ])
  })

  test("stops the CLI smoke before real execution when preflight fails", async () => {
    const result = await CloudLocalOpencodeSmoke.runCLI({
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE: "1",
      },
      preflight: async () => ({
        ok: false,
        checks: [{ name: "model-credentials", status: "failed", detail: "ANTHROPIC_API_KEY is required" }],
      }),
      runSmoke: async () => {
        throw new Error("should not run")
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("local opencode smoke preflight: failed")
    expect(result.output).toContain("[failed] model-credentials: ANTHROPIC_API_KEY is required")
    expect(result.output).toContain("Remediation:")
    expect(result.output).toContain("export the provider API key shown above")
  })

  test("runs CLI preflight mode without confirmation or real opencode execution", async () => {
    const result = await CloudLocalOpencodeSmoke.runCLI({
      mode: "preflight",
      preflight: async () => ({
        ok: true,
        checks: [{ name: "opencode-executable", status: "passed", detail: "opencode is available" }],
      }),
      runSmoke: async () => {
        throw new Error("should not run")
      },
    })

    expect(result).toEqual({
      exitCode: 0,
      output: [
        "local opencode smoke preflight: passed",
        "[passed] opencode-executable: opencode is available",
      ].join("\n"),
    })
  })

  test("CLI preflight mode honors injected environment overrides", async () => {
    const result = await CloudLocalOpencodeSmoke.runCLI({
      mode: "preflight",
      env: {
        CLOUD_RUNTIME_MODEL_PROVIDER: "openai",
        CLOUD_RUNTIME_MODEL: "gpt-5",
        OPENAI_API_KEY: "sk-openai",
        CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "600000",
        CLOUD_RUNTIME_SQLITE_PATH: ":memory:",
        CLOUD_RUNTIME_SANDBOX_ROOT: "/tmp/cloud-opencode-smoke",
      },
    })

    expect(result.output).toContain("[passed] model-credentials: OPENAI_API_KEY is configured")
    expect(result.output).toContain("[passed] execution-timeout: 600000ms")
  })

  test("renders local opencode preflight evidence without confirmation", async () => {
    const result = await CloudLocalOpencodeSmoke.runCLI({
      mode: "evidence",
      env: {
        CLOUD_RUNTIME_MODEL_PROVIDER: "openai",
        CLOUD_RUNTIME_MODEL: "gpt-5",
        OPENAI_API_KEY: "sk-openai",
        CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "600000",
        CLOUD_RUNTIME_SQLITE_PATH: ":memory:",
        CLOUD_RUNTIME_SANDBOX_ROOT: "/tmp/cloud-opencode-smoke",
      },
      preflight: async () => ({
        ok: true,
        checks: [{ name: "opencode-executable", status: "passed", detail: "opencode is available" }],
      }),
      runSmoke: async () => {
        throw new Error("should not run")
      },
    })
    const evidence = JSON.parse(result.output) as { status: string; confirmed: boolean; plan: { model: string }; preflight: { ok: boolean } }

    expect(result.exitCode).toBe(0)
    expect(evidence.status).toBe("local_opencode_preflight_evidence")
    expect(evidence.confirmed).toBe(false)
    expect(evidence.plan.model).toBe("openai/gpt-5")
    expect(evidence.preflight.ok).toBe(true)
  })

  test("renders local opencode smoke evidence after confirmation", async () => {
    const result = await CloudLocalOpencodeSmoke.runCLI({
      mode: "evidence",
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE: "1",
      },
      preflight: async () => ({
        ok: true,
        checks: [{ name: "opencode-executable", status: "passed", detail: "opencode is available" }],
      }),
      runSmoke: async () => ({
        ok: true,
        workspaceID: "workspace_smoke",
        sessionID: "session_smoke",
        jobID: "job_smoke",
        jobStatus: "succeeded",
        model: "anthropic/claude-sonnet-4-5",
        sqlitePath: ":memory:",
        sandboxRoot: "/tmp/cloud-opencode-smoke",
        artifacts: 1,
        artifactNames: ["local-opencode-smoke-report.md"],
        events: 4,
        lastEvents: ["job.status:running", "job.artifact:local-opencode-smoke-report.md", "job.status:succeeded"],
      }),
    })
    const evidence = JSON.parse(result.output) as { status: string; confirmed: boolean; smoke: { ok: boolean; jobID: string; artifacts: number } }

    expect(result.exitCode).toBe(0)
    expect(evidence.status).toBe("local_opencode_smoke_evidence")
    expect(evidence.confirmed).toBe(true)
    expect(evidence.smoke).toMatchObject({
      ok: true,
      jobID: "job_smoke",
      artifacts: 1,
    })
  })

  test("requires explicit confirmation before CLI smoke can invoke real opencode", async () => {
    const result = await CloudLocalOpencodeSmoke.runCLI({
      preflight: async () => {
        throw new Error("should not preflight")
      },
      runSmoke: async () => {
        throw new Error("should not run")
      },
    })

    expect(result).toEqual({
      exitCode: 1,
      output: [
        "local opencode smoke confirmation: failed",
        "[failed] real-opencode-confirmation: set CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1 to run real opencode smoke",
      ].join("\n"),
    })
  })

  test("runs preflight and smoke after explicit real opencode confirmation", async () => {
    const result = await CloudLocalOpencodeSmoke.runCLI({
      env: {
        CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE: "1",
      },
      preflight: async () => ({
        ok: true,
        checks: [{ name: "opencode-executable", status: "passed", detail: "opencode is available" }],
      }),
      runSmoke: async () => ({
        ok: true,
        workspaceID: "workspace_smoke",
        sessionID: "session_smoke",
        jobID: "job_smoke",
        jobStatus: "succeeded",
        model: "anthropic/claude-sonnet-4-5",
        sqlitePath: ":memory:",
        sandboxRoot: "/tmp/cloud-opencode-smoke",
        artifacts: 1,
        artifactNames: ["local-opencode-smoke-report.md"],
        events: 4,
        lastEvents: ["job.status:running", "job.artifact:local-opencode-smoke-report.md", "job.status:succeeded"],
      }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("local opencode smoke preflight: passed")
    expect(result.output).toContain("local opencode smoke: passed")
  })

  test("renders a local opencode smoke plan without running preflight or execution", () => {
    const result = CloudLocalOpencodeSmoke.plan({
      env: {
        CLOUD_RUNTIME_SQLITE_PATH: "/tmp/cloud-runtime.sqlite",
        CLOUD_RUNTIME_SANDBOX_ROOT: "/tmp/cloud-runtime-smoke",
        CLOUD_RUNTIME_EXECUTION_TIMEOUT_MS: "600000",
      },
    })

    expect(result).toEqual({
      sqlitePath: "/tmp/cloud-runtime.sqlite",
      sandboxRoot: "/tmp/cloud-runtime-smoke",
      tenantID: "tenant_local",
      model: "anthropic/claude-sonnet-4-5",
      executionMode: "opencode",
      executionTimeoutMS: 600000,
      requiredEnv: ["ANTHROPIC_API_KEY", "CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1"],
      outputs: ["md"],
      artifactManifest: ".opencode-cloud/artifacts.json",
      reportName: "local-opencode-smoke-report.md",
    })
  })

  test("creates local opencode smoke jobs with the environment model override", async () => {
    const db = new Database(":memory:")
    CloudSQLiteSchema.apply({ db })
    await CloudLocalOpencodeSmoke.run({
      db,
      now: () => 100,
      id: (prefix) => `${prefix}_smoke`,
      env: {
        CLOUD_RUNTIME_MODEL_PROVIDER: "openai",
        CLOUD_RUNTIME_MODEL: "gpt-5",
      },
      sandboxRoot: "/tmp/cloud-opencode-smoke",
      localExecutor: async (input) => ({
        status: "succeeded",
        manifest: {
          version: 1,
          jobID: input.jobID,
          artifacts: [
            {
              name: "local-opencode-smoke-report.md",
              path: "local-opencode-smoke-report.md",
              kind: "md",
              mime: "text/markdown",
            },
          ],
        },
        sizeByPath: {
          "local-opencode-smoke-report.md": 64,
        },
      }),
    })

    const row = db.query("select job_spec from cloud_job where id = ?").get("job_smoke") as { job_spec: string }
    expect(row.job_spec).toContain("\"provider\":\"openai\"")
    expect(row.job_spec).toContain("\"model\":\"gpt-5\"")
  })

  test("creates a local opencode smoke BYOK snapshot with base URL override", async () => {
    const db = new Database(":memory:")
    CloudSQLiteSchema.apply({ db })
    const launches: Array<{ env: Record<string, string> }> = []
    await CloudLocalOpencodeSmoke.run({
      db,
      now: () => 100,
      id: (prefix) => `${prefix}_smoke`,
      env: {
        CLOUD_RUNTIME_MODEL_PROVIDER: "anthropic",
        CLOUD_RUNTIME_MODEL: "glm-5.1",
        CLOUD_RUNTIME_MODEL_CREDENTIAL_ENV: "ANTHROPIC_API_KEY",
        CLOUD_RUNTIME_MODEL_BASE_URL: "https://dashscope.aliyuncs.com/apps/anthropic",
        ANTHROPIC_API_KEY: "sk-test",
      },
      sandboxRoot: "/tmp/cloud-opencode-smoke",
      localExecutor: async (input) => {
        launches.push({ env: input.launch.env })
        return {
          status: "succeeded",
          manifest: {
            version: 1,
            jobID: input.jobID,
            artifacts: [
              {
                name: "local-opencode-smoke-report.md",
                path: "local-opencode-smoke-report.md",
                kind: "md",
                mime: "text/markdown",
              },
            ],
          },
          sizeByPath: {
            "local-opencode-smoke-report.md": 64,
          },
        }
      },
    })

    const row = db.query("select job_spec, model_config_snapshot from cloud_job where id = ?").get("job_smoke") as {
      job_spec: string
      model_config_snapshot: string
    }
    expect(JSON.parse(row.model_config_snapshot)).toMatchObject({
      credentialID: "llmcred_smoke",
      provider: "anthropic",
      model: "glm-5.1",
      baseURL: "https://dashscope.aliyuncs.com/apps/anthropic",
    })
    expect(JSON.parse(row.job_spec).model).toMatchObject({
      provider: "anthropic",
      model: "glm-5.1",
      credentialID: "llmcred_smoke",
    })
    expect(JSON.parse(launches[0].env.OPENCODE_CONFIG_CONTENT).provider).toEqual({
      anthropic: {
        options: {
          baseURL: "https://dashscope.aliyuncs.com/apps/anthropic",
        },
        models: {
          "glm-5.1": {
            id: "glm-5.1",
            name: "glm-5.1",
            tool_call: true,
            temperature: true,
            limit: {
              context: 200_000,
              output: 8_192,
            },
          },
        },
      },
    })
    expect(launches[0].env.ANTHROPIC_API_KEY).toBe("sk-test")
  })

  test("renders a dry-run summary for the local opencode smoke plan", () => {
    const summary = CloudLocalOpencodeSmoke.planSummary(
      CloudLocalOpencodeSmoke.plan({
        env: {
          CLOUD_RUNTIME_SQLITE_PATH: "/tmp/cloud-runtime.sqlite",
          CLOUD_RUNTIME_SANDBOX_ROOT: "/tmp/cloud-runtime-smoke",
        },
      }),
    )

    expect(summary).toContain("local opencode smoke plan")
    expect(summary).toContain("SQLite:        /tmp/cloud-runtime.sqlite")
    expect(summary).toContain("Sandbox root:  /tmp/cloud-runtime-smoke")
    expect(summary).toContain("Model:         anthropic/claude-sonnet-4-5")
    expect(summary).toContain("Required env:  ANTHROPIC_API_KEY, CLOUD_RUNTIME_CONFIRM_REAL_OPENCODE=1")
    expect(summary).toContain("Artifact:      .opencode-cloud/artifacts.json")
  })

  test("renders model base URL in the dry-run summary when configured", () => {
    const summary = CloudLocalOpencodeSmoke.planSummary(
      CloudLocalOpencodeSmoke.plan({
        env: {
          CLOUD_RUNTIME_MODEL_BASE_URL: "https://dashscope.aliyuncs.com/apps/anthropic",
        },
      }),
    )

    expect(summary).toContain("Base URL:      https://dashscope.aliyuncs.com/apps/anthropic")
  })

  test("runs the CLI plan mode without preflight or smoke execution", async () => {
    const result = await CloudLocalOpencodeSmoke.runCLI({
      mode: "plan",
      env: {
        CLOUD_RUNTIME_SQLITE_PATH: "/tmp/cloud-runtime.sqlite",
      },
      preflight: async () => {
        throw new Error("should not preflight")
      },
      runSmoke: async () => {
        throw new Error("should not run")
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("local opencode smoke plan")
    expect(result.output).toContain("SQLite:        /tmp/cloud-runtime.sqlite")
  })

  test("exposes a package script for the local opencode smoke", async () => {
    expect((await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts["cloud:opencode:smoke"]).toBe(
      "bun run ./src/cloud/local-opencode-smoke.ts",
    )
    expect((await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts["cloud:opencode:plan"]).toBe(
      "bun run ./src/cloud/local-opencode-smoke.ts --plan",
    )
    expect((await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts["cloud:opencode:preflight"]).toBe(
      "bun run ./src/cloud/local-opencode-smoke.ts --preflight",
    )
    expect((await Bun.file(path.join(import.meta.dir, "../../package.json")).json()).scripts["cloud:opencode:evidence"]).toBe(
      "bun run ./src/cloud/local-opencode-smoke.ts --evidence",
    )
  })
})
