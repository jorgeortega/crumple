import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { callTool, rpc, textOf } from '../../tests/helpers/mcp.js';
import { createFaultApi, DEFAULT_CREDENTIAL, OPENAPI, type FaultApi } from '../fault-api/index.js';
import { serveOnNode, type NodeServer } from '../node.js';
import { convertOpenApi, createAudit, createKey, createMcpSurface, createTelemetry, memoryKeyStore, plainCredential, type Grant } from './index.js';

// The same claims over real sockets, with no shortcuts: an MCP client talks HTTP to Crumple, and
// Crumple talks HTTP to fault-api. In-process tests can hide a whole class of problem, as fault-api
// already found when a response that failed partway looked like no response at all over HTTP.

const open: NodeServer[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

async function serve(handler: (request: Request) => Promise<Response>): Promise<string> {
  const server = await serveOnNode(handler);
  open.push(server);
  return server.url;
}

async function setup(options: { fault?: string; grants?: Grant[]; deadlineMs?: number } = {}): Promise<{ api: FaultApi; key: string; mcpUrl: string; post: (request: Request) => Promise<Response> }> {
  const api = createFaultApi();
  const upstream = await serve((request) => api.fetch(request));
  const telemetry = createTelemetry();
  const keys = memoryKeyStore();
  const { key } = await createKey(keys, { label: 'test', grants: options.grants ?? [{ tool: '*' }] });
  const surface = createMcpSurface({
    tools: convertOpenApi(OPENAPI).tools,
    upstream: {
      baseUrl: upstream,
      getCredential: plainCredential('header', 'authorization', `Bearer ${DEFAULT_CREDENTIAL}`),
      random: () => 0,
      ...(options.fault ? { headers: { 'x-fault': options.fault } } : {}),
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    },
    access: { keys },
    telemetry,
    audit: createAudit(telemetry, []),
  });
  const base = await serve((request) => surface.fetch(request));
  const mcpUrl = new URL('/mcp', base).href;
  const post = (request: Request): Promise<Response> => fetch(new Request(new URL(new URL(request.url).pathname, base), request));
  return { api, key, mcpUrl, post };
}

describe('over real sockets', () => {
  it('C1: no key means 401, and zero requests reach the API', async () => {
    const { api, post } = await setup();
    const answer = await callTool(post, 'getCustomer', { id: 'cus_1' });
    expect(answer.status).toBe(401);
    expect(api.requests()).toEqual([]);
  });

  it('C1: an unread request body doesn\'t stop the next call on the same server', async () => {
    const { api, key, post } = await setup();
    for (let i = 0; i < 3; i += 1) await callTool(post, 'getCustomer', { id: 'cus_1' }, { token: 'nope' });
    expect((await callTool(post, 'getCustomer', { id: 'cus_1' }, { token: key })).status).toBe(200);
    expect(api.requests()).toHaveLength(1);
  });

  it('C3: the agent\'s key never arrives, and the configured credential does', async () => {
    const { api, key, post } = await setup();
    await callTool(post, 'getCustomer', { id: 'cus_1' }, { token: key });
    expect(api.requests()[0]?.headers.authorization).toBe(`Bearer ${DEFAULT_CREDENTIAL}`);
    expect(JSON.stringify(api.requests())).not.toContain(key);
  });

  it('C5: a lost response on a payment still leaves one effect', async () => {
    const { api, key, post } = await setup({ fault: 'drop;times=1', grants: [{ tool: 'createPayment', writes: true }] });
    const answer = await callTool(post, 'createPayment', { body: { customerId: 'cus_1', amountCents: 5000 } }, { token: key });
    expect(answer.body.result?.isError).toBeUndefined();
    expect(api.effects()).toHaveLength(1);
  });

  it('C5: when it can\'t get through, the model gets the key, and that retry leaves one effect', async () => {
    const { api, key, post } = await setup({ fault: 'drop;times=3', grants: [{ tool: 'createPayment', writes: true }] });
    const args = { body: { customerId: 'cus_1', amountCents: 5000 } };
    const first = await callTool(post, 'createPayment', args, { token: key });
    const error = JSON.parse(textOf(first)) as { code: string; idempotencyKey: string };
    expect(error.code).toBe('outcome_unknown');

    const again = await callTool(post, 'createPayment', { ...args, idempotencyKey: error.idempotencyKey }, { token: key });
    expect(again.body.result?.isError).toBeUndefined();
    expect(api.effects()).toHaveLength(1);
  });

  it('C6: a hanging API costs a structured error inside the deadline, not a hung client', async () => {
    const { api, key, post } = await setup({ fault: 'hang', deadlineMs: 300 });
    const started = performance.now();
    const answer = await callTool(post, 'getCustomer', { id: 'cus_1' }, { token: key });
    const elapsed = performance.now() - started;
    expect(JSON.parse(textOf(answer))).toMatchObject({ code: 'timeout', retry: 'later' });
    // The margin C6 states in SPEC-executor.md.
    expect(elapsed).toBeLessThan(300 + 500);
    await expect.poll(() => api.requests()[0]?.outcome).toBe('abandoned');
  });

  it('a client that goes away cancels the upstream call', async () => {
    const { api, key, post } = await setup({ fault: 'hang' });
    const controller = new AbortController();
    const pending = rpc(
      (request) => post(new Request(request, { signal: controller.signal })),
      'tools/call',
      { name: 'getCustomer', arguments: { id: 'cus_1' } },
      { token: key },
    ).catch(() => 'gone');
    await expect.poll(() => api.requests().length).toBe(1);
    controller.abort();
    expect(await pending).toBe('gone');
    await expect.poll(() => api.requests()[0]?.outcome).toBe('abandoned');
  });
});

// "The client most people get by default", and why decision 1 keeps older clients.
describe('the official TypeScript client', () => {
  async function connect(mcpUrl: string, key: string, options: ConstructorParameters<typeof Client>[1]) {
    const client = new Client({ name: 'test', version: '0' }, options);
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    return client;
  }

  it.each([
    ['pinned to 2026-07-28', { versionNegotiation: { mode: { pin: '2026-07-28' } } }, '2026-07-28'],
    ['on its default options', {}, '2025-11-25'],
  ] as const)('lists, calls and is refused, %s', async (_name, options, negotiated) => {
    const { api, key, mcpUrl } = await setup();
    const client = await connect(mcpUrl, key, options);
    try {
      // Checked, because the spike's first run passed while silently on the older protocol.
      expect(client.getNegotiatedProtocolVersion()).toBe(negotiated);

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(['getCustomer', 'getPayment', 'listCustomers']);

      const result = await client.callTool({ name: 'getCustomer', arguments: { id: 'cus_1' } });
      expect(result.isError).toBeFalsy();
      expect(api.requests()).toHaveLength(1);

      await expect(client.callTool({ name: 'deleteCustomer', arguments: { id: 'cus_1' } })).rejects.toThrow(/may not be allowed/);
      expect(api.requests()).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
