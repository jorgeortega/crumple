import type { Span, Telemetry } from '../telemetry/index.js';
import { admit, CLOSED, DEFAULT_BREAKER, report, type BreakerConfig, type BreakerEvent, type BreakerState } from './breaker.js';
import { realSleep, startTimer, untilAborted, type Sleep } from './clock.js';
import { classify, describeError, type ExecutorError, type Failure, type Verdict } from './errors.js';
import type { Credential, Operation } from './operation.js';
import { buildPlan, CallRefused, credentialForms, parseBaseUrl, redact, toRequest, type RequestPlan } from './request.js';
import { backoffMs, parseRetryAfter, type BackoffLimits } from './retry.js';

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF: BackoffLimits = { baseMs: 200, capMs: 5_000 };
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_DETAIL_BYTES = 2048;
const TEXT_TYPE = /^text\/|json|xml|javascript|yaml|csv|x-www-form-urlencoded/i;

export interface ExecutorOptions {
  baseUrl: string;
  /** Hands over the upstream credential just before an attempt. Passed in, because executor can't import access-control. */
  getCredential: () => Promise<Credential>;
  /** Fixed headers on every upstream request. */
  headers?: Record<string, string>;
  telemetry: Telemetry;
  fetch?: (request: Request) => Promise<Response>;
  now?: () => number;
  sleep?: Sleep;
  random?: () => number;
  newKey?: () => string;
  deadlineMs?: number;
  attemptTimeoutMs?: number;
  retry?: { attempts?: number; baseMs?: number; capMs?: number };
  breaker?: Partial<BreakerConfig>;
  /** Send traceparent upstream, so the API's own traces can join in. */
  sendTraceparent?: boolean;
}

export interface CallContext {
  /** Who's calling: a key's id, never the key. */
  caller: string;
  parentSpan?: Span;
  /** Aborts when the caller goes away. */
  signal?: AbortSignal;
}

export type Outcome =
  | { ok: true; status: number; body: string; contentType: string; attempts: number }
  | { ok: false; error: ExecutorError; attempts: number };

export interface Executor {
  /** Never throws for an upstream problem. A failure is a normal return value. */
  call(operation: Operation, args: unknown, context: CallContext): Promise<Outcome>;
}

interface Answered {
  kind: 'answered';
  status: number;
  body: string;
  contentType: string;
}

interface Failed {
  kind: 'failed';
  failure: Failure;
  detail?: string;
  retryAfterMs?: number;
}

type AttemptResult = Answered | Failed | { kind: 'no_credential' } | { kind: 'cancelled' };

