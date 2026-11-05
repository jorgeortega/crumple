import type { ClaudeMessage, ModelCallOptions, ModelClient, ModelErrorCode, ModelReply, ModelRequest } from './model.js';

// Claude's Messages API, on plain fetch. The approved spec chose this over the SDK to keep the
// package's two runtime dependencies, which makes retries and errors our job.
//
// Only the status and the request id of a failure ever leave here. An error's body is the provider's
// text, and it has no business in a report.

export const API_VERSION = '2026-10-21';
const BASE_URL = 'https://api.anthropic.com';
const USER_AGENT = 'crumple-mcp-agent';
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;
const BACKOFF_BASE_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface ClaudeOptions {
  model: string;
  /** Comes from ANTHROPIC_API_KEY, read by whoever calls this. It's never a flag. */
  apiKey: string;
  /** For tests, in code. Never from the environment, where a stray .env could send the key elsewhere. */
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: Sleep;
  attempts?: number;
  attemptTimeoutMs?: number;
}

const defaultSleep: Sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

const stopped = (signal: AbortSignal): boolean => signal.aborted;

const retryable = (status: number): boolean => status === 408 || status === 409 || status === 429 || status >= 500;

function codeFor(status: number): ModelErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  return retryable(status) ? 'server_error' : 'bad_request';
}

function parseMessage(text: string): ClaudeMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const { content, stop_reason: stopReason, usage } = (value ?? {}) as { content?: unknown; stop_reason?: unknown; usage?: unknown };
  // Without these, reading on would mean guessing what the model said and what it cost.
  return Array.isArray(content) && (typeof stopReason === 'string' || stopReason === null) && typeof usage === 'object' && usage !== null ? value as ClaudeMessage : undefined;
}

export function claude(options: ClaudeOptions): ModelClient {
  const {
    model,
    apiKey,
    baseUrl = BASE_URL,
    fetch: doFetch = (input, init) => fetch(input, init),
    sleep = defaultSleep,
    attempts = DEFAULT_ATTEMPTS,
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  } = options;

  async function complete(request: ModelRequest, call: ModelCallOptions): Promise<ModelReply> {
    const body = JSON.stringify(request);
    let last: ModelReply = { ok: false, code: 'unreachable' };

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!call.mayAttempt()) return { ok: false, code: 'max_usd' };
      if (call.signal.aborted) return { ok: false, code: 'timeout' };

      const timeout = AbortSignal.timeout(attemptTimeoutMs);
      let waitMs = BACKOFF_BASE_MS * 2 ** attempt;
      try {
        const response = await doFetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          // A redirect must never carry the key somewhere else.
          redirect: 'error',
          signal: AbortSignal.any([call.signal, timeout]),
          headers: {
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
            'x-api-key': apiKey,
            'anthropic-version': API_VERSION,
          },
          body,
        });
        const text = await response.text();
        const requestId = response.headers.get('request-id') ?? undefined;

        if (response.ok) {
          const message = parseMessage(text);
          if (message) return { ok: true, message };
          // It answered, so it may have billed, and there's nothing here to say how much.
          call.onLost();
          return { ok: false, code: 'invalid_response', status: response.status, ...(requestId ? { requestId } : {}) };
        }

        last = { ok: false, code: codeFor(response.status), status: response.status, ...(requestId ? { requestId } : {}) };
        if (!retryable(response.status)) return last;

        const retryAfter = response.headers.get('retry-after');
        const askedMs = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
        // Waiting that long wouldn't help a run with a deadline, and the caller can say so.
        if (askedMs !== undefined && askedMs > MAX_RETRY_AFTER_MS) return last;
        if (askedMs !== undefined) waitMs = askedMs;
      } catch {
        // Sent, with no answer: it may have been billed, and only the worst case is safe to assume.
        call.onLost();
        last = { ok: false, code: stopped(timeout) || stopped(call.signal) ? 'timeout' : 'unreachable' };
      }

      if (attempt < attempts - 1) await sleep(waitMs, call.signal);
    }
    return last;
  }

  return { name: model, complete };
}
