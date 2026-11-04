import { describe, expect, it } from 'vitest';
import { AUDIENCE, createIssuer, goodClaims, ISSUER, NOW_S } from '../../tests/helpers/issuer.js';
import { callTool, legacyRpc, LEGACY, rpc, textOf, TRACEPARENT, type Fetcher } from '../../tests/helpers/mcp.js';
import { createFaultApi, DEFAULT_CREDENTIAL, MALICIOUS_TEXT, OPENAPI } from '../fault-api/index.js';
import { convertOpenApi, createAudit, createKey, createMcpSurface, createTelemetry, memoryAuditSink, memoryKeyStore, memorySink, plainCredential, type Grant } from './index.js';
import { toToolResult } from './results.js';
import { signedInInfo, type McpSurfaceOptions } from './server.js';

const READS: Grant[] = [{ tool: '*' }];
const PAYS: Grant[] = [{ tool: '*' }, { tool: 'createPayment', writes: true }];
const PAYMENT = { body: { customerId: 'cus_1', amountCents: 5000 } };

function setup(options: { fault?: string; tools?: McpSurfaceOptions['tools']; surface?: Partial<McpSurfaceOptions> } = {}) {
  const api = createFaultApi();
  const spans = memorySink();
  const records = memoryAuditSink();
  const telemetry = createTelemetry({ sinks: [spans], strict: true });
  const keys = memoryKeyStore();
  const surface = createMcpSurface({
    tools: options.tools ?? convertOpenApi(OPENAPI).tools,
    upstream: {
      baseUrl: 'http://fault-api.test',
      getCredential: plainCredential('header', 'authorization', `Bearer ${DEFAULT_CREDENTIAL}`),
      ...(options.fault ? { headers: { 'x-fault': options.fault } } : {}),
      fetch: (request: Request) => api.fetch(request),
      // No jitter means no wait between attempts, so these stay fast on a real clock.
      random: () => 0,
    },
    access: { keys },
    telemetry,
    audit: createAudit(telemetry, [records]),
    ...options.surface,
  });
  const fetcher: Fetcher = (request) => surface.fetch(request);
  const keyWith = async (grants: Grant[]) => (await createKey(keys, { label: 't', grants })).key;
  return { api, fetcher, keyWith, keys, records, spans, surface };
}

describe('C1: denied by default, and fault-api can finally count it', () => {
  it.each([
    ['no key', undefined],
    ['a bad key', 'nope'],
    ['a well-formed key nobody issued', `crumple_${'a'.repeat(43)}`],
  ])('with %s, the answer is 401 and zero requests reach the API', async (_name, token) => {
    const { api, fetcher } = setup();
    const answer = await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token });
    expect(answer.status).toBe(401);
    expect(api.requests()).toEqual([]);
  });

  it('tells a client how to sign in', async () => {
    const { fetcher } = setup();
    const response = await fetcher(new Request('http://crumple.test/mcp', { method: 'POST', body: '{}' }));
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('refuses a revoked key straight away', async () => {
    const { api, fetcher, keys } = setup();
    const { id, key } = await createKey(keys, { label: 't', grants: READS });
    expect((await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token: key })).status).toBe(200);
    await keys.revoke(id, 1);
    expect((await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token: key })).status).toBe(401);
    expect(api.requests()).toHaveLength(1);
  });

  it('refuses every other method without a key too', async () => {
    const { fetcher } = setup();
    expect((await rpc(fetcher, 'tools/list')).status).toBe(401);
    expect((await rpc(fetcher, 'server/discover')).status).toBe(401);
  });

  it('with a key but no grant, zero requests reach the API', async () => {
    const { api, fetcher, keyWith } = setup();
    const answer = await callTool(fetcher, 'createPayment', PAYMENT, { token: await keyWith(READS) });
    expect(answer.body.error?.code).toBe(-32602);
    expect(api.requests()).toEqual([]);
    expect(api.effects()).toEqual([]);
  });

  it('says 503 when it can\'t check, and sends nothing', async () => {
    const { api, fetcher } = setup({ surface: { access: { keys: { ...memoryKeyStore(), findByHash: () => Promise.reject(new Error('down')) } } } });
    const response = await fetcher(new Request('http://crumple.test/mcp', { method: 'POST', headers: { authorization: `Bearer crumple_${'a'.repeat(43)}` }, body: '{}' }));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(api.requests()).toEqual([]);
  });
});

