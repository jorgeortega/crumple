// Time that only moves when a test says so, so a 30-second deadline takes no real time and
// no test can be flaky because a machine was slow.

interface Timer {
  at: number;
  fire: () => void;
}

export interface FakeClock {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Runs work to completion, jumping to the next timer whenever everything is waiting. */
  run: <T>(work: Promise<T>) => Promise<T>;
  /** Every wait that was asked for, in order. */
  waits: number[];
  /** The time passed since the clock was created. */
  elapsed: () => number;
}

const START = 1_800_000_000_000;

export function fakeClock(): FakeClock {
  let current = START;
  const timers: Timer[] = [];
  const waits: number[] = [];

  function remove(timer: Timer): void {
    const index = timers.indexOf(timer);
    if (index !== -1) timers.splice(index, 1);
  }

  // Real macrotasks, so promises and streams finish everything they can do without time.
  async function settle(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    now: () => current,
    waits,
    elapsed: () => current - START,
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason as Error);
          return;
        }
        waits.push(ms);
        const timer: Timer = { at: current + ms, fire: resolve };
        timers.push(timer);
        signal.addEventListener('abort', () => {
          remove(timer);
          reject(signal.reason as Error);
        }, { once: true });
      });
    },
    async run(work) {
      const state = { finished: false };
      const tracked = work.finally(() => {
        state.finished = true;
      });
      tracked.catch(() => undefined);

      for (;;) {
        await settle();
        if (state.finished) return tracked;

        const next = timers.reduce<Timer | undefined>((soonest, timer) => (soonest && soonest.at <= timer.at ? soonest : timer), undefined);
        if (!next) throw new Error('The work is stuck: it hasn\'t finished, and nothing is waiting on the clock.');
        current = next.at;
        remove(next);
        next.fire();
      }
    },
  };
}
