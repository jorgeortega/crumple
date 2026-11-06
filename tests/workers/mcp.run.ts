import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countChecks, createBudget, createHttpTransport, DEFAULT_MAX_REQUESTS, proveServer } from '../../src/prove/index.js';
import { CHARGE_KEY, READ_KEY } from '../../workers/surface.js';
import { callTool, rpc, textOf, type Fetcher } from '../helpers/mcp.js';
import { startWorker, type RunningWorker } from './harness.js';

// The first thing anyone will try: the same outside checks anyone can run, on Cloudflare's runtime.

let worker: RunningWorker;
let endpoint: string;
const fetcher: Fetcher = (request) => fetch(request);

beforeAll(async () => {
  worker = await startWorker({ port: 8811, migrate: true });
  endpoint = `${worker.url}/mcp`;
});
afterAll(async () => { await worker.stop(); });

describe('/mcp in workerd', () => {
  it('passes prove, from the outside', async () => {
    const budget = createBudget(DEFAULT_MAX_REQUESTS);
    const transport = createHttpTransport({ url: endpoint, token: READ_KEY, timeoutMs: 10_000, budget });
    const result = await proveServer({ transport, budget, hasToken: true });
    const failed = result.checks.filter((check) => check.state === 'fail');
    expect(failed).toEqual([]);
    expect(countChecks(result.checks).passed).toBeGreaterThanOrEqual(4);
  });

  it('shows the read key the reads, and no writes', async () => {
    const listed = await rpc(fetcher, 'tools/list', {}, { token: READ_KEY, url: endpoint });
    const names = listed.body.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain('getCustomer');
    expect(names).not.toContain('createPayment');
    expect(names).not.toContain('deleteCustomer');
  });

  it('lets the charge key charge, and neither key delete', async () => {
    const paid = await callTool(fetcher, 'createPayment', { body: { customerId: 'cus_1', amountCents: 5000 } }, { token: CHARGE_KEY, url: endpoint });
    expect(paid.body.result?.isError).not.toBe(true);
    expect(textOf(paid)).toContain('cus_1');
    for (const token of [READ_KEY, CHARGE_KEY]) {
      const refused = await callTool(fetcher, 'deleteCustomer', { id: 'cus_1' }, { token, url: endpoint });
      expect(refused.body.error?.message).toContain('Unknown tool');
    }
  });

  it('answers many callers at once with the same shared key', async () => {
    const calls = Array.from({ length: 25 }, () => callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token: READ_KEY, url: endpoint }));
    const results = await Promise.all(calls);
    const failed = results.filter((result) => result.status !== 200 || result.body.result?.isError === true || result.body.error !== undefined);
    expect(failed.map((result) => textOf(result) || result.body.error?.message)).toEqual([]);
  });

  it('refuses a request with no key, or from a web page on another site', async () => {
    expect((await rpc(fetcher, 'tools/list', {}, { url: endpoint })).status).toBe(401);
    const foreign = await rpc(fetcher, 'tools/list', {}, { token: READ_KEY, url: endpoint, headers: { origin: 'https://evil.example' } }).catch(() => undefined);
    expect(foreign?.status).toBe(403);
  });
});