// The whole reason for writing our own handler.
describe('one door for every call', () => {
  it('answers a hidden tool and an unknown tool the same way', async () => {
    const { fetcher, keyWith } = setup();
    const token = await keyWith(READS);
    const hidden = await callTool(fetcher, 'createPayment', PAYMENT, { token });
    const unknown = await callTool(fetcher, 'noSuchTool', PAYMENT, { token });
    const strip = (answer: typeof hidden) => answer.body.error?.message.replace(/createPayment|noSuchTool/, 'X');
    expect(hidden.body.error?.code).toBe(-32602);
    expect(unknown.body.error?.code).toBe(-32602);
    expect(strip(hidden)).toBe(strip(unknown));
    expect(hidden.body.error?.message).toContain('may not be allowed');
  });

  // The event an operator most wants to see. The usual design records nothing here.
  it('leaves an audit event for an attempted write, with the real reason', async () => {
    const { fetcher, keyWith, records } = setup();
    await callTool(fetcher, 'deleteCustomer', { id: 'cus_1' }, { token: await keyWith(READS) });
    expect(records.events()).toEqual([expect.objectContaining({ tool: 'deleteCustomer', decision: 'deny', reason: 'writes_not_allowed' })]);
  });

  it('leaves one for a tool that doesn\'t exist too', async () => {
    const { fetcher, keyWith, records } = setup();
    await callTool(fetcher, 'noSuchTool', {}, { token: await keyWith(READS) });
    expect(records.events()).toEqual([expect.objectContaining({ tool: 'noSuchTool', decision: 'deny', reason: 'no_grant' })]);
  });

  it('leaves one for an allowed call', async () => {
    const { fetcher, keyWith, records } = setup();
    await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token: await keyWith(READS) });
    expect(records.events()).toEqual([expect.objectContaining({ tool: 'getCustomer', decision: 'allow' })]);
  });

  it('doesn\'t check the arguments of a refused call, so bad ones change nothing', async () => {
    const { fetcher, keyWith } = setup();
    const token = await keyWith(READS);
    const good = await callTool(fetcher, 'createPayment', PAYMENT, { token });
    const bad = await callTool(fetcher, 'createPayment', { nonsense: true }, { token });
    expect(bad.body.error).toEqual(good.body.error);
  });

  it('keeps a long name out of the answer', async () => {
    const { fetcher, keyWith } = setup();
    const answer = await callTool(fetcher, 'x'.repeat(5_000), {}, { token: await keyWith(READS) });
    expect(answer.body.error?.message.length).toBeLessThan(300);
  });

  it('isn\'t fooled by a tool named after a built-in', async () => {
    const { fetcher, keyWith } = setup();
    for (const name of ['__proto__', 'constructor', 'toString']) {
      expect((await callTool(fetcher, name, {}, { token: await keyWith(READS) })).body.error?.code).toBe(-32602);
    }
  });

  // C2 at this level. The real model test waits for evals.
  it('refuses the delete a malicious record asks for, even when the agent tries it', async () => {
    const { api, fetcher, keyWith, records } = setup({ fault: 'inject' });
    const token = await keyWith(READS);
    const read = await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token });
    expect(textOf(read)).toContain(MALICIOUS_TEXT);

    const obeyed = await callTool(fetcher, 'deleteCustomer', { id: 'cus_1' }, { token });
    expect(obeyed.body.error?.code).toBe(-32602);
    expect(api.effects()).toEqual([]);
    expect(records.events().at(-1)).toMatchObject({ tool: 'deleteCustomer', decision: 'deny' });
  });
});

