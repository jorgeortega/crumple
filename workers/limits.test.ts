import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createLimits, d1Counter, DAILY_CAP, RATE_PER_MINUTE, type D1Like, type DailyCounter, type Limits, type RateLimiter } from './limits.js';

// The real SQL and the real table, on node:sqlite, which is what D1 is built on. test:workers runs
// the same statement on D1 itself.
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('migrations/0001_daily_requests.sql', import.meta.url), 'utf8'));
  let writes = 0;
  const d1: D1Like = {
    prepare: (sql) => ({
      bind: (...values) => ({
        first: <T>() => {
          writes += 1;
          return Promise.resolve((db.prepare(sql).get(...(values as string[])) ?? null) as T | null);
        },
      }),
    }),
  };
  return {
    d1,
    writes: () => writes,
    stored: (day: string) => (db.prepare('SELECT count FROM daily_requests WHERE day = ?').get(day) as { count: number } | undefined)?.count,
  };
}

const open: RateLimiter = { limit: () => Promise.resolve({ success: true }) };
const request = (headers: Record<string, string> = {}) => new Request('https://demo.test/mcp', { method: 'POST', headers });
const NOON = Date.parse('2026-11-06T12:00:00Z');
const DAY = '2026-11-06';

describe('the daily cap', () => {
  it('serves exactly the cap, then says when it opens again', async () => {
    const limits = createLimits({ rate: open, counter: d1Counter(database().d1), cap: 3, now: () => NOON });
    for (let i = 0; i < 3; i += 1) expect(await limits.check(request())).toBeUndefined();
    const refused = await limits.check(request());
    expect(refused?.status).toBe(503);
    expect(refused?.headers.get('retry-after')).toBe(String(12 * 3600));
    expect(await refused?.text()).toContain('midnight UTC');
  });

  it('stops writing once closed, so a flood past the cap costs no more D1 writes', async () => {
    const db = database();
    const limits = createLimits({ rate: open, counter: d1Counter(db.d1), cap: 2, now: () => NOON });
    for (let i = 0; i < 50; i += 1) await limits.check(request());
    expect(db.writes()).toBe(3);
    expect(db.stored(DAY)).toBe(3);
  });

  it('opens again the next day, with the count back at one', async () => {
    const db = database();
    let now = NOON;
    const limits = createLimits({ rate: open, counter: d1Counter(db.d1), cap: 1, now: () => now });
    await limits.check(request());
    expect((await limits.check(request()))?.status).toBe(503);
    now = Date.parse('2026-11-06T23:59:59Z');
    expect((await limits.check(request()))?.headers.get('retry-after')).toBe('1');
    now = Date.parse('2026-11-07T00:00:00Z');
    expect(await limits.check(request())).toBeUndefined();
    expect(db.stored('2026-11-07')).toBe(1);
  });

  it('is exact across instances, which share only the counter', async () => {
    const counter = d1Counter(database().d1);
    const instances = [1, 2, 3].map(() => createLimits({ rate: open, counter, cap: 100, now: () => NOON }));
    const answers = await Promise.all(Array.from({ length: 400 }, (_, i) => (instances[i % 3] as Limits).check(request())));
    expect(answers.filter((answer) => answer === undefined)).toHaveLength(100);
  });

  it('turns everyone away when it can\'t be checked, and tries again next time', async () => {
    let broken = true;
    const counter: DailyCounter = { increment: () => (broken ? Promise.reject(new Error('D1 is down')) : Promise.resolve(1)) };
    const limits = createLimits({ rate: open, counter, now: () => NOON });
    const refused = await limits.check(request());
    expect(refused?.status).toBe(503);
    expect(await refused?.text()).not.toContain('D1 is down');
    broken = false;
    expect(await limits.check(request())).toBeUndefined();
  });

  it('treats a counter that returns no row as one it can\'t check', async () => {
    const empty: D1Like = { prepare: () => ({ bind: () => ({ first: () => Promise.resolve(null) }) }) };
    expect((await createLimits({ rate: open, counter: d1Counter(empty), now: () => NOON }).check(request()))?.status).toBe(503);
  });

  it('defaults to the real cap and the real clock', async () => {
    expect(await createLimits({ rate: open, counter: { increment: () => Promise.resolve(DAILY_CAP) } }).check(request())).toBeUndefined();
    expect((await createLimits({ rate: open, counter: { increment: () => Promise.resolve(DAILY_CAP + 1) } }).check(request()))?.status).toBe(503);
  });
});

describe('the rate limit', () => {
  it('refuses with a 429, and writes nothing to D1', async () => {
    const db = database();
    const limits = createLimits({ rate: { limit: () => Promise.resolve({ success: false }) }, counter: d1Counter(db.d1), now: () => NOON });
    const refused = await limits.check(request());
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('retry-after')).toBe('60');
    expect(db.writes()).toBe(0);
  });

  it('keys on the address Cloudflare reports, and works without one', async () => {
    const keys: string[] = [];
    const rate: RateLimiter = { limit: ({ key }) => { keys.push(key); return Promise.resolve({ success: true }); } };
    const limits = createLimits({ rate, counter: { increment: () => Promise.resolve(1) } });
    await limits.check(request({ 'cf-connecting-ip': '192.0.2.1' }));
    await limits.check(request());
    expect(keys).toEqual(['192.0.2.1', 'no-address']);
  });

  it('lets a request through to the daily cap if the binding fails, since the cap is what limits cost', async () => {
    const rate: RateLimiter = { limit: () => Promise.reject(new Error('binding down')) };
    const db = database();
    const limits = createLimits({ rate, counter: d1Counter(db.d1), cap: 1, now: () => NOON });
    expect(await limits.check(request())).toBeUndefined();
    expect((await limits.check(request()))?.status).toBe(503);
  });
});

describe('what would be deployed', () => {
  const toml = readFileSync(new URL('wrangler.toml', import.meta.url), 'utf8');

  it('has the limits the owner approved', () => {
    expect(RATE_PER_MINUTE).toBe(60);
    expect(DAILY_CAP).toBe(20_000);
    expect(toml).toContain(`simple = { limit = ${String(RATE_PER_MINUTE)}, period = 60 }`);
    expect(toml).toContain(`DAILY_CAP = "${String(DAILY_CAP)}"`);
  });

  it('keeps logs off, and no second address', () => {
    expect(toml).toMatch(/\[observability\]\nenabled = false/);
    expect(toml).toContain('workers_dev = false');
    expect(toml).toContain('preview_urls = false');
  });

  it('binds no secret and no key', () => {
    expect(toml).not.toMatch(/anthropic|api[_-]?key/i);
    expect(toml).not.toContain('[[services]]');
  });
});
