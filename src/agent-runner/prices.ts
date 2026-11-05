import type { Usage } from './model.js';

// The one place prices are typed. A test fails when PRICES_READ is over 90 days old, so a stale price
// can't sit here unnoticed. Dollars per million tokens.

export const PRICES_READ = '2026-11-05';
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelPrice {
  rates: Rates;
  /** Higher rates for a request whose prompt is over this many tokens, the whole request included. */
  longPrompt?: { over: number; rates: Rates };
}

const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-5-5': {
    rates: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    longPrompt: { over: 100_000, rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  },
  'claude-sonnet-5-5': { rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
  'claude-opus-5-5': { rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
};

export const hasPrice = (model: string): boolean => Object.hasOwn(PRICES, model);

/** Which rates a request pays, from the length of its prompt. Undefined for a model with no price. */
export function ratesFor(model: string, promptTokens: number): Rates | undefined {
  if (!hasPrice(model)) return undefined;
  const { rates, longPrompt } = PRICES[model] as ModelPrice;
  return longPrompt && promptTokens > longPrompt.over ? longPrompt.rates : rates;
}

/**
 * The cost of one call, and it has to be one call: Haiku's rate depends on each request's prompt
 * length, cached tokens included, so working it out from a run's totals gives the wrong answer.
 * Null when it can't be known, because 0 would look like a real number.
 */
export function costOfCall(model: string, usage: Usage): number | null {
  const { input_tokens: input, output_tokens: output, cache_read_input_tokens: read = 0, cache_creation_input_tokens: written = 0 } = usage;
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  const rates = ratesFor(model, input + read + written);
  if (!rates) return null;
  return (input * rates.input + output * rates.output + read * rates.cacheRead + written * rates.cacheWrite) / 1_000_000;
}
