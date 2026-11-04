import { describe, expect, it } from 'vitest';
import { createFaultApi, DEFAULT_CREDENTIAL } from '../fault-api/index.js';
import { createTelemetry, memorySink } from '../telemetry/index.js';
import { fakeClock } from '../../tests/helpers/clock.js';
import { createExecutor, type ExecutorOptions, type Operation, type Outcome } from './index.js';

const GET_CUSTOMER: Operation = {
  name: 'get_customer',
  method: 'GET',
  path: '/customers/{id}',
  params: [{ name: 'id', arg: 'id', in: 'path' }],
  retry: 'safe',
};

function setup(fault: string, options: Partial<ExecutorOptions> = {}) {
  const clock = fakeClock();
  const api = createFaultApi({ sleep: clock.sleep, now: clock.now });
  const spans = memorySink();
  const telemetry = createTelemetry({ sinks: [spans], now: clock.now, strict: true });
  const executor = createExecutor({
    baseUrl: 'http://fault-api.test',
    getCredential: () => Promise.resolve({ kind: 'header', name: 'authorization', value: `Bearer ${DEFAULT_CREDENTIAL}` }),
    headers: { 'x-fault': fault },
    telemetry,
    fetch: (request) => api.fetch(request),
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0,
    ...options,
  });
  const start = (caller: string) => executor.call(GET_CUSTOMER, { id: 'cus_1' }, { caller });
  return { api, clock, executor, spans, start };
}

const count = (outcomes: Outcome[], code: string) => outcomes.filter((outcome) => !outcome.ok && outcome.error.code === code).length;

// C9: the claim concurrency limits exist for.
describe('one noisy caller can\'t starve another', () => {
  it('gives a second caller a normal answer while the first floods', async () => {
    const { clock, start } = setup('delay=1000', { limits: { perCaller: 10, perUpstream: 50, queuePerCaller: 20 } });

    const flood = Array.from({ length: 200 }, () => start('noisy'));
    const quiet = Array.from({ length: 5 }, () => start('quiet'));
    const [floodResults, quietResults] = await clock.run(Promise.all([Promise.all(flood), Promise.all(quiet)]));

    expect(quietResults.every((outcome) => outcome.ok)).toBe(true);
    // Refused rather than queued forever: only 10 in flight and 20 waiting could be served.
    expect(count(floodResults, 'overloaded')).toBe(170);
    expect(floodResults.filter((outcome) => outcome.ok)).toHaveLength(30);
  });

  it('never lets one caller hold more than its limit at once', async () => {
    const { clock, start, api } = setup('delay=1000', { limits: { perCaller: 2, perUpstream: 50, queuePerCaller: 2 } });
    await clock.run(Promise.all([start('a'), start('a'), start('a'), start('a'), start('a')]));

    // Two at a time means the first two arrive at the start, and the next two 1,000 ms later.
    const times = api.requests().map((record) => record.at - (api.requests()[0]?.at ?? 0));
    expect(times).toEqual([0, 0, 1_000, 1_000]);
  });

  it('refuses at once, without waiting, past the queue', async () => {
    const { clock, start } = setup('delay=1000', { limits: { perCaller: 1, perUpstream: 50, queuePerCaller: 0 } });
    const first = start('a');
    const refused = await clock.run(start('a'));
    expect(refused).toMatchObject({ ok: false, attempts: 0, error: { code: 'overloaded', retry: 'later' } });
    expect(clock.elapsed()).toBe(0);
    await clock.run(first);
  });

  it('limits the upstream as a whole, across callers', async () => {
    const { clock, start, api } = setup('delay=1000', { limits: { perCaller: 10, perUpstream: 2, queuePerCaller: 20 } });
    await clock.run(Promise.all([start('a'), start('b'), start('c'), start('d')]));
    const times = api.requests().map((record) => record.at - (api.requests()[0]?.at ?? 0));
    expect(times).toEqual([0, 0, 1_000, 1_000]);
  });

  it('tells the agent that nothing was sent', async () => {
    const { clock, start } = setup('delay=1000', { limits: { perCaller: 1, perUpstream: 50, queuePerCaller: 0 } });
    const first = start('a');
    const refused = await clock.run(start('a'));
    expect(!refused.ok && refused.error.message).toContain('wasn\'t sent');
    await clock.run(first);
  });
});

