import { describe, expect, it } from 'vitest';
import { createFaultApi, DEFAULT_CREDENTIAL } from '../fault-api/index.js';
import { serveOnNode } from '../node.js';
import { createTelemetry, memorySink } from '../telemetry/index.js';
import { fakeClock } from '../../tests/helpers/clock.js';
import { createExecutor, type ExecutorOptions, type Operation } from './index.js';

const GET_CUSTOMER: Operation = {
  name: 'get_customer',
  method: 'GET',
  path: '/customers/{id}',
  params: [{ name: 'id', arg: 'id', in: 'path' }],
  retry: 'safe',
  expectsJson: true,
};

const DELETE_CUSTOMER: Operation = { ...GET_CUSTOMER, name: 'delete_customer', method: 'DELETE', retry: 'never' };

const CREDENTIAL = { kind: 'header', name: 'authorization', value: `Bearer ${DEFAULT_CREDENTIAL}` } as const;

function setup(options: Partial<ExecutorOptions> = {}, fault?: string) {
  const clock = fakeClock();
  const api = createFaultApi({ sleep: clock.sleep, now: clock.now });
  const spans = memorySink();
  const telemetry = createTelemetry({ sinks: [spans], now: clock.now, strict: true });
  const executor = createExecutor({
    baseUrl: 'http://fault-api.test',
    getCredential: () => Promise.resolve(CREDENTIAL),
    telemetry,
    fetch: (request) => api.fetch(request),
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    ...(fault === undefined ? {} : { headers: { 'x-fault': fault } }),
    ...options,
  });
  const call = (operation: Operation, args: unknown, context = {}) =>
    clock.run(executor.call(operation, args, { caller: 'key_1', ...context }));
  return { api, call, clock, executor, spans, telemetry };
}

describe('a successful call', () => {
  it('returns what the API said', async () => {
    const { call } = setup();
    const outcome = await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe(200);
    expect(outcome.contentType).toContain('application/json');
    expect(JSON.parse(outcome.body)).toMatchObject({ id: 'cus_1' });
    expect(outcome.attempts).toBe(1);
  });

  it('describes a body that isn\'t text, rather than passing bytes to a model', async () => {
    const png = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    const { call } = setup({ fetch: () => Promise.resolve(png) });
    const outcome = await call({ ...GET_CUSTOMER, expectsJson: false }, { id: 'x' });
    expect(outcome.ok && outcome.body).toBe('The API answered 200 with 3 bytes of image/png, which isn\'t text.');
  });

  it('handles a response with no body', async () => {
    const { call } = setup({ fetch: () => Promise.resolve(new Response(null, { status: 204 })) });
    const outcome = await call(DELETE_CUSTOMER, { id: 'cus_1' });
    expect(outcome.ok && outcome.body).toBe('');
  });

  it('accepts text where the operation didn\'t promise JSON', async () => {
    const { call } = setup({}, 'not-json');
    const outcome = await call({ ...GET_CUSTOMER, expectsJson: false }, { id: 'cus_1' });
    expect(outcome.ok).toBe(true);
  });
});

