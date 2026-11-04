import { describe, expect, it } from 'vitest';
import { MAX_LARGE_BYTES, MAX_WAIT_MS, parseFault } from './faults.js';

describe('parseFault', () => {
  it.each([
    [null, {}],
    ['', {}],
    ['   ', {}],
    ['status=503', { status: 503 }],
    ['status=503;retry-after=2', { status: 503, retryAfterSeconds: 2 }],
    ['status=503;times=2', { status: 503, times: 2 }],
    [' status=503 ; times=2 ', { status: 503, times: 2 }],
    ['delay=200', { delayMs: 200 }],
    ['delay=200;status=500', { delayMs: 200, status: 500 }],
    ['hang', { hang: true }],
    ['stall-body', { stallBody: true }],
    ['drop', { drop: true }],
    ['drop;times=1', { drop: true, times: 1 }],
    ['inject', { inject: true }],
    ['echo-auth', { echoAuth: true }],
    ['inject;echo-auth', { inject: true, echoAuth: true }],
    ['status=500;echo-auth', { status: 500, echoAuth: true }],
    ['large=1024', { largeBytes: 1024 }],
    ['not-json', { notJson: true }],
    ['status=502;not-json', { status: 502, notJson: true }],
  ])('reads %j', (header, fault) => {
    expect(parseFault(header)).toEqual({ ok: true, fault });
  });

  it.each([
    ['delay', `delay=${MAX_WAIT_MS * 10}`, { delayMs: MAX_WAIT_MS }],
    ['large', `large=${MAX_LARGE_BYTES * 10}`, { largeBytes: MAX_LARGE_BYTES }],
  ])('caps %s, so a public demo can\'t be used to tie up resources', (_name, header, fault) => {
    expect(parseFault(header)).toEqual({ ok: true, fault });
  });

  // A typo in a test must never look like a pass, so anything unclear is refused.
  it.each([
    ['an unknown directive', 'explode', 'unknown'],
    ['a typo', 'stauts=503', 'unknown'],
    ['a repeated directive', 'status=503;status=500', 'more than once'],
    ['a status that is not a failure', 'status=200', 'status'],
    ['a status out of range', 'status=600', 'status'],
    ['a status that is not a number', 'status=soon', 'status'],
    ['a negative delay', 'delay=-1', 'delay'],
    ['a fractional delay', 'delay=1.5', 'delay'],
    ['times of zero', 'status=503;times=0', 'times'],
    ['a missing value', 'status', 'status'],
    ['an empty value', 'status=', 'status'],
    ['a value on a flag', 'hang=true', 'hang'],
    ['retry-after with no status', 'retry-after=2', 'retry-after'],
    ['times with nothing to count', 'times=2', 'times'],
    ['delay with hang', 'delay=10;hang', 'delay'],
    ['two shapes at once', 'hang;drop', 'one'],
    ['status with a shape that has no status', 'status=503;hang', 'status'],
    ['status with drop', 'status=503;drop', 'status'],
    ['status with large', 'status=503;large=10', 'status'],
    ['inject with a shape', 'inject;drop', 'inject'],
    ['echo-auth with a shape', 'echo-auth;not-json', 'echo-auth'],
    ['a very long header', `delay=1;${'x'.repeat(300)}`, 'long'],
  ])('refuses %s', (_name, header, mentions) => {
    const parsed = parseFault(header);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toContain(mentions);
  });
});
