import type { JobEvent } from "./api"
import type { JobStatus } from "./runtime"

type SequenceInput = {
  jobID: string
  sequence: number
  time: number
}

type MessageRole = "user" | "assistant" | "tool" | "system"

function eventID(input: { jobID: string; sequence: number }) {
  return `${input.jobID}:${input.sequence.toString().padStart(12, "0")}`
}

function build(input: SequenceInput & { type: JobEvent["type"]; data: Record<string, unknown> }): JobEvent {
  return {
    id: eventID(input),
    jobID: input.jobID,
    type: input.type,
    data: input.data,
    time: input.time,
  }
}

export function status(input: SequenceInput & { status: JobStatus }) {
  return build({
    ...input,
    type: "job.status",
    data: { status: input.status },
  })
}

export function message(input: SequenceInput & { role: MessageRole; content: string }) {
  return build({
    ...input,
    type: "job.message",
    data: {
      role: input.role,
      content: input.content,
    },
  })
}

export function toolCall(input: SequenceInput & { toolCallID: string; tool: string; status: string }) {
  return build({
    ...input,
    type: "job.tool_call",
    data: {
      toolCallID: input.toolCallID,
      tool: input.tool,
      status: input.status,
    },
  })
}

export function artifact(input: SequenceInput & { artifactID: string; name: string; kind: string }) {
  return build({
    ...input,
    type: "job.artifact",
    data: {
      artifactID: input.artifactID,
      name: input.name,
      kind: input.kind,
    },
  })
}

export function error(input: SequenceInput & { message: string }) {
  return build({
    ...input,
    type: "job.error",
    data: { message: input.message },
  })
}

export function heartbeat(input: SequenceInput) {
  return build({
    ...input,
    type: "job.heartbeat",
    data: {},
  })
}

export function stream(input: { events: JobEvent[]; jobID?: string; cursor?: string; limit?: number }) {
  const events = input.events
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .filter((event) => {
      if (input.jobID && event.jobID !== input.jobID) throw new Error("Cloud event job mismatch")
      return !input.cursor || event.id > input.cursor
    })

  return events.slice(0, input.limit)
}

export function checkpoint(input: { tenantID: string; consumer: string; jobID: string; cursor: string; time: number }) {
  return {
    tenantID: input.tenantID,
    consumer: input.consumer,
    jobID: input.jobID,
    cursor: input.cursor,
    time: {
      created: input.time,
      updated: input.time,
    },
  }
}

export function advanceCheckpoint(input: { checkpoint: ReturnType<typeof checkpoint>; cursor: string; time: number }) {
  if (input.cursor < input.checkpoint.cursor) throw new Error("Cloud event checkpoint cannot move backwards")
  return {
    ...input.checkpoint,
    cursor: input.cursor,
    time: {
      ...input.checkpoint.time,
      updated: input.time,
    },
  }
}

export * as CloudEvent from "./event"