describe('tools/list', () => {
  it('shows only what this caller may use', async () => {
    const { fetcher, keyWith } = setup();
    const names = async (grants: Grant[]) => (await rpc(fetcher, 'tools/list', {}, { token: await keyWith(grants) })).body.result?.tools?.map((tool) => tool.name).sort();
    expect(await names([])).toEqual([]);
    expect(await names(READS)).toEqual(['getCustomer', 'getPayment', 'listCustomers']);
    expect(await names(PAYS)).toEqual(['createPayment', 'getCustomer', 'getPayment', 'listCustomers']);
  });

  it('sends the schema and hints, and nothing of ours', async () => {
    const { fetcher, keyWith } = setup();
    const answer = await rpc(fetcher, 'tools/list', {}, { token: await keyWith(READS) });
    const tool = answer.body.result?.tools?.find((candidate) => candidate.name === 'getCustomer') as Record<string, unknown>;
    expect(Object.keys(tool).sort()).toEqual(['annotations', 'description', 'inputSchema', 'name', 'title']);
    expect(tool.inputSchema).toMatchObject({ type: 'object', required: ['id'] });
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
  });

  // Lists differ by caller, so a shared cache must never keep one.
  it('is marked private, so one caller\'s tools can\'t be cached for another', async () => {
    const { fetcher, keyWith } = setup();
    const answer = await rpc(fetcher, 'tools/list', {}, { token: await keyWith(READS) });
    expect(answer.body.result).toMatchObject({ cacheScope: 'private', ttlMs: 0 });
  });

  it('writes no audit event, since nothing was decided about a call', async () => {
    const { fetcher, keyWith, records } = setup();
    await rpc(fetcher, 'tools/list', {}, { token: await keyWith(READS) });
    expect(records.events()).toEqual([]);
  });
});

describe('a tool call', () => {
  it('returns the API\'s body as text', async () => {
    const { fetcher, keyWith } = setup();
    const answer = await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token: await keyWith(READS) });
    expect(answer.body.result?.isError).toBeUndefined();
    expect(JSON.parse(textOf(answer))).toMatchObject({ id: 'cus_1' });
  });

  it('turns a bad argument into something the model can fix, with nothing sent', async () => {
    const { api, fetcher, keyWith } = setup();
    const answer = await callTool(fetcher, 'getCustomer', { id: 'not-a-customer' }, { token: await keyWith(READS) });
    expect(answer.body.result?.isError).toBe(true);
    expect(JSON.parse(textOf(answer))).toMatchObject({ code: 'invalid_arguments', retry: 'no' });
    expect(api.requests()).toEqual([]);
  });

  it('refuses an argument the tool doesn\'t have', async () => {
    const { api, fetcher, keyWith } = setup();
    const answer = await callTool(fetcher, 'getCustomer', { id: 'cus_1', authorization: 'Bearer stolen' }, { token: await keyWith(READS) });
    expect(answer.body.result?.isError).toBe(true);
    expect(api.requests()).toEqual([]);
  });

  it('copes with no arguments at all', async () => {
    const { api, fetcher, keyWith } = setup();
    const answer = await rpc(fetcher, 'tools/call', { name: 'listCustomers' }, { token: await keyWith(READS) });
    expect(answer.body.result?.isError).toBeUndefined();
    expect(api.requests()).toHaveLength(1);
  });

  it('says something when the API answers with no content', () => {
    expect(toToolResult({ ok: true, status: 204, body: '', contentType: '', attempts: 1 }).content[0]?.text).toBe('Done. The API answered 204 with no content.');
  });

  it('never leaks an internal error\'s text', async () => {
    const { fetcher, keyWith, spans } = setup({ surface: { audit: { record: () => { throw new Error('secret detail'); }, failures: () => 0 } } });
    const answer = await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token: await keyWith(READS) });
    expect(answer.body.error?.code).toBe(-32603);
    expect(answer.body.error?.message).toContain('Something went wrong');
    expect(JSON.stringify(answer)).not.toContain('secret detail');
    expect(spans.spans().find((span) => span.kind === 'server')?.attributes['error.type']).toBe('internal_error');
  });
});

