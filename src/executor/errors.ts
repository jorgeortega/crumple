import type { RetryPolicy } from './operation.js';

// What a failure means, decided in one pure table. Retrying a read is free and retrying a
// write can charge someone twice, so the answer depends on the failure and the operation.

export type ErrorCode =
  | 'invalid_arguments'
  | 'rejected'
  | 'upstream_auth'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'outcome_unknown'
  | 'circuit_open'
  | 'overloaded'
  | 'response_too_large'
  | 'redirected'
  | 'invalid_response'
  | 'cancelled';

/**
 * - `no`: trying again won't help.
 * - `later`: nothing was applied, so it's safe to try again.
 * - `same_key`: it may have been applied, and repeating with this key is safe.
 * - `check_first`: it may have been applied, and only looking can tell.
 */
export type RetryAdvice = 'no' | 'later' | 'same_key' | 'check_first';

export interface ExecutorError {
  code: ErrorCode;
  /** Written for the model to read. */
  message: string;
  retry: RetryAdvice;
  retryAfterMs?: number;
  idempotencyKey?: string;
  /** A 4xx's explanation: capped, redacted, and untrusted, like everything an API says. */
  detail?: string;
}

export type Failure =
  | { kind: 'lost' }
  | { kind: 'timed_out' }
  | { kind: 'status'; status: number }
  | { kind: 'not_json' }
  | { kind: 'too_large' };

export interface Verdict {
  /** Whether another attempt could help, if the attempts and the deadline allow one. */
  retryable: boolean;
  /** What to tell the agent if this turns out to be the last attempt. */
  code: ErrorCode;
  retry: RetryAdvice;
}

const stop = (code: ErrorCode, retry: RetryAdvice = 'no'): Verdict => ({ retryable: false, code, retry });

function mayHaveApplied(policy: RetryPolicy, safeCode: ErrorCode): Verdict {
  if (policy === 'safe') return { retryable: true, code: safeCode, retry: 'later' };
  if (policy === 'with_key') return { retryable: true, code: 'outcome_unknown', retry: 'same_key' };
  // A 503 only usually means nothing happened, and "usually" is the wrong standard for money.
  return stop('outcome_unknown', 'check_first');
}

// These say the request wasn't processed, so even a write with no key is safe to try later.
function askedToWait(policy: RetryPolicy): Verdict {
  return { retryable: policy !== 'never', code: 'rate_limited', retry: 'later' };
}

export function classify(failure: Failure, policy: RetryPolicy): Verdict {
  switch (failure.kind) {
    case 'lost':
      return mayHaveApplied(policy, 'unavailable');
    case 'timed_out':
      return mayHaveApplied(policy, 'timeout');
    case 'not_json':
      return stop('invalid_response');
    case 'too_large':
      return stop('response_too_large');
    case 'status': {
      const { status } = failure;
      if (status >= 500) return mayHaveApplied(policy, 'unavailable');
      if (status === 429 || status === 408 || status === 425) return askedToWait(policy);
      if (status === 401 || status === 403) return stop('upstream_auth');
      return status >= 400 ? stop('rejected') : stop('redirected');
    }
  }
}

const MESSAGES: Record<ErrorCode, string> = {
  invalid_arguments: 'The arguments can\'t be used for this tool.',
  rejected: 'The API refused this request. Fix the arguments, then call again.',
  upstream_auth: 'The API refused Crumple\'s credential. You can\'t fix this: tell the operator.',
  rate_limited: 'The API asked for fewer requests, so this wasn\'t applied.',
  unavailable: 'The API is having problems.',
  timeout: 'The API didn\'t answer in time.',
  outcome_unknown: 'This may or may not have been applied, because the answer was lost.',
  circuit_open: 'The API has been failing, so this wasn\'t sent.',
  overloaded: 'Too many calls are in progress, so this wasn\'t sent.',
  response_too_large: 'The API\'s answer was too large to return. Ask for less, such as with a smaller limit.',
  redirected: 'The API answered with a redirect, which Crumple doesn\'t follow.',
  invalid_response: 'The API answered with something other than the JSON it promised.',
  cancelled: 'The caller went away, so this call was stopped.',
};

export interface ErrorFacts {
  code: ErrorCode;
  retry: RetryAdvice;
  retryAfterMs?: number;
  idempotencyKey?: string;
  detail?: string;
  /** Replaces the usual message, when something more specific is known. */
  message?: string;
}

function nextStep({ retry, retryAfterMs, idempotencyKey }: ErrorFacts): string {
  if (retry === 'same_key') return ` To retry safely, call again with idempotencyKey ${idempotencyKey ?? ''}.`;
  if (retry === 'check_first') return ' Read the record to find out before trying again.';
  if (retry !== 'later') return '';
  if (retryAfterMs === undefined) return ' Try again later.';
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return ` Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
}

export function describeError(facts: ErrorFacts): ExecutorError {
  const { code, retry, retryAfterMs, idempotencyKey, detail, message } = facts;
  return {
    code,
    message: `${message ?? MESSAGES[code]}${nextStep(facts)}`,
    retry,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(detail === undefined ? {} : { detail }),
  };
}