describe('the deadline covers the queue', () => {
  it('gives up on a call that waits too long, with nothing sent', async () => {
    const { api, clock, start } = setup('delay=9000', {
      deadlineMs: 5_000,
      attemptTimeoutMs: 60_000,
      limits: { perCaller: 1, perUpstream: 50, queuePerCaller: 5 },
    });
    const results = await clock.run(Promise.all([start('a'), start('a')]));
    expect(results[1]).toMatchObject({ ok: false, attempts: 0, error: { code: 'overloaded', retry: 'later' } });
    expect(api.requests()).toHaveLength(1);
    expect(clock.elapsed()).toBe(5_000);
  });

  it('counts time in the queue against the deadline', async () => {
    const { clock, start } = setup('delay=3000', {
      deadlineMs: 5_000,
      attemptTimeoutMs: 60_000,
      retry: { attempts: 1 },
      limits: { perCaller: 1, perUpstream: 50, queuePerCaller: 5 },
    });
    const results = await clock.run(Promise.all([start('a'), start('a')]));
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(clock.elapsed()).toBe(5_000);
  });

  it('stops waiting when the caller goes away', async () => {
    const { clock, executor, start } = setup('delay=1000', { limits: { perCaller: 1, perUpstream: 50, queuePerCaller: 5 } });
    const first = start('a');
    const controller = new AbortController();
    const second = executor.call(GET_CUSTOMER, { id: 'cus_1' }, { caller: 'a', signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('client disconnected'));
    expect(await clock.run(second)).toMatchObject({ ok: false, attempts: 0, error: { code: 'cancelled' } });
    await clock.run(first);
  });
});

describe('slots', () => {
  // Releasing them would let more work in exactly while the upstream is struggling.
  it('are kept during backoff', async () => {
    const { clock, start, api } = setup('status=503;times=2', {
      retry: { attempts: 3, baseMs: 1_000, capMs: 1_000 },
      random: () => 1,
      limits: { perCaller: 1, perUpstream: 50, queuePerCaller: 5 },
    });
    await clock.run(Promise.all([start('a'), start('a')]));
    // Three attempts for the first call, all before the second call's only attempt.
    expect(api.requests().map((record) => record.at - (api.requests()[0]?.at ?? 0))).toEqual([0, 1_000, 2_000, 2_000]);
  });

  it('are given back after every kind of ending, or the server would slowly lock up', async () => {
    const { clock, executor } = setup('status=400', { limits: { perCaller: 1, perUpstream: 1, queuePerCaller: 0 } });
    const call = (args: unknown) => clock.run(executor.call(GET_CUSTOMER, args, { caller: 'a' }));
    expect(await call({ id: 'cus_1' })).toMatchObject({ ok: false, error: { code: 'rejected' } });
    expect(await call({})).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(await call({ id: 'cus_1' })).toMatchObject({ ok: false, error: { code: 'rejected' } });
  });

  it('aren\'t used by a call with bad arguments, which costs nothing', async () => {
    const { clock, executor, start } = setup('delay=1000', { limits: { perCaller: 1, perUpstream: 50, queuePerCaller: 0 } });
    const holding = start('a');
    expect(await clock.run(executor.call(GET_CUSTOMER, {}, { caller: 'a' }))).toMatchObject({ error: { code: 'invalid_arguments' } });
    await clock.run(holding);
  });
});

describe('the trace', () => {
  it('shows time spent in the queue', async () => {
    const { clock, spans, start } = setup('delay=1000', { limits: { perCaller: 1, perUpstream: 50, queuePerCaller: 5 } });
    await clock.run(Promise.all([start('a'), start('a')]));
    const executes = spans.spans().filter((span) => span.name === 'execute');
    expect(executes.map((span) => span.attributes['crumple.queue_ms']).sort()).toEqual([0, 1_000]);
  });
});
