import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RATE_PER_MINUTE } from '../../workers/limits.js';
import { READ_KEY } from '../../workers/surface.js';
import { rpc, type Fetcher } from '../helpers/mcp.js';
import { startWorker, type RunningWorker } from './harness.js';

// The limits with Cloudflare's real D1 and rate limiting binding, as wrangler dev runs them locally.

const fetcher: Fetcher = (request) => fetch(request);

describe('past the daily cap', () => {
  let worker: RunningWorker;
  beforeAll(async () => { worker = await startWorker({ port: 8814, migrate: true, vars: { DAILY_CAP: '3' } }); });
  afterAll(async () => { await worker.stop(); });

  it('closes /mcp and the buttons, leaves the page up, and stops writing', async () => {
    const list = () => rpc(fetcher, 'tools/list', {}, { token: READ_KEY, url: `${worker.url}/mcp` });
    for (let i = 0; i < 3; i += 1) expect((await list()).status).toBe(200);
    expect((await list()).status).toBe(503);
    expect((await fetch(`${worker.url}/try/no-permission`, { method: 'POST' })).status).toBe(503);
    expect((await fetch(worker.url)).status).toBe(200);

    const today = new Date().toISOString().slice(0, 10);
    expect(await worker.d1(`SELECT count FROM daily_requests WHERE day = '${today}'`)).toEqual([{ count: 4 }]);
    for (let i = 0; i < 5; i += 1) await list();
    expect(await worker.d1(`SELECT count FROM daily_requests WHERE day = '${today}'`)).toEqual([{ count: 4 }]);
  });
});

describe('past the rate limit', () => {
  let worker: RunningWorker;
  beforeAll(async () => { worker = await startWorker({ port: 8815, migrate: true }); });
  afterAll(async () => { await worker.stop(); });

  it('answers 429 once one address sends too many', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < RATE_PER_MINUTE + 15; i += 1) {
      statuses.push((await fetch(`${worker.url}/try/no-permission`, { method: 'POST' })).status);
    }
    // Exact here. On Cloudflare it's counted per location and approximately, so this isn't a promise there.
    expect(statuses.indexOf(429)).toBe(RATE_PER_MINUTE);
  });
});
