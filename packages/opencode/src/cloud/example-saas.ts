type Step = {
  name: string
  method: string
  path: string
  body?: Record<string, unknown>
  from?: string
}

export function analysisFlow(input: {
  workspaceName: string
  userID: string
  fileName: string
  fileBase64: string
  prompt: string
  outputs?: Array<"csv" | "xlsx" | "png" | "html" | "md" | "pdf" | "json">
}) {
  return [
    {
      name: "create_workspace",
      method: "POST",
      path: "/v1/workspaces",
      body: { name: input.workspaceName },
    },
    {
      name: "create_session",
      method: "POST",
      path: "/v1/sessions",
      from: "create_workspace.id -> body.workspaceID",
      body: { workspaceID: "$create_workspace.id", userID: input.userID, title: "Cloud Runtime Analysis" },
    },
    {
      name: "upload_file",
      method: "POST",
      path: "/v1/files",
      from: "create_workspace.id + create_session.id -> body",
      body: {
        workspaceID: "$create_workspace.id",
        sessionID: "$create_session.id",
        name: input.fileName,
        contentBase64: input.fileBase64,
      },
    },
    {
      name: "create_webhook",
      method: "POST",
      path: "/v1/webhooks",
      body: {
        url: "https://saas.example.com/hooks/runtime",
        events: ["job.status", "job.artifact"],
        secret: "$webhook_secret",
      },
    },
    {
      name: "create_job",
      method: "POST",
      path: "/v1/jobs",
      from: "create_session.id + upload_file.id -> body",
      body: {
        sessionID: "$create_session.id",
        prompt: input.prompt,
        inputs: ["$upload_file.id"],
        outputs: input.outputs ?? ["md", "json"],
        runtime: { profile: "standard" },
        tools: {
          webfetch: { enabled: false, allowDomains: [] },
          websearch: { enabled: false },
          mcp: [],
          skills: [],
        },
      },
    },
    {
      name: "get_job",
      method: "GET",
      path: "/v1/jobs/$create_job.id",
      from: "create_job.id -> path",
    },
    {
      name: "poll_events",
      method: "GET",
      path: "/v1/jobs/$create_job.id/events",
      from: "create_job.id -> path",
    },
    {
      name: "list_artifacts",
      method: "GET",
      path: "/v1/artifacts?jobID=$create_job.id",
      from: "create_job.id -> query.jobID",
    },
    {
      name: "download_artifact",
      method: "GET",
      path: "/v1/artifacts/$list_artifacts[0].id/download",
      from: "list_artifacts[0].id -> path",
    },
    {
      name: "cancel_job",
      method: "POST",
      path: "/v1/jobs/$create_job.id/cancel",
      from: "create_job.id -> path",
    },
  ] satisfies Step[]
}

export function sdkSnippet(input: { baseURL: string; apiKeyEnv?: string }) {
  const apiKey = input.apiKeyEnv ?? "CLOUD_RUNTIME_API_KEY"
  return [
    `const client = CloudSDK.create({ baseURL: "${input.baseURL}", apiKey: process.env.${apiKey}! })`,
    `const workspace = await client.createWorkspace({ name: "Acme" })`,
    `const session = await client.createSession({ workspaceID: workspace.id, userID: "user_123", title: "Analysis" })`,
    `const file = await client.createFile({ workspaceID: workspace.id, sessionID: session.id, name: "input.csv", contentBase64 })`,
    `await client.createWebhook({ url: "https://saas.example.com/hooks/runtime", events: ["job.status", "job.artifact"], secret: webhookSecret })`,
    `const job = await client.createJob({ sessionID: session.id, prompt: "Analyze this file", inputs: [file.id], outputs: ["md", "json"], runtime: { profile: "standard" }, tools: { webfetch: { enabled: false, allowDomains: [] }, websearch: { enabled: false }, mcp: [], skills: [] } })`,
    `const status = await client.getJob({ jobID: job.id })`,
    `const events = await client.listJobEvents({ jobID: job.id })`,
    `const artifacts = await client.listArtifacts({ jobID: job.id })`,
    `const download = await client.downloadArtifact({ artifactID: artifacts[0].id })`,
    `await client.cancelJob({ jobID: job.id })`,
  ].join("\n")
}

export * as CloudExampleSaaS from "./example-saas"