describe('C3: the agent\'s token never reaches the API', () => {
  it('sends only the configured credential, for a key', async () => {
    const { api, fetcher, keyWith } = setup();
    const token = await keyWith(READS);
    await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token });
    expect(api.requests()[0]?.headers.authorization).toBe(`Bearer ${DEFAULT_CREDENTIAL}`);
    expect(JSON.stringify(api.requests())).not.toContain(token);
  });

  it('sends only the configured credential, for a JWT', async () => {
    const issuer = await createIssuer('ES256');
    const token = await issuer.sign(goodClaims({ scope: 'read' }));
    const { api, fetcher } = setup({
      surface: {
        now: () => NOW_S * 1000,
        access: {
          fetch: () => Promise.resolve(new Response(JSON.stringify({ keys: [issuer.jwk] }))),
          jwt: { issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://login.example.test/jwks.json', resource: AUDIENCE, scopes: { read: [{ tool: 'getCustomer' }] } },
        },
      },
    });
    expect(await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token })).toMatchObject({ status: 200 });
    expect(api.requests()[0]?.headers.authorization).toBe(`Bearer ${DEFAULT_CREDENTIAL}`);
    expect(JSON.stringify(api.requests())).not.toContain(token);
  });

  it('gives the SDK no token at all', () => {
    const info = signedInInfo({ id: 'key_1', kind: 'key', grants: [] }, 3);
    expect(info.token).toBe('');
    expect(info.clientId).toBe('key_1');
  });
});

describe('C4: the stored credential never leaks', () => {
  it('stays out of the tool result, every span and the audit log when the API echoes it', async () => {
    const { fetcher, keyWith, records, spans } = setup({ fault: 'echo-auth' });
    const answer = await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token: await keyWith(READS) });
    expect(answer.status).toBe(200);
    expect(JSON.stringify(answer)).not.toContain(DEFAULT_CREDENTIAL);
    expect(JSON.stringify(spans.spans())).not.toContain(DEFAULT_CREDENTIAL);
    expect(JSON.stringify(records.events())).not.toContain(DEFAULT_CREDENTIAL);
  });
});

// The sentence the project stands on, across the whole stack.
describe('C5 and C10: a write that may have happened', () => {
  it('tells the model how to retry safely, and that retry leaves one effect', async () => {
    const { api, fetcher, keyWith } = setup({ fault: 'drop;times=3' });
    const token = await keyWith(PAYS);

    const first = await callTool(fetcher, 'createPayment', PAYMENT, { token });
    expect(first.body.result?.isError).toBe(true);
    const error = JSON.parse(textOf(first)) as { code: string; retry: string; idempotencyKey: string; message: string };
    expect(error).toMatchObject({ code: 'outcome_unknown', retry: 'same_key' });
    expect(error.message).toContain(error.idempotencyKey);
    expect(api.effects()).toHaveLength(1);

    const again = await callTool(fetcher, 'createPayment', { ...PAYMENT, idempotencyKey: error.idempotencyKey }, { token });
    expect(again.body.result?.isError).toBeUndefined();
    expect(api.effects()).toHaveLength(1);
  });

  it('gets there alone when the response is lost only once', async () => {
    const { api, fetcher, keyWith } = setup({ fault: 'drop;times=1' });
    const answer = await callTool(fetcher, 'createPayment', PAYMENT, { token: await keyWith(PAYS) });
    expect(answer.body.result?.isError).toBeUndefined();
    expect(api.effects()).toHaveLength(1);
  });

  it('says to check first for a write with no key, after one attempt', async () => {
    const { api, fetcher, keyWith } = setup({ fault: 'drop' });
    const answer = await callTool(fetcher, 'deleteCustomer', { id: 'cus_1' }, { token: await keyWith([{ tool: 'deleteCustomer', writes: true }]) });
    expect(JSON.parse(textOf(answer))).toMatchObject({ code: 'outcome_unknown', retry: 'check_first' });
    expect(api.requests()).toHaveLength(1);
  });

  it('gives every failure a retry field', async () => {
    const { fetcher, keyWith } = setup({ fault: 'status=404' });
    const answer = await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token: await keyWith(READS) });
    expect(JSON.parse(textOf(answer))).toMatchObject({ code: 'rejected', retry: 'no' });
  });
});