// Reads at most the cap, then stops the stream, racing the deadline at every step.
async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean; size: number }> {
  if (!response.body) return { text: '', truncated: false, size: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    for (;;) {
      const { done, value } = (await untilAborted(reader.read(), signal)) as { done: boolean; value: Uint8Array };
      if (done) return { text: text + decoder.decode(), truncated: false, size };
      const room = maxBytes - size;
      if (value.byteLength > room) {
        text += decoder.decode(value.subarray(0, room));
        return { text, truncated: true, size: maxBytes };
      }
      size += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Not awaited: a stream that ignores cancellation mustn't be able to hold the call open.
    reader.cancel().catch(() => undefined);
  }
}

export function createExecutor(options: ExecutorOptions): Executor {
  const {
    baseUrl,
    getCredential,
    headers: fixedHeaders = {},
    telemetry,
    fetch: send = (request: Request) => fetch(request),
    now = () => Date.now(),
    sleep = realSleep,
    random = () => Math.random(),
    newKey = () => crypto.randomUUID(),
    deadlineMs = DEFAULT_DEADLINE_MS,
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    sendTraceparent = true,
    retry: { attempts: maxAttempts = DEFAULT_ATTEMPTS, ...backoffOptions } = {},
  } = options;

  const backoff: BackoffLimits = { ...DEFAULT_BACKOFF, ...backoffOptions };
  const breakerConfig: BreakerConfig = { ...DEFAULT_BREAKER, ...options.breaker };
  // One breaker for the one upstream. It's per instance, so on Workers each isolate has its own.
  let breaker: BreakerState = CLOSED;

  const serverAddress = parseBaseUrl(baseUrl).hostname;

  async function readAnswer(response: Response, operation: Operation, forms: string[], signal: AbortSignal): Promise<Answered | Failed> {
    const { status } = response;
    const contentType = response.headers.get('content-type') ?? '';

    if (status < 200 || status >= 300) {
      const failure: Failure = { kind: 'status', status };
      if (classify(failure, operation.retry).code !== 'rejected') {
        response.body?.cancel().catch(() => undefined);
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
        return { kind: 'failed', failure, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
      }
      // Reads a little past the cap, so a credential straddling it is removed whole rather
      // than cut in half, where it wouldn't match.
      const margin = Math.max(0, ...forms.map((form) => form.length));
      const { text } = await readCapped(response, MAX_DETAIL_BYTES + margin, signal);
      const detail = redact(text, forms).trim().slice(0, MAX_DETAIL_BYTES);
      return { kind: 'failed', failure, ...(detail === '' ? {} : { detail }) };
    }

    if (operation.expectsJson === true && /text\/html/i.test(contentType)) {
      response.body?.cancel().catch(() => undefined);
      return { kind: 'failed', failure: { kind: 'not_json' } };
    }

    const { text, truncated, size } = await readCapped(response, MAX_RESPONSE_BYTES, signal);
    if (truncated) return { kind: 'failed', failure: { kind: 'too_large' } };
    if (contentType !== '' && !TEXT_TYPE.test(contentType)) {
      const type = contentType.split(';')[0] ?? contentType;
      return { kind: 'answered', status, contentType, body: `The API answered ${status} with ${size} bytes of ${type}, which isn't text.` };
    }
    return { kind: 'answered', status, contentType, body: redact(text, forms) };
  }

  interface AttemptInfo {
    resendCount: number;
    delayMs?: number;
  }

  async function attempt(operation: Operation, plan: RequestPlan, parent: Span, signal: AbortSignal, callerSignal: AbortSignal | undefined, info: AttemptInfo): Promise<AttemptResult> {
    let credential: Credential;
    try {
      credential = await untilAborted(getCredential(), signal);
    } catch {
      return callerSignal?.aborted ? { kind: 'cancelled' } : { kind: 'no_credential' };
    }

    const forms = credentialForms(credential);
    for (const form of forms) telemetry.addSecret(form);

    const span = parent.child(`${operation.method} ${operation.path}`, {
      kind: 'client',
      attributes: {
        'http.request.method': operation.method,
        'url.template': operation.path,
        'server.address': serverAddress,
        ...(info.resendCount === 0 ? {} : { 'http.request.resend_count': info.resendCount }),
        ...(info.delayMs === undefined ? {} : { 'crumple.retry.delay_ms': info.delayMs }),
      },
    });

    const timer = startTimer(sleep, attemptTimeoutMs);
    const attemptSignal = AbortSignal.any([signal, timer.signal]);
    try {
      const request = toRequest(plan, credential, sendTraceparent ? span.traceparent() : undefined, attemptSignal);
      const response = await untilAborted(send(request), attemptSignal);
      span.setAttributes({ 'http.response.status_code': response.status });

      const result = await readAnswer(response, operation, forms, attemptSignal);
      if (result.kind === 'answered') span.end();
      else span.end({ errorType: errorTypeOf(result) });
      return result;
    } catch (error) {
      if (error instanceof CallRefused) {
        span.end({ errorType: 'no_credential' });
        return { kind: 'no_credential' };
      }
      if (callerSignal?.aborted) {
        span.end({ errorType: 'cancelled' });
        return { kind: 'cancelled' };
      }
      // Nothing from the error itself goes anywhere: its message can contain the URL, and a
      // credential in the query string with it.
      const timedOut = attemptSignal.aborted;
      span.end({ errorType: timedOut ? 'timeout' : 'connection_lost' });
      return { kind: 'failed', failure: { kind: timedOut ? 'timed_out' : 'lost' } };
    } finally {
      timer.cancel();
    }
  }

  // Before any queue or network, so a bad argument costs nothing.
  const plan = (operation: Operation, args: unknown) =>
    buildPlan(operation, args, baseUrl, { headers: fixedHeaders, newKey });

  function finalError(verdict: Verdict, plan: RequestPlan, result: Failed): ExecutorError {
    return describeError({
      code: verdict.code,
      retry: verdict.retry,
      ...(verdict.retry === 'same_key' && plan.key !== undefined ? { idempotencyKey: plan.key } : {}),
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    });
  }

  const cancelled = (attempts: number): Outcome => ({ ok: false, attempts, error: describeError({ code: 'cancelled', retry: 'no' }) });

  async function run(operation: Operation, plan: RequestPlan, span: Span, signal: AbortSignal, context: CallContext, deadlineAt: number): Promise<Outcome> {
    let info: AttemptInfo = { resendCount: 0 };
    // What to say if the breaker stops a retry. "Nothing was sent" would be a lie by then,
    // because an earlier attempt may have applied this write.
    let previous: (() => Outcome) | undefined;

    for (let attempts = 1; ; attempts += 1) {
      const decision = admit(breaker, now());
      breaker = decision.state;
      span.setAttributes({ 'crumple.breaker.state': breaker.name });
      if (!decision.allowed) {
        return previous?.() ?? {
          ok: false,
          attempts: 0,
          error: describeError({ code: 'circuit_open', retry: 'later', retryAfterMs: decision.retryAfterMs }),
        };
      }

      const result = await attempt(operation, plan, span, signal, context.signal, info);
      breaker = report(breaker, breakerEvent(result), decision.probe, now(), breakerConfig);

      if (result.kind === 'answered') {
        return { ok: true, status: result.status, body: result.body, contentType: result.contentType, attempts };
      }
      if (result.kind === 'no_credential') {
        return { ok: false, attempts: attempts - 1, error: describeError({ code: 'upstream_auth', retry: 'no', message: 'Crumple has no usable credential for this API. You can\'t fix this: tell the operator.' }) };
      }
      if (result.kind === 'cancelled') return cancelled(attempts);

      const verdict = classify(result.failure, operation.retry);
      const giveUp = (): Outcome => ({ ok: false, attempts, error: finalError(verdict, plan, result) });
      if (!verdict.retryable || attempts >= maxAttempts || signal.aborted) return giveUp();

      // Retry-After wins over backoff. If the wait wouldn't fit in the deadline, it isn't
      // worth starting: the agent gets the answer now and can decide for itself.
      const delayMs = result.retryAfterMs ?? backoffMs(attempts - 1, random, backoff);
      if (now() + delayMs >= deadlineAt) return giveUp();

      try {
        await sleep(delayMs, signal);
      } catch {
        return context.signal?.aborted ? cancelled(attempts) : giveUp();
      }
      info = { resendCount: attempts, delayMs };
      previous = giveUp;
    }
  }

  return {
    async call(operation, args, context) {
      const span = context.parentSpan
        ? context.parentSpan.child('execute', { attributes: { 'crumple.deadline_ms': deadlineMs } })
        : telemetry.startSpan('execute', { attributes: { 'crumple.deadline_ms': deadlineMs } });
      const startedAt = now();
      const timer = startTimer(sleep, deadlineMs);
      const signal = context.signal ? AbortSignal.any([timer.signal, context.signal]) : timer.signal;

      let outcome: Outcome;
      try {
        outcome = await run(operation, plan(operation, args), span, signal, context, startedAt + deadlineMs);
      } catch (error) {
        const message = error instanceof CallRefused ? error.message : 'The arguments can\'t be turned into a request.';
        outcome = { ok: false, attempts: 0, error: describeError({ code: 'invalid_arguments', retry: 'no', message }) };
      } finally {
        timer.cancel();
      }

      if (outcome.ok) span.end();
      else span.end({ errorType: outcome.error.code });
      return outcome;
    },
  };
}

function breakerEvent(result: AttemptResult): BreakerEvent {
  if (result.kind === 'answered') return 'success';
  if (result.kind !== 'failed') return 'neutral';
  const { failure } = result;
  if (failure.kind === 'lost' || failure.kind === 'timed_out') return 'failure';
  if (failure.kind === 'status') return failure.status >= 500 ? 'failure' : 'success';
  return 'neutral';
}

function errorTypeOf(result: Failed): string {
  const { failure } = result;
  switch (failure.kind) {
    case 'status':
      return String(failure.status);
    case 'not_json':
      return 'invalid_response';
    case 'too_large':
      return 'response_too_large';
    case 'lost':
      return 'connection_lost';
    case 'timed_out':
      return 'timeout';
  }
}
