import type { ClaudeMessage, ModelRequest } from './model.js';
import { costOfCall, ratesFor } from './prices.js';

// What a run has used, and the cap on what it may spend.
//
// Spending is only known after a call, so checking what's been spent could overshoot by a whole call.
// Before each attempt this works out the worst case that attempt could cost, and says no if that
// would pass the cap. The input figure is deliberately too high: a character is usually less than a
// token, but replayed thinking counts as input even when its text comes back empty, and using tools
// adds a hidden system prompt.

const HIDDEN_PROMPT_MARGIN = 1_000;

export interface UsageTotals {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number | null;
  costIsAtMost: boolean;
  /** What counts against a budget: the worst case for anything that couldn't be known. */
  budgetUsedUsd: number;
}

export interface Meter {
  onRequest(request: ModelRequest): void;
  mayAttempt: () => boolean;
  onLost: () => void;
  onReply(message: ClaudeMessage): void;
  result(): UsageTotals;
}

export function createMeter(options: { model: string; maxUsd: number }): Meter {
  const { model, maxUsd } = options;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let spent = 0;
  let unknown = false;
  let atMost = false;
  let requestChars = 0;
  let maxTokens = 0;
  let lastPrompt = 0;

  const worstCase = (): number => {
    const input = requestChars + lastPrompt + HIDDEN_PROMPT_MARGIN;
    const rates = ratesFor(model, input);
    // No price means no way of knowing, and the loop refuses such a model before this matters.
    return rates ? (input * rates.input + maxTokens * rates.output) / 1_000_000 : Number.POSITIVE_INFINITY;
  };

  return {
    onRequest(request) {
      requestChars = JSON.stringify(request).length;
      maxTokens = request.max_tokens;
    },
    mayAttempt: () => spent + worstCase() <= maxUsd,
    onLost() {
      spent += worstCase();
      atMost = true;
    },
    onReply({ usage: reported }) {
      const cost = costOfCall(model, reported);
      if (cost === null) {
        unknown = true;
        spent += worstCase();
      } else {
        spent += cost;
      }
      usage.input += reported.input_tokens ?? 0;
      usage.output += reported.output_tokens ?? 0;
      usage.cacheRead += reported.cache_read_input_tokens ?? 0;
      usage.cacheWrite += reported.cache_creation_input_tokens ?? 0;
      lastPrompt = (reported.input_tokens ?? 0) + (reported.cache_read_input_tokens ?? 0) + (reported.cache_creation_input_tokens ?? 0);
    },
    result: () => ({ usage: { ...usage }, costUsd: unknown ? null : spent, costIsAtMost: atMost, budgetUsedUsd: spent }),
  };
}
