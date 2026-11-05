import { afterEach, describe, expect, it } from 'vitest';
import { recordingServer, type RecordingOptions, type RecordingServer, SOME_TOOLS } from '../../tests/helpers/recording-server.js';
import { callResult, createBudget, createHttpTransport, LEGACY_VERSION, MAX_RESPONSE_BYTES, MODERN_VERSION, openSession, type HttpTransport } from './client.js';

const servers: RecordingServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function setup(options: RecordingOptions = {}, transportOptions: { max?: number; token?: string; timeoutMs?: number } = {}): Promise<{ server: RecordingServer; transport: HttpTransport }> {
  const server = await recordingServer(options);
  servers.push(server);
  const { max, token, timeoutMs = 2_000 } = transportOptions;
  return { server, transport: createHttpTransport({ url: server.url, timeoutMs, budget: createBudget(max), ...(token ? { token } : {}) }) };
}

async function open(options: RecordingOptions = {}, transportOptions: { max?: number; token?: string; timeoutMs?: number } = {}) {
  const { server, transport } = await setup(options, transportOptions);
  const opened = await openSession(transport);
  if (!opened.ok) throw new Error(`It didn't open: ${opened.reason}`);
  return { server, transport, session: opened.session };
}

describe('a call\'s _meta', () => {
  const bodies: { params?: { _meta?: Record<string, unknown> } }[] = [];
  const capturing: typeof fetch = (input, init) => {
    if (typeof init?.body === 'string' && init.body !== '') bodies.push(JSON.parse(init.body) as (typeof bodies)[number]);
    return fetch(input, init);
  };
  const meta = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' };

  async function lastCall(options: RecordingOptions) {
    bodies.length = 0;
    const server = await recordingServer(options);
    servers.push(server);
    const opened = await openSession(createHttpTransport({ url: server.url, timeoutMs: 2_000, budget: createBudget(), fetch: capturing }));
    if (!opened.ok) throw new Error(opened.reason);
    await opened.session.callTool('getThing', { id: '1' }, {}, meta);
    return bodies.at(-1)?.params?._meta;
  }

  it('sits beside what 2026-07-28 needs there, and replaces none of it', async () => {
    expect(await lastCall({})).toMatchObject({ ...meta, 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION });
  });

  it('goes out on the older protocol too', async () => {
    expect(await lastCall({ era: 'legacy' })).toEqual(meta);
  });

  it('says who\'s calling when told', async () => {
    const server = await recordingServer({});
    servers.push(server);
    const opened = await openSession(createHttpTransport({ url: server.url, timeoutMs: 2_000, budget: createBudget(), userAgent: 'crumple-mcp-agent' }), { clientName: 'crumple-mcp-agent' });
    expect(opened.ok).toBe(true);
    expect(server.calls[0]?.headers['user-agent']).toBe('crumple-mcp-agent');
  });
});

