import { createHash, timingSafeEqual } from "node:crypto"

type APIKeyRecord = {
  id: string
  tenantID: string
  prefix: string
  hash: string
  status: "active" | "revoked"
  time: {
    created: number
    updated: number
  }
}

export function hash(key: string) {
  return createHash("sha256").update(key).digest("hex")
}

function matches(input: { left: string; right: string }) {
  const left = Buffer.from(input.left)
  const right = Buffer.from(input.right)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function issue(input: { id: string; tenantID: string; prefix: string; secret: string; now: number }) {
  const key = `${input.prefix}_${input.secret}`
  return {
    key,
    record: {
      id: input.id,
      tenantID: input.tenantID,
      prefix: input.prefix,
      hash: hash(key),
      status: "active" as const,
      time: {
        created: input.now,
        updated: input.now,
      },
    },
  }
}

export function authenticate(input: { authorization?: string; records: APIKeyRecord[] }) {
  if (!input.authorization) throw new Error("Cloud API key missing")
  if (!input.authorization.startsWith("Bearer ")) throw new Error("Cloud API key missing")
  const keyHash = hash(input.authorization.slice("Bearer ".length))
  const record = input.records.find((item) => matches({ left: item.hash, right: keyHash }))
  if (!record) throw new Error("Cloud API key invalid")
  if (record.status === "revoked") throw new Error("Cloud API key revoked")
  return {
    tenantID: record.tenantID,
    apiKeyID: record.id,
  }
}

export * as CloudAPIKey from "./api-key"
