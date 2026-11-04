// A circuit breaker, as a pure state machine, so a table can test every state and event. It
// stops hitting an upstream that's failing, which gives it room to recover and gives callers
// a fast answer rather than a slow failure.
//
//   closed --(enough recent calls, enough of them failing)--> open
//   open --(the wait passes)--> half-open
//   half-open --(one probe succeeds)--> closed
//   half-open --(the probe fails)--> open
//
// This is second on the spec's cut list, which is why it's kept to one file.

export interface BreakerConfig {
  /** How many recent calls to look at. */
  windowSize: number;
  /** Don't judge from fewer calls than this: one failure out of one means little. */
  minimumCalls: number;
  /** The share of recent calls that must have failed, from 0 to 1. */
  failureRate: number;
  /** How long to stop sending before testing again. */
  openMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { windowSize: 20, minimumCalls: 5, failureRate: 0.5, openMs: 30_000 };

export type BreakerState =
  | { name: 'closed'; /** true for a success, oldest first. */ recent: boolean[] }
  | { name: 'open'; until: number }
  | { name: 'half_open'; probing: boolean };

export const CLOSED: BreakerState = { name: 'closed', recent: [] };

export type BreakerDecision =
  | { state: BreakerState; allowed: true; /** This call is the one testing for recovery. */ probe: boolean }
  | { state: BreakerState; allowed: false; retryAfterMs: number };

/**
 * - `failure`: the upstream looks unhealthy: a timeout, a lost connection, a 5xx.
 * - `success`: the upstream answered, even with a 4xx. One agent's bad arguments mustn't be
 *   able to cut every other agent off from a healthy API.
 * - `neutral`: this call says nothing about the upstream, such as a caller going away.
 */
export type BreakerEvent = 'success' | 'failure' | 'neutral';

export function admit(state: BreakerState, now: number): BreakerDecision {
  switch (state.name) {
    case 'closed':
      return { state, allowed: true, probe: false };
    case 'open':
      if (now < state.until) return { state, allowed: false, retryAfterMs: state.until - now };
      return { state: { name: 'half_open', probing: true }, allowed: true, probe: true };
    case 'half_open':
      if (state.probing) return { state, allowed: false, retryAfterMs: 0 };
      return { state: { name: 'half_open', probing: true }, allowed: true, probe: true };
  }
}

export function report(state: BreakerState, event: BreakerEvent, wasProbe: boolean, now: number, config: BreakerConfig): BreakerState {
  const open = (): BreakerState => ({ name: 'open', until: now + config.openMs });

  switch (state.name) {
    case 'closed': {
      if (event === 'neutral') return state;
      const recent = [...state.recent, event === 'success'].slice(-config.windowSize);
      const failed = recent.filter((success) => !success).length;
      const tooMany = recent.length >= config.minimumCalls && failed / recent.length >= config.failureRate;
      // Only a failure can open it. A success that happens to reach minimumCalls mustn't.
      return event === 'failure' && tooMany ? open() : { name: 'closed', recent };
    }
    case 'half_open':
      // A call sent before the breaker opened can finish now. It says nothing about now.
      if (!wasProbe) return state;
      if (event === 'success') return CLOSED;
      return event === 'failure' ? open() : { name: 'half_open', probing: false };
    case 'open':
      return state;
  }
}
