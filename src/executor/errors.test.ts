import { describe, expect, it } from 'vitest';
import { classify, describeError, type Failure, type Verdict } from './errors.js';
import type { RetryPolicy } from './operation.js';

// The table from the spec, so it can't drift from what the code does.
const POLICIES: RetryPolicy[] = ['safe', 'with_key', 'never'];

const retryThen = (code: Verdict['code'], retry: Verdict['retry']): Verdict => ({ retryable: true, code, retry });
const stop = (code: Verdict['code'], retry: Verdict['retry']): Verdict => ({ retryable: false, code, retry });

const UNKNOWN_WITH_KEY = retryThen('outcome_unknown', 'same_key');
const UNKNOWN = stop('outcome_unknown', 'check_first');

const TABLE: [string, Failure, Verdict, Verdict, Verdict][] = [
  ['a lost connection', { kind: 'lost' }, retryThen('unavailable', 'later'), UNKNOWN_WITH_KEY, UNKNOWN],
  ['a timeout', { kind: 'timed_out' }, retryThen('timeout', 'later'), UNKNOWN_WITH_KEY, UNKNOWN],
  ['a 500', { kind: 'status', status: 500 }, retryThen('unavailable', 'later'), UNKNOWN_WITH_KEY, UNKNOWN],
  ['a 502', { kind: 'status', status: 502 }, retryThen('unavailable', 'later'), UNKNOWN_WITH_KEY, UNKNOWN],
  ['a 503', { kind: 'status', status: 503 }, retryThen('unavailable', 'later'), UNKNOWN_WITH_KEY, UNKNOWN],
  ['a 504', { kind: 'status', status: 504 }, retryThen('unavailable', 'later'), UNKNOWN_WITH_KEY, UNKNOWN],
  ['a 429', { kind: 'status', status: 429 }, retryThen('rate_limited', 'later'), retryThen('rate_limited', 'later'), stop('rate_limited', 'later')],
  ['a 408', { kind: 'status', status: 408 }, retryThen('rate_limited', 'later'), retryThen('rate_limited', 'later'), stop('rate_limited', 'later')],
  ['a 425', { kind: 'status', status: 425 }, retryThen('rate_limited', 'later'), retryThen('rate_limited', 'later'), stop('rate_limited', 'later')],
  ['a 401', { kind: 'status', status: 401 }, stop('upstream_auth', 'no'), stop('upstream_auth', 'no'), stop('upstream_auth', 'no')],
  ['a 403', { kind: 'status', status: 403 }, stop('upstream_auth', 'no'), stop('upstream_auth', 'no'), stop('upstream_auth', 'no')],
  ['a 400', { kind: 'status', status: 400 }, stop('rejected', 'no'), stop('rejected', 'no'), stop('rejected', 'no')],
  ['a 404', { kind: 'status', status: 404 }, stop('rejected', 'no'), stop('rejected', 'no'), stop('rejected', 'no')],
  ['a 422', { kind: 'status', status: 422 }, stop('rejected', 'no'), stop('rejected', 'no'), stop('rejected', 'no')],
  ['a 302', { kind: 'status', status: 302 }, stop('redirected', 'no'), stop('redirected', 'no'), stop('redirected', 'no')],
  ['HTML where JSON was promised', { kind: 'not_json' }, stop('invalid_response', 'no'), stop('invalid_response', 'no'), stop('invalid_response', 'no')],
  ['a body over the cap', { kind: 'too_large' }, stop('response_too_large', 'no'), stop('response_too_large', 'no'), stop('response_too_large', 'no')],
];

describe('classify', () => {
  describe.each(POLICIES.map((policy, index) => [policy, index] as const))('with policy %s', (policy, index) => {
    it.each(TABLE.map((row) => [row[0], row[1], row[2 + index]] as const))('%s', (_name, failure, verdict) => {
      expect(classify(failure, policy)).toEqual(verdict);
    });
  });

  // The whole project in one test: nothing retries a write it can't make safe.
  it('never retries a write with no key, whatever went wrong', () => {
    for (const [, failure] of TABLE) expect(classify(failure, 'never').retryable).toBe(false);
  });

  it('never tells an agent to just try again after a write that may have happened', () => {
    for (const [, failure] of TABLE) {
      const { code, retry } = classify(failure, 'never');
      if (code === 'outcome_unknown') expect(retry).toBe('check_first');
    }
  });
});

describe('describeError', () => {
  it.each([
    'invalid_arguments', 'rejected', 'upstream_auth', 'rate_limited', 'unavailable', 'timeout', 'outcome_unknown',
    'circuit_open', 'overloaded', 'response_too_large', 'redirected', 'invalid_response', 'cancelled',
  ] as const)('%s has a message for the model', (code) => {
    const { message } = describeError({ code, retry: 'no' });
    expect(message.length).toBeGreaterThan(10);
  });

  it('says how long to wait when it knows', () => {
    const error = describeError({ code: 'rate_limited', retry: 'later', retryAfterMs: 30_000 });
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.message).toContain('30 seconds');
  });

  it('rounds a short wait up, rather than saying 0 seconds', () => {
    expect(describeError({ code: 'circuit_open', retry: 'later', retryAfterMs: 100 }).message).toContain('1 second.');
  });

  it('hands over the key and says how to use it', () => {
    const error = describeError({ code: 'outcome_unknown', retry: 'same_key', idempotencyKey: 'a1b2' });
    expect(error.idempotencyKey).toBe('a1b2');
    expect(error.message).toContain('idempotencyKey a1b2');
  });

  it('tells the agent to check first when it can\'t retry safely', () => {
    expect(describeError({ code: 'outcome_unknown', retry: 'check_first' }).message).toContain('before trying again');
  });

  it('passes on the explanation from a 4xx', () => {
    const error = describeError({ code: 'rejected', retry: 'no', detail: 'amount must be positive' });
    expect(error.detail).toBe('amount must be positive');
  });

  it('leaves out what it doesn\'t have', () => {
    expect(Object.keys(describeError({ code: 'cancelled', retry: 'no' })).sort()).toEqual(['code', 'message', 'retry']);
  });

  it('can use a more specific message', () => {
    expect(describeError({ code: 'invalid_arguments', retry: 'no', message: 'arguments.id: is required.' }).message).toBe('arguments.id: is required.');
  });
});