describe('failures that come back as a result', () => {
  it('refuses bad arguments without reaching the API', async () => {
    const { api, call } = setup();
    const outcome = await call(GET_CUSTOMER, {});
    expect(outcome).toMatchObject({ ok: false, attempts: 0, error: { code: 'invalid_arguments', retry: 'no' } });
    expect(!outcome.ok && outcome.error.message).toContain('arguments.id');
    expect(api.requests()).toEqual([]);
  });

  it('refuses arguments that can\'t be turned into JSON', async () => {
    const create: Operation = { ...DELETE_CUSTOMER, method: 'POST', path: '/customers', params: [], body: { arg: 'body', contentType: 'application/json' } };
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const { api, call } = setup();
    expect(await call(create, { body: circular })).toMatchObject({ ok: false, attempts: 0, error: { code: 'invalid_arguments' } });
    expect(api.requests()).toEqual([]);
  });

  it('passes on a 4xx\'s explanation, so the agent can fix the call', async () => {
    const { call } = setup();
    const outcome = await call(GET_CUSTOMER, { id: 'cus_404' });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'rejected', retry: 'no' } });
    expect(!outcome.ok && outcome.error.detail).toContain('There is no customer');
  });

  it('caps a 4xx\'s explanation', async () => {
    const big = new Response('x'.repeat(10_000), { status: 400 });
    const { call } = setup({ fetch: () => Promise.resolve(big) });
    const outcome = await call(GET_CUSTOMER, { id: 'x' });
    expect(!outcome.ok && outcome.error.detail).toHaveLength(2048);
  });

  it('leaves out an explanation that\'s empty', async () => {
    const { call } = setup({ fetch: () => Promise.resolve(new Response('', { status: 400 })) });
    const outcome = await call(GET_CUSTOMER, { id: 'x' });
    expect(!outcome.ok && 'detail' in outcome.error).toBe(false);
  });

  it('doesn\'t pass on a 5xx body, which tends to be a stack trace', async () => {
    const trace = new Response('at Database.query (db.js:42)', { status: 500 });
    const { call } = setup({ fetch: () => Promise.resolve(trace.clone()) });
    const outcome = await call(GET_CUSTOMER, { id: 'x' });
    expect(JSON.stringify(outcome)).not.toContain('db.js');
  });

  it('tells the agent it can\'t fix a credential the API refused', async () => {
    const { call } = setup({ getCredential: () => Promise.resolve({ ...CREDENTIAL, value: 'Bearer wrong' }) });
    const outcome = await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'upstream_auth', retry: 'no' } });
    expect(!outcome.ok && outcome.error.message).toContain('operator');
  });

  it('says so when there\'s no usable credential, without sending anything', async () => {
    const { api, call } = setup({ getCredential: () => Promise.reject(new Error('the key vault is down: secret-detail')) });
    const outcome = await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'upstream_auth', retry: 'no' } });
    expect(JSON.stringify(outcome)).not.toContain('secret-detail');
    expect(api.requests()).toEqual([]);
  });

  it('doesn\'t send with a malformed credential', async () => {
    const { api, call } = setup({ getCredential: () => Promise.resolve({ ...CREDENTIAL, value: 'a\nb' }) });
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: false, error: { code: 'upstream_auth' } });
    expect(api.requests()).toEqual([]);
  });

  it('refuses to follow a redirect', async () => {
    const redirect = new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    const { call } = setup({ fetch: () => Promise.resolve(redirect) });
    expect(await call(GET_CUSTOMER, { id: 'x' })).toMatchObject({ ok: false, attempts: 1, error: { code: 'redirected', retry: 'no' } });
  });

  it('notices HTML where JSON was promised', async () => {
    const { call } = setup({}, 'not-json');
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
  });

  it('refuses a body over the cap, and stops reading it', async () => {
    const { call } = setup({}, 'large=2000000');
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: false, error: { code: 'response_too_large', retry: 'no' } });
  });

  it('reports a lost connection without its message, which can contain the URL', async () => {
    const lost = () => Promise.reject(new Error('fetch failed: https://api.example.com/?api_key=s3cret'));
    const { call } = setup({ fetch: lost, retry: { attempts: 1 } });
    const outcome = await call(GET_CUSTOMER, { id: 'x' });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'unavailable', retry: 'later' } });
    expect(JSON.stringify(outcome)).not.toContain('s3cret');
  });
});

