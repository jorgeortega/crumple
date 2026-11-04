// How long to wait before trying again. Both are pure, so the numbers can be tested exactly.

export interface BackoffLimits {
  baseMs: number;
  capMs: number;
}

/**
 * Exponential backoff with full jitter: a random wait up to a limit that doubles each time.
 * Without the randomness, every client that failed at the same moment retries at the same
 * moment, and hits a struggling API again together.
 *
 * @param retry how many retries came before this one, starting at 0
 */
export function backoffMs(retry: number, random: () => number, { baseMs, capMs }: BackoffLimits): number {
  return random() * Math.min(capMs, baseMs * 2 ** retry);
}

/**
 * RFC 9110 allows seconds or a date. Anything else is ignored, falling back on backoff,
 * because a broken header shouldn't change what happens. No upper limit here: the deadline
 * decides whether a wait fits, so a hostile value can't stall anything.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;

  // Date.parse accepts too much, so a date has to look like the RFC's: a day name first.
  if (!/^[A-Za-z]{3},/.test(text)) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
