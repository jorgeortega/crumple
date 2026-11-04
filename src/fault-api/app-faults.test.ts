import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveOnNode, type NodeServer } from '../node.js';
import { MAX_LARGE_BYTES, MAX_WAIT_MS } from './faults.js';
import { createFaultApi, DEFAULT_CREDENTIAL, MALICIOUS_TEXT, type FaultApi, type FaultApiOptions } from './index.js';

const servers: NodeServer[] = [];
const transports = [
  ['in process', (api: FaultApi) => Promise.resolve((request: Request) => api.fetch(request))],
  [
    'over HTTP',
    async (api: FaultApi) => {
      const server = await serveOnNode((request) => api.fetch(request));
      servers.push(server);
      return (request: Request) => {
        const { pathname, search } = new URL(request.url);
        return fetch(new Request(`${server.url}${pathname}${search}`, request));
      };
    },
  ],
] as const;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

// No real waiting: a short wait passes at once, and a long one lasts until the caller aborts.
function fakeSleep() {
  const waits: number[] = [];
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      waits.push(ms);
      if (ms < MAX_WAIT_MS) resolve();
      // An abort event never fires twice, and on Node 22 this can start just after it fired.
      if (signal.aborted) reject(signal.reason as Error);
      signal.addEventListener('abort', () => {
        reject(signal.reason as Error);
      }, { once: true });
    });
  return { sleep, waits };
}

const CHARGE = { customerId: 'cus_1', amountCents: 5000 };