// C6, the claim a hanging upstream tests.
describe('deadlines', () => {
  it('stops a call that hangs waiting for headers, and cancels the upstream request', async () => {
    const { api, call, clock } = setup({ retry: { attempts: 1 }, attemptTimeoutMs: 60_000, deadlineMs: 5_000 }, 'hang');
    const outcome = await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(outcome).toMatchObject({ ok: false, attempts: 1, error: { code: 'timeout', retry: 'later' } });
    expect(clock.elapsed()).toBe(5_000);
    expect(api.requests()[0]?.outcome).toBe('abandoned');
  });

  // The classic bug: a timeout that stops at the headers never fires here.
  it('stops a call whose body stalls partway', async () => {
    const { api, call, clock } = setup({ retry: { attempts: 1 }, attemptTimeoutMs: 60_000, deadlineMs: 5_000 }, 'stall-body');
    const outcome = await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(clock.elapsed()).toBe(5_000);
    expect(api.requests()[0]?.outcome).toBe('abandoned');
  });

  it('gives each attempt its own limit, so one hang can\'t spend the whole budget', async () => {
    const { call, clock } = setup({ retry: { attempts: 1 }, attemptTimeoutMs: 1_000, deadlineMs: 5_000 }, 'hang');
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(clock.elapsed()).toBe(1_000);
  });

  it('defaults to a 10-second attempt inside a 30-second deadline', async () => {
    const { call, clock } = setup({ retry: { attempts: 1 } }, 'hang');
    await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(clock.elapsed()).toBe(10_000);
  });

  it('holds even if the upstream library ignores cancellation', async () => {
    const deaf = () => new Promise<Response>(() => undefined);
    const { call, clock } = setup({ fetch: deaf, retry: { attempts: 1 }, attemptTimeoutMs: 60_000, deadlineMs: 5_000 });
    expect(await call(GET_CUSTOMER, { id: 'x' })).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(clock.elapsed()).toBe(5_000);
  });

  it('holds even if a body ignores cancellation', async () => {
    const deafBody = new ReadableStream({ pull: () => new Promise(() => undefined) });
    const { call, clock } = setup({
      fetch: () => Promise.resolve(new Response(deafBody)),
      retry: { attempts: 1 },
      attemptTimeoutMs: 60_000,
      deadlineMs: 5_000,
    });
    expect(await call(GET_CUSTOMER, { id: 'x' })).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(clock.elapsed()).toBe(5_000);
  });

  it('leaves no timers running after a call', async () => {
    const { call, clock } = setup();
    await call(GET_CUSTOMER, { id: 'cus_1' });
    // run() would have jumped to a leftover timer, moving the clock on.
    expect(clock.elapsed()).toBe(0);
  });

  it('tells the agent a write may have happened, when it times out', async () => {
    const { api, call } = setup({ retry: { attempts: 1 } }, 'hang');
    expect(await call(DELETE_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: false, error: { code: 'outcome_unknown', retry: 'check_first' } });
    expect(api.requests()[0]?.outcome).toBe('abandoned');
  });
});

describe('a lost response', () => {
  // C5: the write happened, and nothing can prove it from here.
  it('on a write with no key, says the outcome is unknown and doesn\'t retry', async () => {
    const { api, call } = setup({}, 'drop');
    const outcome = await call(DELETE_CUSTOMER, { id: 'cus_1' });
    expect(outcome).toMatchObject({ ok: false, attempts: 1, error: { code: 'outcome_unknown', retry: 'check_first' } });
    expect(api.effects()).toHaveLength(1);
    expect(api.requests()).toHaveLength(1);
  });

  // fault-api's drop always sends headers first, so this needs a stub. It's the limit named in
  // SPEC-fault-api.md: a connection lost before any headers looks different to a caller.
  it('before any headers, means the same thing', async () => {
    const { call } = setup({ fetch: () => Promise.reject(new TypeError('fetch failed')) });
    expect(await call(DELETE_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: false, error: { code: 'outcome_unknown' } });
  });
});

