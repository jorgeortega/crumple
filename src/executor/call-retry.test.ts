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
  expectsJson: true,
};

const CREATE_PAYMENT: Operation = {
  name: 'create_payment',
  method: 'POST',
  path: '/payments',
  params: [{ name: 'Idempotency-Key', arg: 'idempotencyKey', in: 'header' }],
  body: { arg: 'body', contentType: 'application/json' },
  retry: 'with_key',
  expectsJson: true,
};

const UNSAFE_PAYMENT: Operation = { ...CREATE_PAYMENT, retry: 'never', params: [] };
const CHARGE = { body: { customerId: 'cus_1', amountCents: 5000 } };

function setup(fault: string | undefined, options: Partial<ExecutorOptions> = {}) {
  const clock = fakeClock();
  const api = createFaultApi({ sleep: clock.sleep, now: clock.now });
  const spans = memorySink();
  const telemetry = createTelemetry({ sinks: [spans], now: clock.now, strict: true });
  const executorFor = (chosen: string | undefined) => createExecutor({
    baseUrl: 'http://fault-api.test',
    getCredential: () => Promise.resolve({ kind: 'header', name: 'authorization', value: `Bearer ${DEFAULT_CREDENTIAL}` }),
    telemetry,
    fetch: (request) => api.fetch(request),
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    newKey: () => 'generated-key',
    ...(chosen === undefined ? {} : { headers: { 'x-fault': chosen } }),
    ...options,
  });
  const executor = executorFor(fault);
  const call = (operation: Operation, args: unknown) => clock.run(executor.call(operation, args, { caller: 'key_1' }));
  return { api, call, clock, executorFor, spans };
}

// Timers for deadlines and attempts are in the list too, so look only at the short ones.
const backoffs = (waits: number[]) => waits.filter((ms) => ms !== 30_000 && ms !== 10_000);

// C7, counted from what fault-api actually received.
describe('only temporary failures are retried', () => {
  it('gives a 400 one attempt', async () => {
    const { api, call } = setup('status=400');
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: false, attempts: 1, error: { code: 'rejected', retry: 'no' } });
    expect(api.requests()).toHaveLength(1);
  });

  it('gives a 401 one attempt', async () => {
    const { api, call } = setup('status=401');
    await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(api.requests()).toHaveLength(1);
  });

  it('gives a 503 three attempts by default, with backoff', async () => {
    const { api, call, clock } = setup('status=503');
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: false, attempts: 3, error: { code: 'unavailable', retry: 'later' } });
    expect(api.requests()).toHaveLength(3);
    expect(backoffs(clock.waits)).toEqual([100, 200]);
  });

  it('succeeds when a retry works, and says how many it took', async () => {
    const { call } = setup('status=503;times=2');
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: true, status: 200, attempts: 3 });
  });

  it('retries a lost connection on a read', async () => {
    const { api, call } = setup('drop;times=1');
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: true, attempts: 2 });
    expect(api.requests()).toHaveLength(2);
  });

  it('retries a timed-out attempt on a read', async () => {
    const { call, clock } = setup('hang;times=1');
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: true, attempts: 2 });
    expect(clock.elapsed()).toBe(10_100);
  });

  it('can be set to a different number of attempts', async () => {
    const { api, call } = setup('status=503', { retry: { attempts: 5 } });
    await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(api.requests()).toHaveLength(5);
  });

  it('can be set to different backoff limits', async () => {
    const { call, clock } = setup('status=503', { random: () => 1, retry: { baseMs: 1_000, capMs: 1_500 } });
    await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(backoffs(clock.waits)).toEqual([1_000, 1_500]);
  });
});

describe('Retry-After', () => {
  it('sets the wait, in place of backoff', async () => {
    const { call, clock } = setup('status=429;retry-after=7;times=1');
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: true, attempts: 2 });
    expect(backoffs(clock.waits)).toEqual([7_000]);
  });

  it('is honored on a 503 too', async () => {
    const { call, clock } = setup('status=503;retry-after=2;times=1');
    await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(backoffs(clock.waits)).toEqual([2_000]);
  });

  // A hostile or mistaken value can't stall anything, because the deadline wins.
  it('isn\'t waited for when it wouldn\'t fit in the deadline, and the agent gets to decide', async () => {
    const { api, call, clock } = setup('status=429;retry-after=3600');
    const outcome = await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(outcome).toMatchObject({ ok: false, attempts: 1, error: { code: 'rate_limited', retry: 'later', retryAfterMs: 3_600_000 } });
    expect(!outcome.ok && outcome.error.message).toContain('3600 seconds');
    expect(api.requests()).toHaveLength(1);
    expect(clock.elapsed()).toBe(0);
  });

  it('is passed on when the attempts run out', async () => {
    const { call } = setup('status=429;retry-after=1', { retry: { attempts: 2 } });
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: false, error: { retryAfterMs: 1_000 } });
  });
});