describe('the two eras of MCP', () => {
  it('speaks 2026-07-28 with no handshake, and reuses the first answer', async () => {
    const { server, session } = await open();
    expect(session.protocol).toBe(MODERN_VERSION);
    const { tools, incomplete } = await session.listTools(10);
    expect(tools.map((tool) => tool.name)).toEqual(SOME_TOOLS.map((tool) => tool.name));
    expect(incomplete).toBe(false);
    expect(server.calls).toHaveLength(1);

    const [call] = server.calls;
    expect(call?.headers['mcp-protocol-version']).toBe(MODERN_VERSION);
    expect(call?.headers['mcp-method']).toBe('tools/list');
    expect(call?.headers['user-agent']).toBe('crumple-mcp-prove');
    expect(JSON.parse(call?.rawBody ?? '{}')).toMatchObject({ params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION } } });
  });

  it('falls back to initialize for an older server, and keeps its session', async () => {
    const { server, session } = await open({ era: 'legacy', requireSession: true });
    expect(session.protocol).toBe(LEGACY_VERSION);
    const { tools } = await session.listTools(10);
    expect(tools).toHaveLength(SOME_TOOLS.length);

    const last = server.calls.at(-1);
    expect(last?.headers['mcp-session-id']).toBe('session-1');
    expect(last?.headers['mcp-protocol-version']).toBe(LEGACY_VERSION);
    expect(server.calls.map((call) => call.method)).toEqual(['tools/list', 'initialize', 'notifications/initialized', 'tools/list']);

    await session.close();
    expect(server.calls.at(-1)?.httpMethod).toBe('DELETE');
  });

  it('reads an answer from a stream that stays open afterwards', async () => {
    const { session } = await open({ streaming: true }, { timeoutMs: 500 });
    expect((await session.listTools(1)).tools).toHaveLength(SOME_TOOLS.length);
  });

  it('reads a streamed answer from an older server', async () => {
    const { session } = await open({ era: 'legacy', streaming: true }, { timeoutMs: 500 });
    expect(session.protocol).toBe(LEGACY_VERSION);
    expect((await session.listTools(1)).tools).toHaveLength(SOME_TOOLS.length);
  });

  it('asks a lenient older server which version it speaks, rather than assume', async () => {
    const { session } = await open({
      era: 'legacy',
      // Answers a 2026-07-28 request happily, with no resultType.
      override: (call, request) =>
        call.method === 'tools/list' && request.headers.get('mcp-protocol-version') === MODERN_VERSION
          ? new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), { headers: { 'content-type': 'application/json' } })
          : undefined,
    });
    expect(session.protocol).toBe(LEGACY_VERSION);
  });

  it('says clearly when it isn\'t MCP at all', async () => {
    const { transport } = await setup({ override: () => new Response('<h1>Hello</h1>', { status: 404 }) });
    expect(await openSession(transport)).toMatchObject({ ok: false, reason: 'not_mcp', status: 404 });
  });

  it('reports a sign-in wall, and whether it says how to sign in', async () => {
    const { transport } = await setup({ requireToken: 'right' });
    expect(await openSession(transport)).toEqual({ ok: false, reason: 'auth_required', status: 401, challenge: true });
  });
});