describe('when the caller goes away', () => {
  it('while the credential is being fetched, nothing is sent', async () => {
    const controller = new AbortController();
    const { api, clock, executor } = setup({ getCredential: () => new Promise(() => undefined) });
    const pending = executor.call(GET_CUSTOMER, { id: 'cus_1' }, { caller: 'key_1', signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('client disconnected'));
    expect(await clock.run(pending)).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(api.requests()).toEqual([]);
  });

  it('stops at once, and cancels the upstream request', async () => {
    const { api, clock, executor } = setup({}, 'hang');
    const controller = new AbortController();
    const pending = executor.call(GET_CUSTOMER, { id: 'cus_1' }, { caller: 'key_1', signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('client disconnected'));
    expect(await clock.run(pending)).toMatchObject({ ok: false, error: { code: 'cancelled', retry: 'no' } });
    expect(api.requests()[0]?.outcome).toBe('abandoned');
    expect(clock.elapsed()).toBe(0);
  });
});

// C3 and C4, checked at the far end, which is the only place that can prove them.
describe('credentials', () => {
  it('sends the configured credential, and nothing of the agent\'s', async () => {
    const { api, call } = setup();
    await call(GET_CUSTOMER, { id: 'cus_1' }, { caller: 'agent-token-abc' });
    const [record] = api.requests();
    expect(record?.headers['authorization']).toBe(`Bearer ${DEFAULT_CREDENTIAL}`);
    expect(JSON.stringify(record)).not.toContain('agent-token-abc');
  });

  it('removes a credential the API echoes in a success', async () => {
    const { call } = setup({}, 'echo-auth');
    const outcome = await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(DEFAULT_CREDENTIAL);
    expect(JSON.stringify(outcome)).toContain('[credential]');
  });

  it('removes a credential the API echoes in an error', async () => {
    const { call } = setup({ retry: { attempts: 1 } }, 'status=400;echo-auth');
    const outcome = await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(DEFAULT_CREDENTIAL);
  });

  it('removes the token alone, when an API echoes it without its scheme', async () => {
    const { call } = setup({
      getCredential: () => Promise.resolve({ kind: 'header', name: 'authorization', value: 'Bearer abc-token' }),
      fetch: () => Promise.resolve(new Response('sent: Bearer abc-token, token: abc-token')),
    });
    const outcome = await call({ ...GET_CUSTOMER, expectsJson: false }, { id: 'x' });
    expect(outcome.ok && outcome.body).toBe('sent: [credential], token: [credential]');
  });

  it('removes URL-encoded forms too', async () => {
    const value = 'secret value/with+symbols';
    const body = `a ${encodeURIComponent(value)} b ${new URLSearchParams({ v: value }).toString().slice(2)} c`;
    const { call } = setup({
      getCredential: () => Promise.resolve({ kind: 'header', name: 'x-key', value }),
      fetch: () => Promise.resolve(new Response(body)),
    });
    const outcome = await call({ ...GET_CUSTOMER, expectsJson: false }, { id: 'x' });
    expect(outcome.ok && outcome.body).toBe('a [credential] b [credential] c');
  });

  // Reading only 2 KB could cut a credential in half, and half a credential wouldn't match.
  it('removes a credential that straddles the cap on an explanation', async () => {
    const value = 'fake-credential-that-is-rather-long';
    const body = `${'x'.repeat(2048 - 10)}${value} and more text`;
    const { call } = setup({
      getCredential: () => Promise.resolve({ kind: 'header', name: 'x-key', value }),
      fetch: () => Promise.resolve(new Response(body, { status: 400 })),
    });
    const outcome = await call(GET_CUSTOMER, { id: 'x' });
    expect(!outcome.ok && outcome.error.detail).not.toContain(value.slice(0, 10));
  });

  it('leaves a very short credential alone, because replacing it would wreck the text', async () => {
    const { call } = setup({
      getCredential: () => Promise.resolve({ kind: 'header', name: 'x-key', value: 'abc' }),
      fetch: () => Promise.resolve(new Response('abcdef')),
    });
    const outcome = await call({ ...GET_CUSTOMER, expectsJson: false }, { id: 'x' });
    expect(outcome.ok && outcome.body).toBe('abcdef');
  });

  it('works for an API with no credential', async () => {
    const { call } = setup({
      getCredential: () => Promise.resolve({ kind: 'none' }),
      fetch: () => Promise.resolve(new Response('fine')),
    });
    expect(await call({ ...GET_CUSTOMER, expectsJson: false }, { id: 'x' })).toMatchObject({ ok: true });
  });

  it('keeps the credential out of every span, even when the API echoes it', async () => {
    const { call, spans } = setup({}, 'status=400;echo-auth');
    await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(spans.spans().length).toBeGreaterThan(0);
    expect(JSON.stringify(spans.spans())).not.toContain(DEFAULT_CREDENTIAL);
  });

  it('registers the credential with telemetry, so nothing else can record it', async () => {
    const { call, telemetry } = setup();
    await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(telemetry.clean(`x ${DEFAULT_CREDENTIAL}`)).toBe('[redacted]');
  });
});

// C11: what a trace shows about a call.
describe('the trace', () => {
  it('has one span for the call and one for each attempt', async () => {
    const { call, spans, clock } = setup();
    const outcome = await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(outcome.ok).toBe(true);

    const [attempt, execute] = spans.spans();
    expect(execute?.name).toBe('execute');
    expect(execute?.attributes['crumple.deadline_ms']).toBe(30_000);
    expect(attempt?.name).toBe('GET /customers/{id}');
    expect(attempt?.kind).toBe('client');
    expect(attempt?.parentSpanId).toBe(execute?.spanId);
    expect(attempt?.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      'url.template': '/customers/{id}',
      'server.address': 'fault-api.test',
    });
    expect(clock.elapsed()).toBe(0);
  });

  it('never records the real URL, because a path can name a customer', async () => {
    const { call, spans } = setup();
    await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(JSON.stringify(spans.spans())).not.toContain('cus_1');
  });

  it('marks a failed attempt and a failed call', async () => {
    const { call, spans } = setup({ retry: { attempts: 1 } }, 'status=503');
    await call(GET_CUSTOMER, { id: 'cus_1' });
    const [attempt, execute] = spans.spans();
    expect(attempt?.attributes['error.type']).toBe('503');
    expect(execute?.attributes['error.type']).toBe('unavailable');
  });

  it.each([
    ['a timeout', 'hang', 'timeout'],
    ['a lost connection', 'drop', 'connection_lost'],
  ])('names %s on the attempt', async (_name, fault, errorType) => {
    const { call, spans } = setup({ retry: { attempts: 1 } }, fault);
    await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(spans.spans()[0]?.attributes['error.type']).toBe(errorType);
  });

  it('continues the caller\'s trace', async () => {
    const { call, spans, telemetry } = setup();
    const server = telemetry.startSpan('tools/call get_customer', { kind: 'server' });
    await call(GET_CUSTOMER, { id: 'cus_1' }, { parentSpan: server });
    expect(spans.spans()[1]?.parentSpanId).toBe(server.context.spanId);
    expect(spans.spans()[0]?.traceId).toBe(server.context.traceId);
  });

  it('sends traceparent upstream, so the API\'s own traces can join in', async () => {
    const { api, call, spans } = setup();
    await call(GET_CUSTOMER, { id: 'cus_1' });
    const [attempt] = spans.spans();
    expect(api.requests()[0]?.headers['traceparent']).toContain(attempt?.traceId);
    expect(api.requests()[0]?.headers['traceparent']).toContain(attempt?.spanId);
  });

  it('can leave traceparent out', async () => {
    const { api, call } = setup({ sendTraceparent: false });
    await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(api.requests()[0]?.headers['traceparent']).toBeUndefined();
  });

  it('records a call with bad arguments too', async () => {
    const { call, spans } = setup();
    await call(GET_CUSTOMER, {});
    expect(spans.spans()[0]?.attributes['error.type']).toBe('invalid_arguments');
  });
});

describe('configuration', () => {
  it('refuses a base URL it can\'t use, when it\'s created rather than at the first call', () => {
    expect(() => createExecutor({
      baseUrl: 'not a url',
      getCredential: () => Promise.resolve({ kind: 'none' }),
      telemetry: createTelemetry(),
    })).toThrow('base URL');
  });

  it('uses real time and the real fetch unless told otherwise', async () => {
    const server = await serveOnNode(() => Promise.resolve(new Response('real')));
    const executor = createExecutor({
      baseUrl: server.url,
      getCredential: () => Promise.resolve({ kind: 'none' }),
      telemetry: createTelemetry(),
    });
    const outcome = await executor.call({ ...GET_CUSTOMER, expectsJson: false }, { id: 'x' }, { caller: 'key_1' });
    await server.close();
    expect(outcome.ok && outcome.body).toBe('real');
  });
});
