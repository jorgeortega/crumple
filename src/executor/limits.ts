// Concurrency limits, on two levels: per caller, then per upstream. The first level is what
// stops a noisy caller starving others: it fills its own slots and leaves the rest free.
// Excess calls wait in a bounded queue, because a queue with no limit is just a slower outage.
//
// First come, first served at the upstream level, not fair scheduling. Exact within one
// process, and per instance on Workers.

export interface LimitOptions {
  /** Calls in flight for one caller. */
  perCaller: number;
  /** Calls in flight to the upstream, across all callers. */
  perUpstream: number;
  /** Calls one caller can have waiting for a slot of its own. */
  queuePerCaller: number;
  /** Calls that can be waiting for the upstream. */
  queueUpstream?: number;
}

export const DEFAULT_LIMITS = { perCaller: 10, perUpstream: 50, queuePerCaller: 20, queueUpstream: 200 };

export type Release = () => void;

export interface Limits {
  /** Resolves when there's a slot, with undefined when a queue is full, and rejects if the signal aborts. */
  acquire(caller: string, signal: AbortSignal): Promise<Release | undefined>;
  stats(): { active: number; waiting: number; callers: number };
}

interface Waiter {
  start: () => void;
}

// One level of limit: a number of slots, and a bounded line for them.
class Slots {
  active = 0;
  private readonly line: Waiter[] = [];

  constructor(private readonly max: number, private readonly maxWaiting: number) {}

  get waiting(): number {
    return this.line.length;
  }

  /** True when a slot was taken, false when the line is full. Rejects if the signal aborts. */
  take(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(true);
    }
    if (this.line.length >= this.maxWaiting) return Promise.resolve(false);

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.line.splice(this.line.indexOf(waiter), 1);
        reject(signal.reason as Error);
      };
      const waiter: Waiter = {
        start: () => {
          signal.removeEventListener('abort', onAbort);
          resolve(true);
        },
      };
      this.line.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  give(): void {
    // Passed straight to the next in line, so a new arrival can't jump the queue.
    const next = this.line.shift();
    if (next) next.start();
    else this.active -= 1;
  }
}

export function createLimits(options: LimitOptions): Limits {
  const { perCaller, perUpstream, queuePerCaller, queueUpstream = DEFAULT_LIMITS.queueUpstream } = options;
  const upstream = new Slots(perUpstream, queueUpstream);
  const callers = new Map<string, Slots>();

  // A caller is a key, and a server sees many over a long life, so idle ones are forgotten.
  function forgetIfIdle(caller: string, slots: Slots): void {
    if (slots.active === 0 && slots.waiting === 0) callers.delete(caller);
  }

  return {
    async acquire(caller, signal) {
      let slots = callers.get(caller);
      if (!slots) {
        slots = new Slots(perCaller, queuePerCaller);
        callers.set(caller, slots);
      }
      const mine = slots;

      try {
        if (!(await mine.take(signal))) return undefined;
      } catch (error) {
        forgetIfIdle(caller, mine);
        throw error;
      }

      try {
        if (!(await upstream.take(signal))) {
          mine.give();
          forgetIfIdle(caller, mine);
          return undefined;
        }
      } catch (error) {
        mine.give();
        forgetIfIdle(caller, mine);
        throw error;
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        upstream.give();
        mine.give();
        forgetIfIdle(caller, mine);
      };
    },
    stats: () => ({
      active: upstream.active,
      waiting: upstream.waiting + [...callers.values()].reduce((total, slots) => total + slots.waiting, 0),
      callers: callers.size,
    }),
  };
}