describe.each(transports)('faults %s', (_label, connect) => {
  async function setup(options: FaultApiOptions = {}) {
    const { sleep, waits } = fakeSleep();
    const api = createFaultApi({ sleep, ...options });
    const transport = await connect(api);

    const send = (
      method: string,
      path: string,
      fault: string,
      { body, headers, signal }: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
    ) =>
      transport(
        new Request(`http://fault-api.test${path}`, {
          method,
          headers: { authorization: `Bearer ${DEFAULT_CREDENTIAL}`, 'x-fault': fault, ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(signal ? { signal } : {}),
        }),
      );
    return { api, send, waits };
  }

  it('refuses a fault it does not understand, and applies nothing', async () => {
    const { api, send } = await setup();
    const response = await send('POST', '/payments', 'stauts=503', { body: CHARGE });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe('invalid_fault');
    expect(error.message).toContain('stauts');
    expect(api.effects()).toEqual([]);
  });

  it('checks the credential first, so a refused call counts for nothing', async () => {
    const { send } = await setup();
    const wrong = { authorization: 'Bearer wrong' };
    expect((await send('GET', '/customers', 'status=503;times=1', { headers: wrong })).status).toBe(401);
    expect((await send('GET', '/customers', 'status=503;times=1')).status).toBe(503);
    expect((await send('GET', '/customers', 'status=503;times=1')).status).toBe(200);
  });

  describe('status', () => {
    it('returns the status and applies no write', async () => {
      const { api, send } = await setup();
      const response = await send('POST', '/payments', 'status=503', { body: CHARGE });
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('fault_injected');
      expect(api.effects()).toEqual([]);
    });

    it('adds Retry-After when asked', async () => {
      const { send } = await setup();
      const response = await send('GET', '/customers', 'status=429;retry-after=7');
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('7');
    });

    it('sends none by default', async () => {
      const { send } = await setup();
      const response = await send('GET', '/customers', 'status=500');
      expect(response.headers.get('retry-after')).toBeNull();
    });
  });

  describe('times', () => {
    it('fails only the first n matching requests, then behaves', async () => {
      const { send } = await setup();
      const statuses = [];
      for (let i = 0; i < 4; i += 1) statuses.push((await send('GET', '/customers', 'status=503;times=2')).status);
      expect(statuses).toEqual([503, 503, 200, 200]);
    });

    it('counts each scope separately', async () => {
      const { send } = await setup();
      const scoped = (name: string) => ({ headers: { 'x-fault-scope': name } });
      expect((await send('GET', '/customers', 'status=503;times=1', scoped('a'))).status).toBe(503);
      expect((await send('GET', '/customers', 'status=503;times=1', scoped('b'))).status).toBe(503);
      expect((await send('GET', '/customers', 'status=503;times=1', scoped('a'))).status).toBe(200);
    });

    it('forgets the oldest counter past its cap, so a public demo can\'t fill memory', async () => {
      const { send } = await setup({ maxRecords: 1 });
      expect((await send('GET', '/customers', 'status=503;times=1')).status).toBe(503);
      expect((await send('GET', '/customers', 'status=500;times=1')).status).toBe(500);
      expect((await send('GET', '/customers', 'status=503;times=1')).status).toBe(503);
    });
  });

  describe('delay', () => {
    it('waits, then answers normally', async () => {
      const { send, waits } = await setup();
      const response = await send('GET', '/customers', 'delay=250');
      expect(response.status).toBe(200);
      expect(waits).toEqual([250]);
    });

    it('waits, then fails, when combined with a status', async () => {
      const { send, waits } = await setup();
      expect((await send('GET', '/customers', 'delay=250;status=500')).status).toBe(500);
      expect(waits).toEqual([250]);
    });
  });

  // C6: a deadline only works if the caller can walk away and the upstream notices.
  describe('hang', () => {
    it('never answers until the caller gives up, and records that it was abandoned', async () => {
      const { api, send } = await setup();
      const controller = new AbortController();
      const pending = send('POST', '/payments', 'hang', { body: CHARGE, signal: controller.signal });

      await vi.waitFor(() => {
        expect(api.requests()[0]?.outcome).toBe('pending');
      });
      controller.abort(new Error('deadline'));

      await expect(pending).rejects.toBeDefined();
      await vi.waitFor(() => {
        expect(api.requests()[0]?.outcome).toBe('abandoned');
      });
      expect(api.effects()).toEqual([]);
    });

    it('stops at the cap, so an abandoned request can\'t last forever', async () => {
      const api = createFaultApi({ sleep: () => Promise.resolve() });
      const transport = await connect(api);
      const response = await transport(new Request('http://fault-api.test/customers', {
        headers: { authorization: `Bearer ${DEFAULT_CREDENTIAL}`, 'x-fault': 'hang' },
      }));
      expect(response.status).toBe(504);
      expect(api.requests()[0]?.outcome).toBe('answered');
    });
  });

  // The classic bug: a timeout that only covers the wait for headers never fires here.
  describe('stall-body', () => {
    it('sends headers and part of the body, then hangs until the caller gives up', async () => {
      const { api, send } = await setup();
      const controller = new AbortController();
      const response = await send('GET', '/customers', 'stall-body', { signal: controller.signal });
      expect(response.status).toBe(200);

      const reader = response.body?.getReader();
      const first = (await reader?.read()) as { value: Uint8Array };
      expect(first.value.byteLength).toBeGreaterThan(0);

      const second = reader?.read();
      controller.abort(new Error('deadline'));
      await expect(second).rejects.toBeDefined();
      await vi.waitFor(() => {
        expect(api.requests()[0]?.outcome).toBe('abandoned');
      });
    });

    it('notices when the caller cancels the body', async () => {
      const { api, send } = await setup();
      const response = await send('GET', '/customers', 'stall-body');
      const reader = response.body?.getReader();
      await reader?.read();
      await reader?.cancel();
      await vi.waitFor(() => {
        expect(api.requests()[0]?.outcome).toBe('abandoned');
      });
    });

    it('stops at the cap', async () => {
      const api = createFaultApi({ sleep: () => Promise.resolve() });
      const transport = await connect(api);
      const response = await transport(new Request('http://fault-api.test/customers', {
        headers: { authorization: `Bearer ${DEFAULT_CREDENTIAL}`, 'x-fault': 'stall-body' },
      }));
      await expect(response.text()).rejects.toBeDefined();
    });
  });

  // C5, the heart of the project. The write happened, but the caller can't know that.
  describe('drop', () => {
    it('applies the write, then loses the response partway', async () => {
      const { api, send } = await setup();
      const response = await send('POST', '/payments', 'drop', { body: CHARGE });
      expect(response.status).toBe(201);
      await expect(response.text()).rejects.toBeDefined();
      expect(api.effects()).toEqual([{ kind: 'payment.created', id: 'pay_1' }]);
      await vi.waitFor(() => {
        expect(api.requests()[0]?.outcome).toBe('dropped');
      });
    });

    it('a blind retry charges twice, which is the bug to prevent', async () => {
      const { api, send } = await setup();
      const first = await send('POST', '/payments', 'drop;times=1', { body: CHARGE });
      await first.text().catch(() => undefined);
      const retry = await send('POST', '/payments', 'drop;times=1', { body: CHARGE });
      expect(retry.status).toBe(201);
      await retry.text();
      expect(api.effects()).toHaveLength(2);
    });

    it('a retry with the same idempotency key has exactly one effect', async () => {
      const { api, send } = await setup();
      const headers = { 'idempotency-key': 'attempt-1' };
      const first = await send('POST', '/payments', 'drop;times=1', { body: CHARGE, headers });
      await first.text().catch(() => undefined);

      const retry = await send('POST', '/payments', 'drop;times=1', { body: CHARGE, headers });
      expect(retry.status).toBe(201);
      expect(retry.headers.get('idempotent-replayed')).toBe('true');
      expect(((await retry.json()) as { id: string }).id).toBe('pay_1');
      expect(api.effects()).toEqual([{ kind: 'payment.created', id: 'pay_1' }]);
    });
  });

  describe('inject', () => {
    it('puts the malicious text in one record', async () => {
      const { send } = await setup();
      const body = (await (await send('GET', '/customers/cus_1', 'inject')).json()) as { id: string; notes: string };
      expect(body.id).toBe('cus_1');
      expect(body.notes).toBe(MALICIOUS_TEXT);
    });

    it('puts it in each record of a list', async () => {
      const { send } = await setup();
      const body = (await (await send('GET', '/customers', 'inject')).json()) as { items: { notes: string }[] };
      expect(body.items.map((item) => item.notes)).toEqual([MALICIOUS_TEXT, MALICIOUS_TEXT, MALICIOUS_TEXT]);
    });

    it('doesn\'t change what\'s stored', async () => {
      const { send } = await setup();
      await send('GET', '/customers/cus_1', 'inject');
      const body = (await (await send('GET', '/customers/cus_1', '')).json()) as { notes: string };
      expect(body.notes).not.toBe(MALICIOUS_TEXT);
    });
  });

  describe('echo-auth', () => {
    it('returns the credential it received', async () => {
      const { send } = await setup();
      const body = (await (await send('GET', '/customers/cus_1', 'echo-auth')).json()) as { receivedAuthorization: string };
      expect(body.receivedAuthorization).toBe(`Bearer ${DEFAULT_CREDENTIAL}`);
    });

    it('does it in an error too, the way a careless API does', async () => {
      const { send } = await setup();
      const response = await send('GET', '/customers/cus_1', 'status=500;echo-auth');
      expect(response.status).toBe(500);
      expect(await response.text()).toContain(DEFAULT_CREDENTIAL);
    });
  });

  describe('large', () => {
    it('returns exactly that many bytes', async () => {
      const { send } = await setup();
      const size = 200_000;
      const response = await send('GET', '/customers', `large=${size}`);
      expect((await response.arrayBuffer()).byteLength).toBe(size);
    });

    it('produces it lazily, so a caller that stops reading stops the work', async () => {
      const { send } = await setup();
      const response = await send('GET', '/customers', `large=${MAX_LARGE_BYTES}`);
      const reader = response.body?.getReader();
      const first = (await reader?.read()) as { value: Uint8Array };
      expect(first.value.byteLength).toBeLessThan(MAX_LARGE_BYTES);
      await reader?.cancel();
    });
  });

  describe('not-json', () => {
    it('returns an HTML page with a success status', async () => {
      const { send } = await setup();
      const response = await send('GET', '/customers', 'not-json');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toContain('<html');
    });

    it('returns one with a chosen status, as a broken proxy does', async () => {
      const { send } = await setup();
      const response = await send('GET', '/customers', 'status=502;not-json');
      expect(response.status).toBe(502);
      expect(response.headers.get('content-type')).toContain('text/html');
    });
  });

  it('keeps parallel requests with different faults from interfering', async () => {
    const { api, send } = await setup();
    const faults = ['', 'status=503', 'delay=10', 'status=429;retry-after=1', 'inject', 'not-json'];
    const requests = Array.from({ length: 48 }, (_, index) => {
      const fault = faults[index % faults.length] ?? '';
      return send('GET', '/customers/cus_1', fault, { headers: { 'x-fault-scope': `s${index % faults.length}` } })
        .then(async (response) => ({ fault, status: response.status, text: await response.text() }));
    });
    const results = await Promise.all(requests);

    for (const { fault, status, text } of results) {
      if (fault === '' || fault === 'delay=10') {
        expect(status).toBe(200);
        expect(text).not.toContain(MALICIOUS_TEXT);
      }
      if (fault === 'status=503') expect(status).toBe(503);
      if (fault === 'status=429;retry-after=1') expect(status).toBe(429);
      if (fault === 'inject') expect(text).toContain(MALICIOUS_TEXT);
      if (fault === 'not-json') expect(text).toContain('<html');
    }
    expect(api.requests('s0')).toHaveLength(8);
    expect(api.requests('s5')).toHaveLength(8);
  });
});

describe('the default sleep', () => {
  it('waits for real, for the rare case nothing was injected', async () => {
    const api = createFaultApi();
    const started = Date.now();
    const response = await api.fetch(new Request('http://fault-api.test/customers', {
      headers: { authorization: `Bearer ${DEFAULT_CREDENTIAL}`, 'x-fault': 'delay=5' },
    }));
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
  });

  it('stops at once when the caller has already given up', async () => {
    const api = createFaultApi();
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    await expect(api.fetch(new Request('http://fault-api.test/customers', {
      headers: { authorization: `Bearer ${DEFAULT_CREDENTIAL}`, 'x-fault': 'hang' },
      signal: controller.signal,
    }))).rejects.toThrow('already gone');
    expect(api.requests()[0]?.outcome).toBe('abandoned');
  });

  it('stops partway when the caller gives up during the wait', async () => {
    const api = createFaultApi();
    const controller = new AbortController();
    const pending = api.fetch(new Request('http://fault-api.test/customers', {
      headers: { authorization: `Bearer ${DEFAULT_CREDENTIAL}`, 'x-fault': 'hang' },
      signal: controller.signal,
    }));
    controller.abort(new Error('gave up'));
    await expect(pending).rejects.toThrow('gave up');
  });
});
