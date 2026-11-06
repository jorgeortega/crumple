// What keeps the public demo cheap and hard to abuse (C15). Two limits, in order: one per address, to
// keep things fair, and one for the whole day, which is what limits the cost.

/** The shipped limits, in wrangler.toml, and a test keeps these equal to it. */
export const RATE_PER_MINUTE = 60;
export const DAILY_CAP = 20_000;

const DAY_MS = 86_400_000;
const RETRY_RATE_S = '60';
const RETRY_COUNTER_S = '30';

/** Cloudflare's rate limiting binding: approximate, and counted per location. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The part of a D1 binding used here, so a test can use real SQL with node:sqlite. */
export interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } };
}

export interface DailyCounter {
  /** Adds one, and says how many today has now. One statement, so two instances can't both read the same number. */
  increment(day: string): Promise<number>;
}

export function d1Counter(db: D1Like): DailyCounter {
  const statement = 'INSERT INTO daily_requests (day, count) VALUES (?1, 1) ON CONFLICT (day) DO UPDATE SET count = count + 1 RETURNING count';
  return {
    async increment(day) {
      const row = await db.prepare(statement).bind(day).first<{ count: number }>();
      if (row === null) throw new Error('The counter returned no row.');
      return row.count;
    },
  };
}

const refusal = (status: number, error: string, retryAfter: string): Response =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': retryAfter } });

export interface LimitsOptions {
  rate: RateLimiter;
  counter: DailyCounter;
  cap?: number;
  now?: () => number;
}

export interface Limits {
  /** A response if this request is refused, and undefined if it may go ahead. */
  check(request: Request): Promise<Response | undefined>;
}

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

export function createLimits(options: LimitsOptions): Limits {
  const { rate, counter, cap = DAILY_CAP, now = () => Date.now() } = options;
  // Once closed, an instance stays closed until midnight, so a flood past the cap stops writing to D1.
  let closedDay: string | undefined;

  async function withinRate(request: Request): Promise<boolean> {
    // The address is only ever this key. It's never stored or logged.
    const key = request.headers.get('cf-connecting-ip') ?? 'no-address';
    try {
      return (await rate.limit({ key })).success;
    } catch {
      // This limit is about fairness. The daily cap is what limits the cost, and it still runs.
      return true;
    }
  }

  function closedToday(at: number): Response {
    const secondsLeft = Math.ceil((DAY_MS - (at % DAY_MS)) / 1000);
    return refusal(503, 'The demo has reached its limit for today, and opens again at midnight UTC.', String(secondsLeft));
  }

  return {
    async check(request) {
      const at = now();
      const today = dayOf(at);
      if (closedDay === today) return closedToday(at);

      if (!(await withinRate(request))) {
        return refusal(429, `Too many requests from this address. It allows about ${String(RATE_PER_MINUTE)} a minute, and a shared office can reach that sooner.`, RETRY_RATE_S);
      }

      let count: number;
      try {
        count = await counter.increment(today);
      } catch {
        // If the cap can't be checked, it can't be promised. Closed is the side that costs nothing.
        return refusal(503, 'The demo couldn\'t check its daily limit just now. Try again shortly.', RETRY_COUNTER_S);
      }
      if (count > cap) {
        closedDay = today;
        return closedToday(at);
      }
      return undefined;
    },
  };
}
