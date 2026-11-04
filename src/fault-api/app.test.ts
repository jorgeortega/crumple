import { afterEach, describe, expect, it } from 'vitest';
import { serveOnNode, type NodeServer } from '../node.js';
import { createFaultApi, DEFAULT_CREDENTIAL, type FaultApi } from './index.js';

interface Body {
  id?: string;
  name?: string;
  deleted?: boolean;
  items?: { id: string }[];
  error?: { code: string; message: string };
  amountCents?: number;
}

// Every behaviour has to hold both as a direct call and over real HTTP. A difference
// between the two would mean a check passes in one place and lies in the other.
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

describe.each(transports)('fault-api %s', (_label, connect) => {
  async function setup(options?: Parameters<typeof createFaultApi>[0]) {
    const api = createFaultApi(options);
    const transport = await connect(api);

    const call = async (
      method: string,
      path: string,
      { body, headers }: { body?: unknown; headers?: Record<string, string> } = {},
    ) => {
      const response = await transport(
        new Request(`http://fault-api.test${path}`, {
          method,
          headers: { authorization: `Bearer ${DEFAULT_CREDENTIAL}`, 'content-type': 'application/json', ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return { status: response.status, headers: response.headers, body: (await response.json()) as Body };
    };
    return { api, call };
  }

  describe('reads', () => {
    it('lists the seeded customers', async () => {
      const { call } = await setup();
      const { status, body } = await call('GET', '/customers');
      expect(status).toBe(200);
      expect(body.items?.map((customer) => customer.id)).toEqual(['cus_1', 'cus_2', 'cus_3']);
    });

    it('limits a list', async () => {
      const { call } = await setup();
      const { body } = await call('GET', '/customers?limit=2');
      expect(body.items).toHaveLength(2);
    });

    it('refuses a limit that is not a positive number', async () => {
      const { call } = await setup();
      const { status, body } = await call('GET', '/customers?limit=lots');
      expect(status).toBe(400);
      expect(body.error?.code).toBe('invalid_limit');
    });

    it('reads one customer', async () => {
      const { call } = await setup();
      const { status, body } = await call('GET', '/customers/cus_2');
      expect(status).toBe(200);
      expect(body.id).toBe('cus_2');
    });

    it('returns a 404 for a customer that does not exist', async () => {
      const { call } = await setup();
      const { status, body } = await call('GET', '/customers/cus_404');
      expect(status).toBe(404);
      expect(body.error?.code).toBe('not_found');
    });

    it('returns a 404 for an unknown path and a 405 for a known path with the wrong method', async () => {
      const { call } = await setup();
      expect((await call('GET', '/nowhere')).status).toBe(404);
      expect((await call('PUT', '/customers')).status).toBe(405);
    });
  });

  describe('writes', () => {
    it('creates a customer and records one effect', async () => {
      const { api, call } = await setup();
      const { status, body } = await call('POST', '/customers', { body: { name: 'Ada Example' } });
      expect(status).toBe(201);
      expect(body.id).toBe('cus_4');
      expect(api.effects()).toEqual([{ kind: 'customer.created', id: 'cus_4' }]);
    });

    it('refuses a customer without a name', async () => {
      const { api, call } = await setup();
      const { status } = await call('POST', '/customers', { body: {} });
      expect(status).toBe(400);
      expect(api.effects()).toEqual([]);
    });

    it.each([
      ['/customers', 'not json'],
      ['/customers', '[1, 2]'],
      ['/payments', 'null'],
    ])('refuses a %s body that is not a JSON object: %s', async (path, text) => {
      const api = createFaultApi();
      const response = await api.fetch(
        new Request(`http://fault-api.test${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${DEFAULT_CREDENTIAL}` },
          body: text,
        }),
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as Body).error?.code).toBe('invalid_body');
    });

    it('refuses a body over the size limit', async () => {
      const { api, call } = await setup();
      const { status } = await call('POST', '/customers', { body: { name: 'x'.repeat(70_000) } });
      expect(status).toBe(413);
      expect(api.effects()).toEqual([]);
    });

    it('deletes a customer once', async () => {
      const { api, call } = await setup();
      expect((await call('DELETE', '/customers/cus_1')).body.deleted).toBe(true);
      expect((await call('GET', '/customers/cus_1')).status).toBe(404);
      expect((await call('DELETE', '/customers/cus_1')).status).toBe(404);
      expect(api.effects()).toEqual([{ kind: 'customer.deleted', id: 'cus_1' }]);
    });

    it('charges an existing customer and reads the payment back', async () => {
      const { api, call } = await setup();
      const created = await call('POST', '/payments', { body: { customerId: 'cus_1', amountCents: 5000 } });
      expect(created.status).toBe(201);
      expect(created.body.id).toBe('pay_1');
      expect((await call('GET', '/payments/pay_1')).body.amountCents).toBe(5000);
      expect(api.effects()).toEqual([{ kind: 'payment.created', id: 'pay_1' }]);
    });

    it.each([
      ['no customer', { amountCents: 5000 }, 400],
      ['a customer that does not exist', { customerId: 'cus_404', amountCents: 5000 }, 404],
      ['a negative amount', { customerId: 'cus_1', amountCents: -1 }, 400],
      ['a fractional amount', { customerId: 'cus_1', amountCents: 1.5 }, 400],
    ])('refuses a payment with %s', async (_name, body, status) => {
      const { api, call } = await setup();
      expect((await call('POST', '/payments', { body })).status).toBe(status);
      expect(api.effects()).toEqual([]);
    });

    it('returns a 404 for a payment that does not exist', async () => {
      const { call } = await setup();
      expect((await call('GET', '/payments/pay_404')).status).toBe(404);
    });

    it('stops accepting new records when a scope is full', async () => {
      const { call } = await setup({ maxRecords: 4 });
      expect((await call('POST', '/customers', { body: { name: 'Fits' } })).status).toBe(201);
      const { status, body } = await call('POST', '/customers', { body: { name: 'Does not' } });
      expect(status).toBe(507);
      expect(body.error?.code).toBe('data_full');
      const payment = { customerId: 'cus_1', amountCents: 1 };
      const small = await setup({ maxRecords: 1 });
      expect((await small.call('POST', '/payments', { body: payment })).status).toBe(201);
      expect((await small.call('POST', '/payments', { body: payment })).status).toBe(507);
    });
  });

  // This is what lets a check show a double charge, and then show it prevented.
  describe('idempotency', () => {
    const charge = { customerId: 'cus_1', amountCents: 5000 };
    const withKey = { 'idempotency-key': 'key-1' };

    it('applies each request again when there is no key', async () => {
      const { api, call } = await setup();
      await call('POST', '/payments', { body: charge });
      await call('POST', '/payments', { body: charge });
      expect(api.effects()).toHaveLength(2);
    });

    it('applies once and replays the same response for a repeated key', async () => {
      const { api, call } = await setup();
      const first = await call('POST', '/payments', { body: charge, headers: withKey });
      const second = await call('POST', '/payments', { body: charge, headers: withKey });
      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      expect(second.headers.get('idempotent-replayed')).toBe('true');
      expect(api.effects()).toHaveLength(1);
    });

    it('refuses the same key with a different body', async () => {
      const { api, call } = await setup();
      await call('POST', '/payments', { body: charge, headers: withKey });
      const { status, body } = await call('POST', '/payments', {
        body: { ...charge, amountCents: 1 },
        headers: withKey,
      });
      expect(status).toBe(409);
      expect(body.error?.code).toBe('idempotency_key_reused');
      expect(api.effects()).toHaveLength(1);
    });

    it('lets a failed request try the same key again', async () => {
      const { api, call } = await setup();
      const bad = { customerId: 'cus_1', amountCents: -1 };
      expect((await call('POST', '/payments', { body: bad, headers: withKey })).status).toBe(400);
      expect((await call('POST', '/payments', { body: bad, headers: withKey })).status).toBe(400);
      expect(api.effects()).toEqual([]);
    });
  });

  describe('the credential', () => {
    it.each([
      ['no credential', {}],
      ['a wrong credential', { authorization: 'Bearer wrong' }],
    ])('refuses %s and applies nothing', async (_name, headers) => {
      const api = createFaultApi();
      const response = await api.fetch(
        new Request('http://fault-api.test/customers', { method: 'POST', headers, body: '{"name":"No"}' }),
      );
      expect(response.status).toBe(401);
      expect(api.effects()).toEqual([]);
    });

    it('accepts a configured credential', async () => {
      const { call } = await setup({ credential: 'another-fake-credential' });
      const headers = { authorization: 'Bearer another-fake-credential' };
      expect((await call('GET', '/customers', { headers })).status).toBe(200);
      expect((await call('GET', '/customers')).status).toBe(401);
    });

    it('serves its OpenAPI document without one', async () => {
      const api = createFaultApi();
      const response = await api.fetch(new Request('http://fault-api.test/openapi.json'));
      expect(response.status).toBe(200);
      expect(((await response.json()) as { openapi: string }).openapi).toBe('3.1.0');
    });
  });

  describe('the request log', () => {
    it('records every header it receives, even on a refused request', async () => {
      const { api, call } = await setup();
      await call('GET', '/customers', { headers: { authorization: 'Bearer wrong', 'x-agent-token': 'agent-secret' } });
      const [record] = api.requests();
      expect(record?.path).toBe('/customers');
      expect(record?.method).toBe('GET');
      expect(record?.headers['authorization']).toBe('Bearer wrong');
      expect(record?.headers['x-agent-token']).toBe('agent-secret');
    });

    it('drops the oldest records past its cap', async () => {
      const { api, call } = await setup({ maxLogEntries: 2 });
      await call('GET', '/customers/cus_1');
      await call('GET', '/customers/cus_2');
      await call('GET', '/customers/cus_3');
      expect(api.requests().map((record) => record.path)).toEqual(['/customers/cus_2', '/customers/cus_3']);
    });

    it('returns copies, so a check can\'t alter what happened', async () => {
      const { api, call } = await setup();
      await call('POST', '/customers', { body: { name: 'Ada' } });
      api.effects().pop();
      api.requests().pop();
      expect(api.effects()).toHaveLength(1);
      expect(api.requests()).toHaveLength(1);
    });
  });

  describe('scopes', () => {
    const scoped = (name: string) => ({ 'x-fault-scope': name });

    it('keeps data, effects and logs separate', async () => {
      const { api, call } = await setup();
      await call('DELETE', '/customers/cus_1', { headers: scoped('a') });
      expect((await call('GET', '/customers/cus_1', { headers: scoped('b') })).status).toBe(200);
      expect(api.effects('a')).toHaveLength(1);
      expect(api.effects('b')).toEqual([]);
      expect(api.requests('a')).toHaveLength(1);
      expect(api.requests('b')).toHaveLength(1);
    });

    it('keeps idempotency keys separate', async () => {
      const { api, call } = await setup();
      const charge = { customerId: 'cus_1', amountCents: 5000 };
      await call('POST', '/payments', { body: charge, headers: { ...scoped('a'), 'idempotency-key': 'k' } });
      await call('POST', '/payments', { body: charge, headers: { ...scoped('b'), 'idempotency-key': 'k' } });
      expect(api.effects('a')).toHaveLength(1);
      expect(api.effects('b')).toHaveLength(1);
    });

    it('refuses a scope name it can\'t safely use', async () => {
      const { call } = await setup();
      const { status, body } = await call('GET', '/customers', { headers: scoped('no spaces!') });
      expect(status).toBe(400);
      expect(body.error?.code).toBe('invalid_scope');
    });

    it('forgets the least recently used scope past its cap', async () => {
      const { api, call } = await setup({ maxScopes: 2 });
      await call('POST', '/customers', { body: { name: 'A' }, headers: scoped('a') });
      await call('POST', '/customers', { body: { name: 'B' }, headers: scoped('b') });
      await call('GET', '/customers', { headers: scoped('a') });
      await call('GET', '/customers', { headers: scoped('c') });
      expect(api.effects('a')).toHaveLength(1);
      expect(api.effects('b')).toEqual([]);
    });

    it('resets one scope, or all of them', async () => {
      const { api, call } = await setup();
      await call('DELETE', '/customers/cus_1', { headers: scoped('a') });
      await call('DELETE', '/customers/cus_1', { headers: scoped('b') });
      api.reset('a');
      expect(api.effects('a')).toEqual([]);
      expect(api.effects('b')).toHaveLength(1);
      expect((await call('GET', '/customers/cus_1', { headers: scoped('a') })).status).toBe(200);
      api.reset();
      expect(api.effects('b')).toEqual([]);
    });
  });

  // Off by default, because a public demo must not hand out what it received.
  describe('the control endpoints', () => {
    it('are a 404 unless turned on', async () => {
      const { call } = await setup();
      expect((await call('GET', '/_fault/requests')).status).toBe(404);
      expect((await call('POST', '/_fault/reset')).status).toBe(404);
    });

    it('read the log and effects and reset, when turned on', async () => {
      const { api, call } = await setup({ control: true });
      await call('DELETE', '/customers/cus_1', { headers: { 'x-fault-scope': 'a' } });

      const requests = await call('GET', '/_fault/requests?scope=a');
      expect(requests.body.items).toHaveLength(1);
      const effects = await call('GET', '/_fault/effects?scope=a');
      expect(effects.body.items).toEqual([{ kind: 'customer.deleted', id: 'cus_1' }]);
      expect((await call('POST', '/_fault/reset?scope=a')).status).toBe(200);
      expect(api.effects('a')).toEqual([]);

      await call('DELETE', '/customers/cus_1');
      expect((await call('POST', '/_fault/reset')).status).toBe(200);
      expect(api.effects()).toEqual([]);
      expect((await call('GET', '/_fault/unknown')).status).toBe(404);
    });
  });

  it('serves many parallel requests without mixing them up', async () => {
    const { api, call } = await setup();
    const names = Array.from({ length: 50 }, (_, index) => `scope-${index % 5}`);
    const results = await Promise.all(
      names.map((name) => call('POST', '/payments', {
        body: { customerId: 'cus_1', amountCents: 100 },
        headers: { 'x-fault-scope': name },
      })),
    );
    expect(results.every((result) => result.status === 201)).toBe(true);
    for (const index of [0, 1, 2, 3, 4]) expect(api.effects(`scope-${index}`)).toHaveLength(10);
  });
});