describe('C11: traces', () => {
  it('joins the agent\'s trace through _meta, with the right shape', async () => {
    const { fetcher, keyWith, spans } = setup();
    await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token: await keyWith(READS), traceparent: TRACEPARENT });

    const all = spans.spans();
    const server = all.find((span) => span.kind === 'server');
    expect(server).toMatchObject({
      name: 'tools/call getCustomer',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      parentSpanId: 'b7ad6b7169203331',
      attributes: { 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': 'getCustomer', 'mcp.protocol.version': '2026-07-28' },
    });
    expect(server?.attributes['crumple.caller']).toMatch(/^key_/);
    expect(typeof server?.attributes['crumple.auth_ms']).toBe('number');
    expect(typeof server?.attributes['jsonrpc.request.id']).toBe('string');
    expect(all.every((span) => span.traceId === server?.traceId)).toBe(true);

    const authorize = all.find((span) => span.name === 'authorize');
    const execute = all.find((span) => span.name === 'execute');
    expect(authorize?.parentSpanId).toBe(server?.spanId);
    expect(execute?.parentSpanId).toBe(server?.spanId);
    expect(all.some((span) => span.parentSpanId === execute?.spanId && span.name === 'GET /customers/{id}')).toBe(true);
  });

  it('starts a fresh trace when the agent sends none', async () => {
    const { fetcher, keyWith, spans } = setup();
    await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token: await keyWith(READS) });
    expect(spans.spans().find((span) => span.kind === 'server')?.parentSpanId).toBeUndefined();
  });

  // The proof in picture form.
  it('shows authorize and no execute for a refused call', async () => {
    const { fetcher, keyWith, spans } = setup();
    await callTool(fetcher, 'deleteCustomer', { id: 'cus_1' }, { token: await keyWith(READS) });
    const names = spans.spans().map((span) => span.name);
    expect(names).toContain('authorize');
    expect(names).not.toContain('execute');
    expect(spans.spans().find((span) => span.kind === 'server')?.attributes['error.type']).toBe('writes_not_allowed');
  });

  it('puts no chosen text in the span name for an unknown tool', async () => {
    const { fetcher, keyWith, spans } = setup();
    await callTool(fetcher, 'made_up_name', {}, { token: await keyWith(READS) });
    const server = spans.spans().find((span) => span.kind === 'server');
    expect(server?.name).toBe('tools/call');
    expect(server?.attributes['gen_ai.tool.name']).toBeUndefined();
    expect(server?.attributes['error.type']).toBe('no_grant');
  });

  it('marks a failed tool call as tool_error, as the conventions say', async () => {
    const { fetcher, keyWith, spans } = setup({ fault: 'status=404' });
    await callTool(fetcher, 'getCustomer', { id: 'cus_1' }, { token: await keyWith(READS) });
    expect(spans.spans().find((span) => span.kind === 'server')?.attributes['error.type']).toBe('tool_error');
  });

  it('marks bad arguments the same way', async () => {
    const { fetcher, keyWith, spans } = setup();
    await callTool(fetcher, 'getCustomer', { id: 'nope' }, { token: await keyWith(READS) });
    expect(spans.spans().find((span) => span.kind === 'server')?.attributes['error.type']).toBe('tool_error');
  });

  it('writes a span for tools/list', async () => {
    const { fetcher, keyWith, spans } = setup();
    await rpc(fetcher, 'tools/list', {}, { token: await keyWith(READS), traceparent: TRACEPARENT });
    expect(spans.spans().find((span) => span.kind === 'server')).toMatchObject({ name: 'tools/list', traceId: '0af7651916cd43dd8448eb211c80319c' });
  });

  // Telemetry's rule: arguments can't be recorded.
  it('records no argument, anywhere', async () => {
    const { fetcher, keyWith, records, spans } = setup();
    await callTool(fetcher, 'getCustomer', { id: 'cus_secret_marker' }, { token: await keyWith(READS) });
    expect(JSON.stringify([spans.spans(), records.events()])).not.toContain('secret_marker');
  });
});