describe('the deadline covers the retries', () => {
  it('stops retrying when the backoff wouldn\'t fit', async () => {
    const { api, call, clock } = setup('status=503', { deadlineMs: 50, retry: { attempts: 10 } });
    expect(await call(GET_CUSTOMER, { id: 'cus_1' })).toMatchObject({ ok: false, attempts: 1, error: { code: 'unavailable' } });
    expect(api.requests()).toHaveLength(1);
    expect(clock.elapsed()).toBe(0);
  });

  it('stops retrying when the deadline runs out during an attempt', async () => {
    const { api, call, clock } = setup('hang', { deadlineMs: 15_000, retry: { attempts: 10 } });
    const outcome = await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(outcome).toMatchObject({ ok: false, attempts: 2, error: { code: 'timeout' } });
    expect(api.requests()).toHaveLength(2);
    expect(clock.elapsed()).toBe(15_000);
  });

  it('never outlives it, whatever the retries are doing', async () => {
    const { call, clock } = setup('delay=9000;status=503', { deadlineMs: 20_000, retry: { attempts: 100 }, random: () => 1 });
    await call(GET_CUSTOMER, { id: 'cus_1' });
    expect(clock.elapsed()).toBeLessThanOrEqual(20_000);
  });
});

// C5, the heart of the project.
describe('a write with an idempotency key', () => {
  it('survives losing the response: a retry with the same key has exactly one effect', async () => {
    const { api, call } = setup('drop;times=1');
    const outcome = await call(CREATE_PAYMENT, CHARGE);
    expect(outcome).toMatchObject({ ok: true, status: 201, attempts: 2 });
    expect(outcome.ok && JSON.parse(outcome.body)).toMatchObject({ id: 'pay_1' });
    expect(api.effects()).toEqual([{ kind: 'payment.created', id: 'pay_1' }]);
  });

  it('sends the same key on every attempt', async () => {
    const { api, call } = setup('status=503');
    await call(CREATE_PAYMENT, CHARGE);
    const keys = api.requests().map((record) => record.headers['idempotency-key']);
    expect(keys).toEqual(['generated-key', 'generated-key', 'generated-key']);
  });

  it('hands the key to the agent when it gives up', async () => {
    const { api, call } = setup('drop');
    const outcome = await call(CREATE_PAYMENT, CHARGE);
    expect(outcome).toMatchObject({
      ok: false,
      attempts: 3,
      error: { code: 'outcome_unknown', retry: 'same_key', idempotencyKey: 'generated-key' },
    });
    expect(!outcome.ok && outcome.error.message).toContain('idempotencyKey generated-key');
    expect(api.effects()).toHaveLength(1);
  });

  // The whole loop: Crumple gives up, tells the agent how, and the agent recovers safely.
  it('lets an agent recover using the key from the error, still with one effect', async () => {
    const { api, clock, executorFor } = setup(undefined);
    const context = { caller: 'key_1' };

    const failed = await clock.run(executorFor('drop').call(CREATE_PAYMENT, CHARGE, context));
    expect(failed.ok).toBe(false);
    if (failed.ok) return;

    const recovered = await clock.run(executorFor(undefined).call(CREATE_PAYMENT, { ...CHARGE, idempotencyKey: failed.error.idempotencyKey }, context));
    expect(recovered).toMatchObject({ ok: true, status: 201, attempts: 1 });
    expect(recovered.ok && JSON.parse(recovered.body)).toMatchObject({ id: 'pay_1' });
    expect(api.effects()).toEqual([{ kind: 'payment.created', id: 'pay_1' }]);
  });

  it('retries a 503 too, where the effect is what the API says', async () => {
    const { api, call } = setup('status=503;times=2');
    expect(await call(CREATE_PAYMENT, CHARGE)).toMatchObject({ ok: true, attempts: 3 });
    expect(api.effects()).toHaveLength(1);
  });

  it('returns the key when a 503 outlasts the attempts', async () => {
    const { call } = setup('status=503');
    expect(await call(CREATE_PAYMENT, CHARGE)).toMatchObject({ ok: false, error: { code: 'outcome_unknown', retry: 'same_key' } });
  });

  it('uses a different key for a different call', async () => {
    let count = 0;
    const { api, call } = setup(undefined, { newKey: () => `key-${++count}` });
    await call(CREATE_PAYMENT, CHARGE);
    await call(CREATE_PAYMENT, CHARGE);
    expect(api.effects()).toHaveLength(2);
  });

  it('generates a real random key by default', async () => {
    const clock = fakeClock();
    const api = createFaultApi({ sleep: clock.sleep, now: clock.now });
    const executor = createExecutor({
      baseUrl: 'http://fault-api.test',
      getCredential: () => Promise.resolve({ kind: 'header', name: 'authorization', value: `Bearer ${DEFAULT_CREDENTIAL}` }),
      telemetry: createTelemetry(),
      fetch: (request) => api.fetch(request),
      sleep: clock.sleep,
    });
    await clock.run(executor.call(CREATE_PAYMENT, CHARGE, { caller: 'key_1' }));
    expect(api.requests()[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a key that has already been used for something else', async () => {
    const { api, call } = setup(undefined);
    await call(CREATE_PAYMENT, { ...CHARGE, idempotencyKey: 'k' });
    const outcome = await call(CREATE_PAYMENT, { body: { customerId: 'cus_1', amountCents: 1 }, idempotencyKey: 'k' });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'rejected' } });
    expect(api.effects()).toHaveLength(1);
  });
});

