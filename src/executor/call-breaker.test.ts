import { describe, expect, it } from 'vitest';
import { createFaultApi, DEFAULT_CREDENTIAL } from '../fault-api/index.js';
import { createTelemetry, memorySink } from '../telemetry/index.js';
import { fakeClock } from '../../tests/helpers/clock.js';
import { createExecutor, type ExecutorOptions, type Operation } from './index.js';

const GET_CUSTOMER: Operation = {
  name: 'get_customer',
  method: 'GET',
  path: '/customers/{id}',
  params: [{ name: 'id', arg: 'id', in: 'path' }],
  retry: 'safe',
};

const WRITE: Operation = { ...GET_CUSTOMER, name: 'delete_customer', method: 'DELETE', retry: 'never' };
const WITH_KEY: Operation = { ...GET_CUSTOMER, name: 'create', method: 'POST', path: '/customers', params: [], body: { arg: 'body', contentType: 'application/json' }, retry: 'with_key' };

function setup(options: Partial<ExecutorOptions> = {}) {
  const clock = fakeClock();
  const api = createFaultApi({ sleep: clock.sleep, now: clock.now });
  const spans = memorySink();
  const telemetry = createTelemetry({ sinks: [spans], now: clock.now, strict: true });
  let fault: string | undefined;
  const responses: ((request: Request) => Promise<Response>)[] = [];

  const executor = createExecutor({
    baseUrl: 'http://fault-api.test',
    getCredential: () => Promise.resolve({ kind: 'header', name: 'authorization', value: `Bearer ${DEFAULT_CREDENTIAL}` }),
    telemetry,
    // The fault can change during a test, because recovering is what's being tested.
    fetch: (request) => {
      const stub = responses.shift();
      if (stub) return stub(request);
      if (fault !== undefined) request.headers.set('x-fault', fault);
      return api.fetch(request);
    },
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0,
    retry: { attempts: 1 },
    ...options,
  });

  const call = (operation: Operation = GET_CUSTOMER, args: unknown = { id: 'cus_1' }) =>
    clock.run(executor.call(operation, args, { caller: 'key_1' }));
  const callMany = async (count: number, operation?: Operation) => {
    for (let i = 0; i < count; i += 1) await call(operation);
  };
  return { api, call, callMany, clock, executor, spans, responses, setFault: (next?: string) => { fault = next; } };
}

// Moves the fake clock on by finishing a sleep nobody else is waiting for.
async function pass(clock: ReturnType<typeof fakeClock>, ms: number): Promise<void> {
  await clock.run(clock.sleep(ms, new AbortController().signal));
}

// C8, counted at the far end.
describe('a failing upstream stops being hit', () => {
  it('opens after sustained failure, and then sends nothing at all', async () => {
    const { api, call, callMany, setFault } = setup();
    setFault('status=503');
    await callMany(5);
    expect(api.requests()).toHaveLength(5);

    const outcome = await call();
    expect(outcome).toMatchObject({ ok: false, attempts: 0, error: { code: 'circuit_open', retry: 'later', retryAfterMs: 30_000 } });
    await callMany(10);
    expect(api.requests()).toHaveLength(5);
  });

  it('fails fast, without waiting for anything', async () => {
    const { call, callMany, clock, setFault } = setup();
    setFault('status=503');
    await callMany(5);
    const before = clock.elapsed();
    await call();
    expect(clock.elapsed()).toBe(before);
  });

  it('counts timeouts and lost connections', async () => {
    for (const fault of ['hang', 'drop']) {
      const { api, call, callMany, setFault } = setup();
      setFault(fault);
      await callMany(5);
      expect(await call()).toMatchObject({ ok: false, error: { code: 'circuit_open' } });
      expect(api.requests()).toHaveLength(5);
    }
  });

  it('counts each attempt, so retries reach it sooner', async () => {
    const { api, call, setFault } = setup({ retry: { attempts: 3 } });
    setFault('status=503');
    await call();
    await call();
    expect(api.requests().length).toBeLessThanOrEqual(6);
    expect(await call()).toMatchObject({ ok: false, error: { code: 'circuit_open' } });
  });

  // One agent's bad arguments mustn't cut every other agent off from a healthy API.
  it.each(['status=400', 'status=404', 'status=422', 'status=429', 'status=401'])('doesn\'t count %s', async (fault) => {
    const { api, callMany, setFault } = setup();
    setFault(fault);
    await callMany(30);
    expect(api.requests()).toHaveLength(30);
  });

  it('doesn\'t count bad arguments that never left', async () => {
    const { call, callMany } = setup();
    await callMany(10);
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: true });
  });

  it('stays closed through occasional failures', async () => {
    const { call, setFault } = setup();
    for (let i = 0; i < 30; i += 1) {
      setFault(i % 4 === 0 ? 'status=503' : undefined);
      await call();
    }
    setFault(undefined);
    expect(await call()).toMatchObject({ ok: true });
  });

  it('can be configured', async () => {
    const { api, call, setFault } = setup({ breaker: { minimumCalls: 2, failureRate: 1, windowSize: 2, openMs: 1_000 } });
    setFault('status=503');
    await call();
    await call();
    expect(await call()).toMatchObject({ ok: false, error: { code: 'circuit_open', retryAfterMs: 1_000 } });
    expect(api.requests()).toHaveLength(2);
  });
});