describe('the rest of the wire', () => {
  const post = (fetcher: Fetcher, headers: Record<string, string>, url = 'http://crumple.test/mcp') =>
    fetcher(new Request(url, { method: 'POST', headers, body: '{}' }));

  it.each([
    ['one that isn\'t allowed', 'https://evil.test', 403],
    ['the string null, from a sandboxed page', 'null', 403],
  ])('refuses an Origin that is %s', async (_name, origin, status) => {
    const { fetcher } = setup();
    expect((await post(fetcher, { origin })).status).toBe(status);
  });

  it('checks Origin before anything else, so a browser learns nothing about keys', async () => {
    const { fetcher, keyWith } = setup();
    expect((await post(fetcher, { origin: 'https://evil.test', authorization: `Bearer ${await keyWith(READS)}` })).status).toBe(403);
  });

  it('accepts an allowed Origin, and no Origin', async () => {
    const { fetcher, keyWith } = setup({ surface: { allowedOrigins: ['https://app.test'] } });
    const token = await keyWith(READS);
    expect((await rpc(fetcher, 'tools/list', {}, { token, headers: { origin: 'https://app.test' } })).status).toBe(200);
    expect((await rpc(fetcher, 'tools/list', {}, { token })).status).toBe(200);
  });

  it('checks Host only when asked to', async () => {
    const guarded = setup({ surface: { allowedHosts: ['localhost'] } });
    expect((await post(guarded.fetcher, { host: 'evil.test' })).status).toBe(403);
    expect((await post(guarded.fetcher, { host: 'localhost:3000' })).status).toBe(401);
    expect((await post(setup().fetcher, { host: 'evil.test' })).status).toBe(401);
  });

  it('answers 404 elsewhere, without asking for a key', async () => {
    const { fetcher } = setup();
    const response = await fetcher(new Request('http://crumple.test/other'));
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('/mcp');
  });

  it('serves at another path when told to', async () => {
    const { fetcher, keyWith } = setup({ surface: { path: '/agents' } });
    const token = await keyWith(READS);
    expect((await rpc(fetcher, 'tools/list', {}, { token, url: 'http://crumple.test/agents' })).status).toBe(200);
    expect((await rpc(fetcher, 'tools/list', {}, { token })).status).toBe(404);
  });

  it('leaves GET to the SDK, which says 405', async () => {
    const { fetcher, keyWith } = setup();
    const response = await fetcher(new Request('http://crumple.test/mcp', { headers: { authorization: `Bearer ${await keyWith(READS)}` } }));
    expect(response.status).toBe(405);
  });

  it('refuses a body over 1 MiB', async () => {
    const { fetcher, keyWith } = setup();
    const response = await fetcher(new Request('http://crumple.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${await keyWith(READS)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: 'x'.repeat(1024 * 1024 + 1),
    }));
    expect(response.status).toBe(413);
  });

  it('leaves the routing header check to the SDK', async () => {
    const { fetcher, keyWith } = setup();
    const answer = await rpc(fetcher, 'tools/call', { name: 'getCustomer', arguments: { id: 'cus_1' } }, { token: await keyWith(READS), headers: { 'mcp-name': 'someOtherTool' } });
    expect(answer.body.error?.code).toBe(-32020);
  });
});

