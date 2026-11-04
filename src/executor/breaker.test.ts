import { describe, expect, it } from 'vitest';
import { admit, CLOSED, report, type BreakerConfig, type BreakerState } from './breaker.js';

const CONFIG: BreakerConfig = { windowSize: 20, minimumCalls: 5, failureRate: 0.5, openMs: 30_000 };
const T = 1_000;

function closedWith(...results: boolean[]): BreakerState {
  return { name: 'closed', recent: results };
}

const failures = (count: number) => Array.from({ length: count }, () => false);
const successes = (count: number) => Array.from({ length: count }, () => true);

describe('admit', () => {
  it('lets calls through when closed', () => {
    expect(admit(CLOSED, T)).toEqual({ state: CLOSED, allowed: true, probe: false });
  });

  it('refuses while open, and says how long is left', () => {
    const state: BreakerState = { name: 'open', until: T + 10_000 };
    expect(admit(state, T)).toEqual({ state, allowed: false, retryAfterMs: 10_000 });
  });

  it('lets one probe through once the time is up', () => {
    const decision = admit({ name: 'open', until: T }, T);
    expect(decision).toEqual({ state: { name: 'half_open', probing: true }, allowed: true, probe: true });
  });

  it('lets a probe through when it\'s later than the time, too', () => {
    expect(admit({ name: 'open', until: T - 5 }, T).allowed).toBe(true);
  });

  it('refuses everything else while a probe is out', () => {
    const state: BreakerState = { name: 'half_open', probing: true };
    expect(admit(state, T)).toEqual({ state, allowed: false, retryAfterMs: 0 });
  });

  it('lets a new probe through when half-open with none out', () => {
    const decision = admit({ name: 'half_open', probing: false }, T);
    expect(decision).toEqual({ state: { name: 'half_open', probing: true }, allowed: true, probe: true });
  });
});

describe('report', () => {
  type Row = [string, BreakerState, 'success' | 'failure' | 'neutral', boolean, BreakerState];

  const TABLE: Row[] = [
    ['closed, a success is remembered', CLOSED, 'success', false, closedWith(true)],
    ['closed, a failure is remembered', CLOSED, 'failure', false, closedWith(false)],
    ['closed, a neutral result changes nothing', closedWith(true), 'neutral', false, closedWith(true)],
    ['closed, below the minimum stays closed however bad', closedWith(...failures(3)), 'failure', false, closedWith(...failures(4))],
    ['closed, at the minimum and the rate, opens', closedWith(...failures(4)), 'failure', false, { name: 'open', until: T + 30_000 }],
    ['closed, exactly half failing opens', closedWith(...successes(5), ...failures(4)), 'failure', false, { name: 'open', until: T + 30_000 }],
    ['closed, under half failing stays closed', closedWith(...successes(6), ...failures(3)), 'failure', false, closedWith(...successes(6), ...failures(4))],
    ['half-open, the probe succeeding closes it', { name: 'half_open', probing: true }, 'success', true, CLOSED],
    ['half-open, the probe failing reopens it', { name: 'half_open', probing: true }, 'failure', true, { name: 'open', until: T + 30_000 }],
    ['half-open, a probe abandoned lets another go', { name: 'half_open', probing: true }, 'neutral', true, { name: 'half_open', probing: false }],
    // Calls sent before it opened can finish later. They say nothing about now.
    ['half-open, a late result from an older call is ignored', { name: 'half_open', probing: true }, 'failure', false, { name: 'half_open', probing: true }],
    ['open, a late failure is ignored', { name: 'open', until: T + 5 }, 'failure', false, { name: 'open', until: T + 5 }],
    ['open, a late success is ignored', { name: 'open', until: T + 5 }, 'success', false, { name: 'open', until: T + 5 }],
  ];

  it.each(TABLE)('%s', (_name, state, event, wasProbe, next) => {
    expect(report(state, event, wasProbe, T, CONFIG)).toEqual(next);
  });

  it('never opens on a success, even one that reaches the minimum', () => {
    expect(report(closedWith(...failures(4)), 'success', false, T, CONFIG)).toEqual(closedWith(...failures(4), true));
  });

  it('only looks at the most recent calls', () => {
    let state: BreakerState = closedWith(...failures(4), ...successes(16));
    state = report(state, 'success', false, T, CONFIG);
    expect(state).toEqual(closedWith(...failures(3), ...successes(17)));
  });

  it('forgets old failures, so a recovered API doesn\'t stay close to the edge', () => {
    let state: BreakerState = closedWith(...failures(4));
    for (let i = 0; i < 20; i += 1) state = report(state, 'success', false, T, CONFIG);
    expect(state).toEqual(closedWith(...successes(20)));
  });

  it('starts the count afresh after recovering', () => {
    expect(report({ name: 'half_open', probing: true }, 'success', true, T, CONFIG)).toEqual(CLOSED);
  });
});
