type Window = {
  count: number
  resetAt: number
}

type State = {
  windows: Map<string, Window>
}

function key(input: { tenantID: string; action: string }) {
  return `${input.tenantID}:${input.action}`
}

export function create(input?: Partial<State>) {
  return {
    windows: input?.windows ?? new Map<string, Window>(),
  }
}

export function check(input: {
  state: State
  tenantID: string
  action: string
  limit: number
  windowMS: number
  now: number
}) {
  const id = key(input)
  const current = input.state.windows.get(id)
  const window =
    !current || current.resetAt <= input.now
      ? {
          count: 0,
          resetAt: input.now + input.windowMS,
        }
      : current
  const next = {
    ...window,
    count: window.count + 1,
  }
  input.state.windows.set(id, next)
  return {
    allowed: next.count <= input.limit,
    remaining: Math.max(input.limit - next.count, 0),
    resetAt: next.resetAt,
  }
}

export function assertAllowed(input: Parameters<typeof check>[0]) {
  const result = check(input)
  if (!result.allowed) throw new Error("Cloud rate limit exceeded")
  return result
}

export * as CloudRateLimit from "./rate-limit"