// The owner's decision: never, even after a 503.
describe('a write with no idempotency key', () => {
  it.each([
    ['a lost response', 'drop'],
    ['a 503', 'status=503'],
    ['a 500', 'status=500'],
    ['a timeout', 'hang'],
  ])('gets one attempt after %s, and the agent is told to check', async (_name, fault) => {
    const { api, call } = setup(fault);
    const outcome = await call(UNSAFE_PAYMENT, CHARGE);
    expect(outcome).toMatchObject({ ok: false, attempts: 1, error: { code: 'outcome_unknown', retry: 'check_first' } });
    expect(api.requests()).toHaveLength(1);
    expect(!outcome.ok && outcome.error.idempotencyKey).toBeUndefined();
  });

  it('has exactly one effect after a lost response', async () => {
    const { api, call } = setup('drop');
    await call(UNSAFE_PAYMENT, CHARGE);
    expect(api.effects()).toHaveLength(1);
  });

  it('is told a 429 wasn\'t applied, so trying later is safe', async () => {
    const { api, call } = setup('status=429;retry-after=5');
    const outcome = await call(UNSAFE_PAYMENT, CHARGE);
    expect(outcome).toMatchObject({ ok: false, attempts: 1, error: { code: 'rate_limited', retry: 'later', retryAfterMs: 5_000 } });
    expect(api.effects()).toEqual([]);
  });
});

describe('when the caller goes away during backoff', () => {
  it('stops at once', async () => {
    const { api, clock, executorFor } = setup(undefined);
    const controller = new AbortController();
    const pending = executorFor('status=503;retry-after=20').call(GET_CUSTOMER, { id: 'cus_1' }, { caller: 'key_1', signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('client disconnected'));
    expect(await clock.run(pending)).toMatchObject({ ok: false, attempts: 1, error: { code: 'cancelled' } });
    expect(api.requests()).toHaveLength(1);
  });
});

describe('the trace', () => {
  it('shows each attempt, the resend count and the wait', async () => {
    const { call, spans } = setup('status=503;times=2');
    await call(GET_CUSTOMER, { id: 'cus_1' });
    const attempts = spans.spans().filter((span) => span.kind === 'client');
    expect(attempts.map((span) => span.attributes['http.request.resend_count'])).toEqual([undefined, 1, 2]);
    expect(attempts.map((span) => span.attributes['crumple.retry.delay_ms'])).toEqual([undefined, 100, 200]);
    expect(attempts.map((span) => span.attributes['error.type'])).toEqual(['503', '503', undefined]);
  });

  it('shows the gap between attempts in their times', async () => {
    const { call, spans } = setup('status=429;retry-after=7;times=1');
    await call(GET_CUSTOMER, { id: 'cus_1' });
    const [first, second] = spans.spans().filter((span) => span.kind === 'client');
    expect((second?.startMs ?? 0) - (first?.endMs ?? 0)).toBe(7_000);
  });

  it('never records the idempotency key', async () => {
    const { call, spans } = setup(undefined);
    await call(CREATE_PAYMENT, { ...CHARGE, idempotencyKey: 'should-not-be-traced' });
    expect(JSON.stringify(spans.spans())).not.toContain('should-not-be-traced');
  });
});