describe('recovering by itself', () => {
  it('tests with one call after the wait, and closes when it works', async () => {
    const { api, call, callMany, clock, setFault } = setup();
    setFault('status=503');
    await callMany(5);
    expect(api.requests()).toHaveLength(5);

    setFault(undefined);
    await pass(clock, 30_000);
    expect(await call()).toMatchObject({ ok: true, attempts: 1 });
    expect(api.requests()).toHaveLength(6);

    await callMany(5);
    expect(api.requests()).toHaveLength(11);
  });

  it('goes back to waiting when the test fails', async () => {
    const { api, call, callMany, clock, setFault } = setup();
    setFault('status=503');
    await callMany(5);

    await pass(clock, 30_000);
    expect(await call()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(api.requests()).toHaveLength(6);

    expect(await call()).toMatchObject({ ok: false, error: { code: 'circuit_open', retryAfterMs: 30_000 } });
    expect(api.requests()).toHaveLength(6);
  });

  it('lets only one call test at a time, and fails the rest fast', async () => {
    const { api, callMany, clock, executor, setFault } = setup();
    setFault('status=503');
    await callMany(5);
    await pass(clock, 30_000);

    setFault('delay=100');
    const results = await clock.run(Promise.all([1, 2, 3].map(() => executor.call(GET_CUSTOMER, { id: 'cus_1' }, { caller: 'key_1' }))));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.code === 'circuit_open')).toHaveLength(2);
    expect(api.requests()).toHaveLength(6);
  });

  it('frees the test when its caller goes away, so recovery can\'t get stuck', async () => {
    const { call, callMany, clock, executor, setFault } = setup();
    setFault('status=503');
    await callMany(5);
    await pass(clock, 30_000);

    setFault('hang');
    const controller = new AbortController();
    const abandoned = executor.call(GET_CUSTOMER, { id: 'cus_1' }, { caller: 'key_1', signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('client disconnected'));
    expect(await clock.run(abandoned)).toMatchObject({ ok: false, error: { code: 'cancelled' } });

    setFault(undefined);
    expect(await call()).toMatchObject({ ok: true });
  });

  it('frees the test when there\'s no credential, so recovery can\'t get stuck', async () => {
    let usable = false;
    const { call, callMany, clock, setFault } = setup({
      getCredential: () => (usable
        ? Promise.resolve({ kind: 'header', name: 'authorization', value: `Bearer ${DEFAULT_CREDENTIAL}` })
        : Promise.reject(new Error('down'))),
    });
    usable = true;
    setFault('status=503');
    await callMany(5);
    await pass(clock, 30_000);

    usable = false;
    expect(await call()).toMatchObject({ ok: false, error: { code: 'upstream_auth' } });
    usable = true;
    setFault(undefined);
    expect(await call()).toMatchObject({ ok: true });
  });
});

describe('what the agent is told', () => {
  it('says nothing was sent, so a write is safe to try later', async () => {
    const { api, call, callMany, setFault } = setup();
    setFault('status=503');
    await callMany(5, WRITE);
    const effects = api.effects().length;
    const outcome = await call(WRITE);
    expect(outcome).toMatchObject({ ok: false, attempts: 0, error: { code: 'circuit_open', retry: 'later' } });
    expect(!outcome.ok && outcome.error.message).toContain('wasn\'t sent');
    expect(api.effects()).toHaveLength(effects);
  });

  // "Nothing was sent" would be a lie here: an earlier attempt may have applied this write.
  it('doesn\'t claim nothing was sent when it opens partway through a call', async () => {
    const { call, setFault } = setup({
      retry: { attempts: 5 },
      breaker: { minimumCalls: 2, failureRate: 1, windowSize: 2, openMs: 30_000 },
    });
    setFault('drop');
    const outcome = await call(WITH_KEY, { body: { name: 'Ada' } });
    expect(outcome).toMatchObject({ ok: false, attempts: 2, error: { code: 'outcome_unknown', retry: 'same_key' } });
  });
});

describe('the trace', () => {
  it('shows the breaker\'s state on each call', async () => {
    const { call, callMany, setFault, spans } = setup();
    await call();
    const closed = spans.spans().find((span) => span.name === 'execute');
    expect(closed?.attributes['crumple.breaker.state']).toBe('closed');

    setFault('status=503');
    await callMany(5);
    spans.clear();
    await call();
    expect(spans.spans()[0]?.attributes['crumple.breaker.state']).toBe('open');
    expect(spans.spans()[0]?.attributes['error.type']).toBe('circuit_open');
  });
});
