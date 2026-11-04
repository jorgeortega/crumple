import { describe, expect, it } from 'vitest';
import { realSleep, startTimer, untilAborted } from './clock.js';

// The one place real time is used on purpose, because everything else injects this.
describe('realSleep', () => {
  it('waits', async () => {
    const started = Date.now();
    await realSleep(5, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
  });

  it('stops at once when the signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already'));
    await expect(realSleep(60_000, controller.signal)).rejects.toThrow('already');
  });

  it('stops when the signal aborts during the wait', async () => {
    const controller = new AbortController();
    const waiting = realSleep(60_000, controller.signal);
    controller.abort(new Error('during'));
    await expect(waiting).rejects.toThrow('during');
  });
});

describe('startTimer', () => {
  it('aborts when the time is up', async () => {
    const timer = startTimer(realSleep, 1);
    await new Promise((resolve) => {
      timer.signal.addEventListener('abort', resolve);
    });
    expect(timer.signal.aborted).toBe(true);
  });

  it('doesn\'t abort once cancelled', async () => {
    const timer = startTimer(realSleep, 1);
    timer.cancel();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(timer.signal.aborted).toBe(false);
  });
});

describe('untilAborted', () => {
  it('passes on a result', async () => {
    await expect(untilAborted(Promise.resolve('done'), new AbortController().signal)).resolves.toBe('done');
  });

  it('passes on a failure', async () => {
    await expect(untilAborted(Promise.reject(new Error('broke')), new AbortController().signal)).rejects.toThrow('broke');
  });

  it('gives up on work that never finishes', async () => {
    const controller = new AbortController();
    const waiting = untilAborted(new Promise(() => undefined), controller.signal);
    controller.abort(new Error('gave up'));
    await expect(waiting).rejects.toThrow('gave up');
  });

  it('doesn\'t start waiting when the signal has already aborted, and swallows the work\'s later failure', async () => {
    const controller = new AbortController();
    controller.abort(new Error('too late'));
    await expect(untilAborted(Promise.reject(new Error('ignored')), controller.signal)).rejects.toThrow('too late');
  });
});