describe('a server that isn\'t trustworthy', () => {
  it('never follows a redirect, which would carry the token away', async () => {
    let stolen = false;
    const elsewhere = await recordingServer({ override: () => { stolen = true; return undefined; } });
    servers.push(elsewhere);
    const { transport } = await setup({ override: () => new Response(null, { status: 307, headers: { location: elsewhere.url } }) }, { token: 'secret' });

    expect(await openSession(transport)).toEqual({ ok: false, reason: 'redirected', status: 307 });
    expect(stolen).toBe(false);
  });

  it('gives up on a server that hangs', async () => {
    const { transport } = await setup({ override: () => new Promise<Response>(() => undefined) }, { timeoutMs: 50 });
    const reply = await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(reply.kind).toBe('timeout');
  });

  it('gives up on a body that stalls halfway', async () => {
    const { transport } = await setup({
      override: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); } }), { headers: { 'content-type': 'application/json' } }),
    }, { timeoutMs: 50 });
    expect((await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).kind).toBe('timeout');
  });

  it('stops reading a reply that\'s too large', async () => {
    const chunk = new Uint8Array(64 * 1024);
    const { transport } = await setup({
      // Never ends, so this only finishes if the client stops by itself.
      override: () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(chunk); } }), { headers: { 'content-type': 'application/json' } }),
    });
    expect((await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).kind).toBe('too_large');
    expect(MAX_RESPONSE_BYTES).toBe(1024 * 1024);
  });

  it('calls a 200 that isn\'t JSON broken', async () => {
    const { transport } = await setup({ override: () => new Response('<html>', { status: 200 }) });
    expect((await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).kind).toBe('broken');
  });

  it('calls a stream that ends with no answer broken', async () => {
    const { transport } = await setup({ override: () => new Response('event: message\ndata: {"id":99,"result":{}}\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
    expect((await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).kind).toBe('broken');
  });

  it('keeps the status of an HTML error page', async () => {
    const { transport } = await setup({ override: () => new Response('<h1>502</h1>', { status: 502 }) });
    expect(await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toMatchObject({ kind: 'answered', status: 502 });
  });

  it('reports a server nobody is listening on', async () => {
    const transport = createHttpTransport({ url: 'http://127.0.0.1:1/mcp', timeoutMs: 1_000, budget: createBudget() });
    expect(await openSession(transport)).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('stops at the page limit when pages never end', async () => {
    const { server, session } = await open({ endlessPages: true });
    const { incomplete } = await session.listTools(10);
    expect(incomplete).toBe(true);
    expect(server.calls.filter((call) => call.method === 'tools/list')).toHaveLength(10);
  });

  it('ignores tools with no name', async () => {
    const { session } = await open({ tools: [{ name: 'real' }, { description: 'nameless' } as never, 'text' as never] });
    expect((await session.listTools(1)).tools.map((tool) => tool.name)).toEqual(['real']);
  });
});

describe('the budget', () => {
  it('sends nothing once it runs out', async () => {
    const { server, transport } = await setup({}, { max: 1 });
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).toEqual({ kind: 'budget', ms: 0 });
    await transport.sendRaw('{');
    expect(server.calls).toHaveLength(1);
  });

  it('counts the whole handshake', async () => {
    const budget = createBudget(10);
    const server = await recordingServer({ era: 'legacy', requireSession: true });
    servers.push(server);
    await openSession(createHttpTransport({ url: server.url, timeoutMs: 1_000, budget }));
    expect(budget.used()).toBe(server.calls.length);
    expect(budget.used()).toBe(3);
  });

  it('stops listing when it runs out partway', async () => {
    const { session } = await open({ endlessPages: true }, { max: 3 });
    expect((await session.listTools(10)).incomplete).toBe(true);
  });

  it('fails to open with none at all', async () => {
    const { transport } = await setup({}, { max: 0 });
    expect(await openSession(transport)).toEqual({ ok: false, reason: 'budget' });
  });
});

describe('tokens and headers', () => {
  it('sends the token, or none, or another one, when a check asks', async () => {
    const { server, transport } = await setup({}, { token: 'mine' });
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    await transport.send(message);
    await transport.send(message, { token: null });
    await transport.send(message, { token: 'wrong' });
    expect(server.calls.map((call) => call.headers.authorization)).toEqual(['Bearer mine', undefined, 'Bearer wrong']);
  });

  it('carries a name that isn\'t safe in a header the way the spec says', async () => {
    const { server, session } = await open({ tools: [{ name: 'café' }] });
    await session.callTool('café', {});
    expect(server.calls.at(-1)?.headers['mcp-name']).toBe(`=?base64?${Buffer.from('café').toString('base64')}?=`);
    await session.callTool('plain', {});
    expect(server.calls.at(-1)?.headers['mcp-name']).toBe('plain');
    await session.callTool('=?base64?abc?=', {});
    expect(server.calls.at(-1)?.headers['mcp-name']).toMatch(/^=\?base64\?PT9i/);
  });
});

describe('callResult', () => {
  const answered = (message: unknown, status = 200) => ({ kind: 'answered' as const, status, headers: new Headers(), ms: 1, message: message as never });

  it.each([
    ['a result', answered({ result: { content: [{ type: 'text', text: 'hi' }, { type: 'image' }] } }), { kind: 'result', text: 'hi\n', isError: false }],
    ['a tool error', answered({ result: { content: [{ type: 'text', text: 'no' }], isError: true } }), { kind: 'result', isError: true }],
    ['a result with no content', answered({ result: {} }), { kind: 'result', text: '' }],
    ['a protocol error', answered({ error: { code: -32602 } }), { kind: 'protocol_error', code: -32602 }],
    ['a 500', answered(undefined, 500), { kind: 'http_error', status: 500 }],
    ['a 200 with nothing useful', answered({}), { kind: 'http_error', status: 200 }],
    ['a timeout', { kind: 'timeout' as const, ms: 5 }, { kind: 'no_answer', why: 'timeout' }],
  ])('reads %s', (_name, reply, expected) => {
    expect(callResult(reply)).toMatchObject(expected);
  });
});
