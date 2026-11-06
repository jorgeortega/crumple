import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CREDENTIAL, MALICIOUS_TEXT } from '../../src/fault-api/index.js';
import { startWorker, type RunningWorker } from './harness.js';

// fault-api's spec promises its faults behave the same on Workers as on Node. Its full suite runs on
// Node, with no real waiting. This is the same list of behaviours, on workerd, over a real socket,
// with real waits. The lost response is the one that differs most between runtimes.

let worker: RunningWorker;
beforeAll(async () => { worker = await startWorker({ port: 8812, config: 'tests/workers/fault-worker/wrangler.toml' }); });
afterAll(async () => { await worker.stop(); });

// One scope per test, so nothing is shared.
let scope = 0;
beforeEach(() => { scope += 1; });

interface Sent { fault?: string; body?: unknown; key?: string; signal?: AbortSignal; credential?: string }

const send = (method: string, path: string, { fault, body, key, signal, credential = DEFAULT_CREDENTIAL }: Sent = {}): Promise<Response> =>
  fetch(`${worker.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      'x-fault-scope': `s${String(scope)}`,
      ...(fault === undefined ? {} : { 'x-fault': fault }),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });

const control = async (path: string): Promise<{ items: { outcome?: string }[] }> =>
  (await fetch(`${worker.url}/_fault/${path}?scope=s${String(scope)}`)).json() as Promise<{ items: { outcome?: string }[] }>;
const effects = async (): Promise<number> => (await control('effects')).items.length;

const CHARGE = { customerId: 'cus_1', amountCents: 5000 };
const pay = (more: Sent = {}): Promise<Response> => send('POST', '/payments', { body: CHARGE, ...more });

// What matters is that the caller doesn't get the payment back. How it finds out differs, and this is
// where the runtimes part ways: on Node the socket breaks partway. Here, wrangler dev's own layer sees
// the broken stream first and answers with an error of its own. The demo isn't affected, because its
// fault-api is a function call with no socket in between, and workers/try.run.ts tests that path.
async function gotThePayment(response: Response): Promise<boolean> {
  try {
    const answer = JSON.parse(await response.text()) as { customerId?: unknown };
    return answer.customerId === CHARGE.customerId;
  } catch {
    return false;
  }
}

describe('fault-api in workerd', () => {
  it('answers normally with no fault, and checks the credential first', async () => {
    const fine = await send('GET', '/customers/cus_1');
    expect(fine.status).toBe(200);
    expect((await fine.json()) as object).toMatchObject({ id: 'cus_1' });
    expect((await send('GET', '/customers/cus_1', { credential: 'wrong' })).status).toBe(401);
    expect((await send('GET', '/customers/cus_1', { fault: 'nonsense' })).status).toBe(400);
  });

  it('applies a write once, and repeats it for the same idempotency key', async () => {
    const first = await pay({ key: 'k1' });
    const second = await pay({ key: 'k1' });
    expect(first.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await effects()).toBe(1);
  });

  it('status: fails with no write, and Retry-After when asked, then behaves after times=1', async () => {
    const failed = await pay({ fault: 'status=503;retry-after=7;times=1' });
    expect(failed.status).toBe(503);
    expect(failed.headers.get('retry-after')).toBe('7');
    expect(await effects()).toBe(0);
    expect((await pay({ fault: 'status=503;retry-after=7;times=1' })).status).toBe(201);
  });

  it('delay: really waits, then answers', async () => {
    const started = performance.now();
    expect((await send('GET', '/customers/cus_1', { fault: 'delay=120' })).status).toBe(200);
    expect(performance.now() - started).toBeGreaterThanOrEqual(110);
  });

  it('hang: never answers, until the caller gives up', async () => {
    const started = performance.now();
    await expect(send('GET', '/customers/cus_1', { fault: 'hang', signal: AbortSignal.timeout(300) })).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('stall-body: starts answering, then stops, until the caller gives up', async () => {
    const response = await send('GET', '/customers/cus_1', { fault: 'stall-body', signal: AbortSignal.timeout(300) });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });

  it('drop: applies the write, then the caller can\'t get the whole answer', async () => {
    expect(await gotThePayment(await pay({ fault: 'drop' }))).toBe(false);
    expect(await effects()).toBe(1);
  });

  it('drop: a blind retry charges twice, and the same key charges once', async () => {
    const once = (more: Sent = {}): Promise<boolean> => pay({ fault: 'drop;times=1', ...more }).then(gotThePayment);
    expect(await once()).toBe(false);
    expect(await once()).toBe(true);
    expect(await effects()).toBe(2);

    scope += 1;
    expect(await once({ key: 'same' })).toBe(false);
    expect(await once({ key: 'same' })).toBe(true);
    expect(await effects()).toBe(1);
  });

  it('inject: puts the text in the record it returns, and doesn\'t store it', async () => {
    const injected = await send('GET', '/customers/cus_1', { fault: 'inject' });
    expect((await injected.json()) as object).toMatchObject({ notes: MALICIOUS_TEXT });
    expect(await (await send('GET', '/customers/cus_1')).text()).not.toContain(MALICIOUS_TEXT);
  });

  it('echo-auth: repeats the credential, as a careless API does', async () => {
    const echoed = await send('GET', '/customers/cus_1', { fault: 'echo-auth' });
    expect((await echoed.json()) as object).toMatchObject({ receivedAuthorization: `Bearer ${DEFAULT_CREDENTIAL}` });
  });

  it('large: returns exactly that many bytes', async () => {
    const big = await send('GET', '/customers/cus_1', { fault: 'large=200000' });
    expect((await big.arrayBuffer()).byteLength).toBe(200_000);
  });

  it('not-json: returns an HTML page with a success status', async () => {
    const page = await send('GET', '/customers/cus_1', { fault: 'not-json' });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
  });

  it('keeps parallel requests with different faults apart', async () => {
    const replies = await Promise.all(Array.from({ length: 30 }, (_, index) => {
      const fault = ['delay=20', 'status=500', 'inject'][index % 3];
      return send('GET', '/customers/cus_1', { ...(fault === undefined ? {} : { fault }) }).then(async (response) => ({ fault, status: response.status, text: await response.text() }));
    }));
    for (const { fault, status, text } of replies) {
      expect(status).toBe(fault === 'status=500' ? 500 : 200);
      expect(text.includes(MALICIOUS_TEXT)).toBe(fault === 'inject');
    }
  });
});
