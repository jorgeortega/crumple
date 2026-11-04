import { describe, expect, it } from 'vitest';
import { backoffMs, parseRetryAfter } from './retry.js';

describe('backoffMs', () => {
  const limits = { baseMs: 200, capMs: 5_000 };

  it.each([
    [0, 200],
    [1, 400],
    [2, 800],
    [3, 1_600],
    [4, 3_200],
    [5, 5_000],
    [20, 5_000],
  ])('after retry %i, can wait up to %i ms', (retry, most) => {
    expect(backoffMs(retry, () => 1, limits)).toBe(most);
  });

  it('can wait as little as nothing', () => {
    expect(backoffMs(3, () => 0, limits)).toBe(0);
  });

  // Without the randomness, every client that failed together retries together.
  it('takes a random share of the limit', () => {
    expect(backoffMs(1, () => 0.25, limits)).toBe(100);
    expect(backoffMs(1, () => 0.75, limits)).toBe(300);
  });
});

describe('parseRetryAfter', () => {
  const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

  it('reads seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
    expect(parseRetryAfter('0', NOW)).toBe(0);
  });

  it('reads a date, as the time from now', () => {
    expect(parseRetryAfter('Wed, 04 Nov 2026 12:00:30 GMT', NOW)).toBe(30_000);
  });

  it('treats a date in the past as now', () => {
    expect(parseRetryAfter('Wed, 04 Nov 2026 11:00:00 GMT', NOW)).toBe(0);
  });

  it.each([
    ['nothing', null],
    ['an empty value', ''],
    ['a negative number', '-5'],
    ['a fraction', '1.5'],
    ['nonsense', 'soon'],
  ])('ignores %s, falling back on backoff', (_name, value) => {
    expect(parseRetryAfter(value, NOW)).toBeUndefined();
  });

  it('trims spaces', () => {
    expect(parseRetryAfter(' 5 ', NOW)).toBe(5_000);
  });
});
