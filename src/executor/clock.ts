// Time, in one place. It's injected everywhere, so a 30-second deadline takes no real time
// in a test and no test can be flaky because a machine was slow.

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface Timer {
  /** Aborts when the time is up. */
  signal: AbortSignal;
  /** Stops the timer, so nothing keeps running after the work is done. */
  cancel(): void;
}

export function startTimer(sleep: Sleep, ms: number): Timer {
  const expired = new AbortController();
  const stopped = new AbortController();
  sleep(ms, stopped.signal).then(
    () => {
      expired.abort(new Error('The time ran out.'));
    },
    () => undefined,
  );
  return {
    signal: expired.signal,
    cancel: () => {
      stopped.abort(new Error('The timer was stopped.'));
    },
  };
}

/**
 * Settles when the work does or the signal aborts, whichever comes first. A deadline can't
 * depend on the thing that's late cooperating: a library or a stream may ignore cancellation.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      work.catch(() => undefined);
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
