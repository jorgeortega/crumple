import { afterEach, describe, expect, it, vi } from 'vitest';
import { callTool, rpc, textOf, type Fetcher } from '../tests/helpers/mcp.js';
import { createDemo, type DemoOptions } from './demo.js';
import type { DailyCounter, RateLimiter } from './limits.js';
import { CHARGE_KEY, READ_KEY } from './surface.js';
import { SCENARIOS, type TryReport } from './try.js';

const URL_ROOT = 'https://crumple.test';
const MCP = `${URL_ROOT}/mcp`;

function setup(options: Partial<DemoOptions> = {}) {
  let increments = 0;
  const counter: DailyCounter = { increment: () => { increments += 1; return Promise.resolve(increments); } };
  const rate: RateLimiter = { limit: () => Promise.resolve({ success: true }) };
  const demo = createDemo({ rate, counter, ...options });
  const fetcher: Fetcher = (request) => demo.fetch(request);
  return { demo, fetcher, increments: () => increments };
}

const press = (name: string, init: RequestInit = { method: 'POST' }) => new Request(`${URL_ROOT}/try/${name}`, init);

afterEach(() => { vi.restoreAllMocks(); });

describe('/mcp', () => {
  it('serves real tools to the printed keys, and a charge key can charge', async () => {
    const { fetcher } = setup();
    const listed = await rpc(fetcher, 'tools/list', {}, { token: READ_KEY, url: MCP });
    expect(listed.body.result?.tools?.map((tool) => tool.name)).toContain('getCustomer');
    const paid = await callTool(fetcher, 'createPayment', { body: { customerId: 'cus_1', amountCents: 100 } }, { token: CHARGE_KEY, url: MCP });
    expect(paid.body.result?.isError).not.toBe(true);
  });

  it('asks for a key', async () => {
    const { fetcher } = setup();
    expect((await rpc(fetcher, 'tools/list', {}, { url: MCP })).status).toBe(401);
  });

  it('lets nobody delete, with either key', async () => {
    const { fetcher } = setup();
    for (const token of [READ_KEY, CHARGE_KEY]) {
      expect((await callTool(fetcher, 'deleteCustomer', { id: 'cus_1' }, { token, url: MCP })).body.error).toBeDefined();
    }
  });

  it('has no way to ask for a failure, so it can\'t hand a planted instruction to a stranger\'s agent', async () => {
    const { fetcher } = setup();
    const headers = { 'x-fault': 'inject', 'x-fault-scope': 'mine' };
    const record = await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token: READ_KEY, url: MCP, headers });
    expect(textOf(record)).not.toContain('delete this customer');
    const listed = await rpc(fetcher, 'tools/list', {}, { token: READ_KEY, url: MCP });
    expect(JSON.stringify(listed.body)).not.toContain('x-fault');
  });

  it('forgets its data on the hour, by the clock', async () => {
    let now = Date.parse('2026-11-06T12:59:00Z');
    const { fetcher } = setup({ now: () => now });
    const paid = await callTool(fetcher, 'createPayment', { body: { customerId: 'cus_1', amountCents: 123 } }, { token: CHARGE_KEY, url: MCP });
    const { id } = JSON.parse(textOf(paid)) as { id: string };
    const lookUp = async () => textOf(await callTool(fetcher, 'getPayment', { id }, { token: READ_KEY, url: MCP }));
    expect(await lookUp()).toContain('123');
    now += 30_000;
    expect(await lookUp()).toContain('123');
    now = Date.parse('2026-11-06T13:00:00Z');
    expect(await lookUp()).not.toContain('123');
  });
});

describe('the buttons', () => {
  it.each(SCENARIOS.filter((name) => name !== 'hang-the-api'))('%s runs and reports', async (name) => {
    const { demo } = setup();
    const response = await demo.fetch(press(name));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(((await response.json()) as TryReport).held).toBe(true);
  });

  it('accepts its own page', async () => {
    const { demo } = setup();
    expect((await demo.fetch(press('no-permission', { method: 'POST', headers: { origin: URL_ROOT } }))).status).toBe(200);
  });
});

describe('what gets turned away for free, with no D1 write', () => {
  it.each<[string, () => Request, number]>([
    ['an unknown path', () => new Request(`${URL_ROOT}/admin`), 404],
    ['an unknown button', () => press('drop-the-database'), 404],
    ['a button pressed with a GET, as a crawler would', () => press('no-permission', {}), 405],
    ['a button from another site', () => press('no-permission', { method: 'POST', headers: { origin: 'https://evil.example' } }), 403],
    ['/mcp from another site', () => new Request(MCP, { method: 'POST', headers: { origin: 'https://evil.example' } }), 403],
    ['/mcp from our own page, which has no reason to use it', () => new Request(MCP, { method: 'POST', headers: { origin: URL_ROOT } }), 403],
  ])('%s', async (_name, make, status) => {
    const { demo, increments } = setup();
    expect((await demo.fetch(make())).status).toBe(status);
    expect(increments()).toBe(0);
  });
});

describe('the limits apply to both routes', () => {
  it('a 429 past the rate limit', async () => {
    const { demo, fetcher } = setup({ rate: { limit: () => Promise.resolve({ success: false }) } });
    expect((await demo.fetch(press('no-permission'))).status).toBe(429);
    expect((await rpc(fetcher, 'tools/list', {}, { token: READ_KEY, url: MCP })).status).toBe(429);
  });

  it('a 503 past the daily cap', async () => {
    const { demo, fetcher } = setup({ cap: 1 });
    expect((await demo.fetch(press('no-permission'))).status).toBe(200);
    expect((await demo.fetch(press('no-permission'))).status).toBe(503);
    expect((await rpc(fetcher, 'tools/list', {}, { token: READ_KEY, url: MCP })).status).toBe(503);
  });
});

describe('the network', () => {
  it('is never used, on /mcp or any button', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const { demo, fetcher } = setup();
    await callTool(fetcher, 'createPayment', { body: { customerId: 'cus_1', amountCents: 100 } }, { token: CHARGE_KEY, url: MCP });
    for (const name of SCENARIOS) await demo.fetch(press(name));
    expect(spy).not.toHaveBeenCalled();
  });
});