describe('Protected Resource Metadata', () => {
  const jwt = { issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://login.example.test/jwks.json', resource: AUDIENCE, scopes: { read: [{ tool: 'getCustomer' }] } };

  it('is served without signing in, when an issuer is configured', async () => {
    const { surface } = setup({ surface: { access: { jwt } } });
    const response = await surface.fetch(new Request('http://crumple.test/.well-known/oauth-protected-resource/mcp'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: AUDIENCE, authorization_servers: [ISSUER], scopes_supported: ['read'] });
  });

  it('is only for GET', async () => {
    const { surface } = setup({ surface: { access: { jwt } } });
    const response = await surface.fetch(new Request('http://crumple.test/.well-known/oauth-protected-resource/mcp', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(404);
  });

  it('is a 404 with API keys alone', async () => {
    const { surface } = setup();
    expect((await surface.fetch(new Request('http://crumple.test/.well-known/oauth-protected-resource/mcp'))).status).toBe(404);
  });

  it('points a caller with no credentials at it', async () => {
    const { surface } = setup({ surface: { access: { jwt } } });
    const response = await surface.fetch(new Request('http://crumple.test/mcp', { method: 'POST', body: '{}' }));
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"');
  });
});

describe('older clients', () => {
  it('serves the 2025 handshake, list and call', async () => {
    const { fetcher, keyWith } = setup();
    const token = await keyWith(READS);
    const hello = await legacyRpc(fetcher, 'initialize', { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'old', version: '0' } }, token);
    expect(hello.body.result).toMatchObject({ protocolVersion: LEGACY, capabilities: { tools: {} } });

    const list = await legacyRpc(fetcher, 'tools/list', {}, token);
    expect(list.body.result?.tools?.map((tool) => tool.name)).toContain('getCustomer');

    const call = await legacyRpc(fetcher, 'tools/call', { name: 'getCustomer', arguments: { id: 'cus_1' } }, token);
    expect(JSON.parse(textOf(call))).toMatchObject({ id: 'cus_1' });
  });

  it('goes through the same door', async () => {
    const { api, fetcher, keyWith, records } = setup();
    const token = await keyWith(READS);
    const refused = await legacyRpc(fetcher, 'tools/call', { name: 'deleteCustomer', arguments: { id: 'cus_1' } }, token);
    expect(refused.body.error?.code).toBe(-32602);
    expect(records.events()[0]).toMatchObject({ decision: 'deny', tool: 'deleteCustomer' });
    expect(api.requests()).toEqual([]);
  });

  it('still needs a key', async () => {
    const { fetcher } = setup();
    expect((await legacyRpc(fetcher, 'initialize', {}, 'nope')).status).toBe(401);
  });
});

describe('a schema the validator can\'t compile', () => {
  it('leaves that tool out at start and says so, and the rest still work', async () => {
    const { tools } = convertOpenApi(OPENAPI);
    const [first, ...rest] = tools;
    if (!first) throw new Error('expected a tool');
    const broken = { ...first, name: 'broken', inputSchema: { type: 'not-a-real-type', pattern: '(' } };
    const { fetcher, keyWith, surface } = setup({ tools: [broken, ...rest] });
    expect(surface.warnings.join()).toContain('broken');

    const token = await keyWith(READS);
    const names = (await rpc(fetcher, 'tools/list', {}, { token })).body.result?.tools?.map((tool) => tool.name);
    expect(names).not.toContain('broken');
    expect((await callTool(fetcher, 'broken', {}, { token })).body.error?.code).toBe(-32602);
  });
});
