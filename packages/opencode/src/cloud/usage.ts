export type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type Cost = {
  estimatedUSD: number
  tokens: TokenUsage
}

type PricePerMillion = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

function roundCost(input: number) {
  return Math.round(input * 1_000_000) / 1_000_000
}

export function emptyTokens(): TokenUsage {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
}

export function emptyCost(): Cost {
  return {
    estimatedUSD: 0,
    tokens: emptyTokens(),
  }
}

export function fixedCost(estimatedUSD: number): Cost {
  return {
    estimatedUSD: roundCost(estimatedUSD),
    tokens: emptyTokens(),
  }
}

export function modelCost(input: { tokens: TokenUsage; pricePerMillion: PricePerMillion }): Cost {
  return {
    estimatedUSD: roundCost(
      (input.tokens.input * (input.pricePerMillion.input ?? 0) +
        input.tokens.output * (input.pricePerMillion.output ?? 0) +
        input.tokens.reasoning * (input.pricePerMillion.output ?? 0) +
        input.tokens.cacheRead * (input.pricePerMillion.cacheRead ?? 0) +
        input.tokens.cacheWrite * (input.pricePerMillion.cacheWrite ?? 0)) /
        1_000_000,
    ),
    tokens: input.tokens,
  }
}

export function runtimeCost(input: { durationMS: number; pricePerHour: number }): Cost {
  return fixedCost((input.durationMS / 3_600_000) * input.pricePerHour)
}

export function totalCost(input: Cost[]): Cost {
  return {
    estimatedUSD: roundCost(input.reduce((total, item) => total + item.estimatedUSD, 0)),
    tokens: input.reduce(
      (tokens, item) => ({
        input: tokens.input + item.tokens.input,
        output: tokens.output + item.tokens.output,
        reasoning: tokens.reasoning + item.tokens.reasoning,
        cacheRead: tokens.cacheRead + item.tokens.cacheRead,
        cacheWrite: tokens.cacheWrite + item.tokens.cacheWrite,
      }),
      emptyTokens(),
    ),
  }
}

export * as CloudUsage from "./usage"
