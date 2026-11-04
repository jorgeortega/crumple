import { describe, expect, it } from 'vitest';
import { createLimits } from './limits.js';

const open = new AbortController().signal;
const LIMITS = { perCaller: 2, perUpstream: 3, queuePerCaller: 1, queueUpstream: 2 };

async function take(limits: ReturnType<typeof createLimits>, caller: string, signal = open) {
  const result = await limits.acquire(caller, signal);
  if (!result) throw new Error(`${caller} was refused`);
  return result;
}

describe('createLimits', () => {
  it('lets calls through up to the caller\'s limit', async () => {
    const limits = createLimits(LIMITS);
    await take(limits, 'a');
    await take(limits, 'a');
    expect(limits.stats()).toMatchObject({ active: 2 });
  });

  it('makes a call past the caller\'s limit wait, then lets it through when one finishes', async () => {
    const limits = createLimits(LIMITS);
    const release = await take(limits, 'a');
    await take(limits, 'a');

    const waiting = limits.acquire('a', open);
    let finished = false;
    void waiting.then(() => {
      finished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);

    release();
    expect(await waiting).toBeTypeOf('function');
  });

  // A queue with no limit is just a slower outage.
  it('refuses at once when the caller\'s queue is full', async () => {
    const limits = createLimits(LIMITS);
    await take(limits, 'a');
    await take(limits, 'a');
    void limits.acquire('a', open);
    expect(await limits.acquire('a', open)).toBeUndefined();
  });

  // C9, in miniature. One caller's flood leaves room for the next.
  it('leaves room for another caller while one is at its limit', async () => {
    const limits = createLimits(LIMITS);
    await take(limits, 'noisy');
    await take(limits, 'noisy');
    void limits.acquire('noisy', open);
    expect(await limits.acquire('noisy', open)).toBeUndefined();
    expect(await limits.acquire('quiet', open)).toBeTypeOf('function');
  });

  it('makes a call past the upstream\'s limit wait, even if its caller has room', async () => {
    const limits = createLimits(LIMITS);
    const release = await take(limits, 'a');
    await take(limits, 'b');
    await take(limits, 'c');

    const waiting = limits.acquire('d', open);
    release();
    expect(await waiting).toBeTypeOf('function');
  });

  it('refuses when the upstream\'s queue is full too', async () => {
    const limits = createLimits(LIMITS);
    await take(limits, 'a');
    await take(limits, 'b');
    await take(limits, 'c');
    void limits.acquire('d', open);
    void limits.acquire('e', open);
    expect(await limits.acquire('f', open)).toBeUndefined();
  });

  it('frees the caller\'s slot when the upstream\'s queue refuses', async () => {
    const limits = createLimits({ ...LIMITS, perCaller: 1 });
    await take(limits, 'a');
    await take(limits, 'b');
    await take(limits, 'c');
    void limits.acquire('d', open);
    void limits.acquire('e', open);
    expect(await limits.acquire('f', open)).toBeUndefined();
    expect(limits.stats().callers).toBe(5);
  });

  it('serves the upstream\'s queue in order', async () => {
    const limits = createLimits({ ...LIMITS, perUpstream: 1 });
    const release = await take(limits, 'a');
    const order: string[] = [];
    const first = limits.acquire('b', open).then((done) => {
      order.push('b');
      return done;
    });
    const second = limits.acquire('c', open).then((done) => {
      order.push('c');
      return done;
    });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    (await first)?.();
    await second;
    expect(order).toEqual(['b', 'c']);
  });

  it('stops a waiting call when its signal aborts, and frees the place', async () => {
    const limits = createLimits(LIMITS);
    await take(limits, 'a');
    await take(limits, 'a');
    const controller = new AbortController();
    const waiting = limits.acquire('a', controller.signal);
    controller.abort(new Error('deadline'));
    await expect(waiting).rejects.toThrow('deadline');

    void limits.acquire('a', open);
    expect(limits.stats()).toMatchObject({ waiting: 1 });
  });

  it('stops a call waiting on the upstream too, and frees its caller slot', async () => {
    const limits = createLimits({ ...LIMITS, perUpstream: 1 });
    const holder = await take(limits, 'a');
    const controller = new AbortController();
    const waiting = limits.acquire('b', controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('deadline'));
    await expect(waiting).rejects.toThrow('deadline');

    holder();
    expect(limits.stats()).toMatchObject({ active: 0, waiting: 0, callers: 0 });
  });

  it('refuses at once if the signal has already aborted', async () => {
    const limits = createLimits(LIMITS);
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    await expect(limits.acquire('a', controller.signal)).rejects.toThrow('already gone');
    expect(limits.stats()).toMatchObject({ active: 0, callers: 0 });
  });

  it('only releases once, however many times it\'s called', async () => {
    const limits = createLimits(LIMITS);
    const release = await take(limits, 'a');
    await take(limits, 'b');
    release();
    release();
    expect(limits.stats()).toMatchObject({ active: 1 });
  });

  // A caller is a key, and a server can see many over a long life.
  it('forgets a caller with nothing in progress, so memory can\'t grow forever', async () => {
    const limits = createLimits(LIMITS);
    for (const caller of ['a', 'b', 'c']) (await take(limits, caller))();
    expect(limits.stats()).toEqual({ active: 0, waiting: 0, callers: 0 });
  });
});
