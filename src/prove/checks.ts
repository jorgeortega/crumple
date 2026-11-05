// Checks are data, so a list of them can be counted, filtered and reported without running anything.

export type CheckState = 'pass' | 'fail' | 'not_run';

export interface CheckResult {
  state: CheckState;
  /** Written by us. Text from a server under test never goes in here, apart from escaped tool names. */
  detail: string;
  /** Numbers the run actually measured. */
  measured?: Record<string, number>;
}

export interface Check<Context> {
  id: string;
  title: string;
  /** The claim in SPEC.md this is evidence for, if any. */
  claim?: string;
  run(context: Context): Promise<CheckResult>;
}

export interface CheckOutcome extends CheckResult {
  id: string;
  title: string;
  claim?: string;
}

export const pass = (detail: string, measured?: Record<string, number>): CheckResult => ({ state: 'pass', detail, ...(measured ? { measured } : {}) });
export const fail = (detail: string, measured?: Record<string, number>): CheckResult => ({ state: 'fail', detail, ...(measured ? { measured } : {}) });
export const notRun = (reason: string): CheckResult => ({ state: 'not_run', detail: reason });

export const DEFAULT_CHECK_TIMEOUT_MS = 30_000;

/**
 * One at a time. Several of these measure time, and they shouldn't compete with each other. A check
 * that crashes or never finishes is a fail: it didn't show the thing held, and it mustn't look as if
 * it didn't run.
 */
export async function runChecks<Context>(
  checks: readonly Check<Context>[],
  context: Context,
  options: { timeoutMs?: number; onOutcome?: (outcome: CheckOutcome) => void } = {},
): Promise<CheckOutcome[]> {
  const { timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, onOutcome } = options;
  const outcomes: CheckOutcome[] = [];

  for (const check of checks) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<CheckResult>((resolve) => {
      timer = setTimeout(() => { resolve(fail(`The check didn't finish within ${String(timeoutMs / 1000)} seconds.`)); }, timeoutMs);
    });

    let result: CheckResult;
    try {
      result = await Promise.race([check.run(context), timedOut]);
    } catch (error) {
      // Only the error's type. Its message could hold text from the server being tested.
      result = fail(`The check couldn't finish, because of a ${error instanceof Error ? error.name : 'problem'}.`);
    } finally {
      clearTimeout(timer);
    }

    const outcome: CheckOutcome = { id: check.id, title: check.title, ...(check.claim ? { claim: check.claim } : {}), ...result };
    outcomes.push(outcome);
    onOutcome?.(outcome);
  }
  return outcomes;
}

export interface Counts {
  passed: number;
  failed: number;
  notRun: number;
}

export function countChecks(outcomes: readonly CheckOutcome[]): Counts {
  return {
    passed: outcomes.filter((outcome) => outcome.state === 'pass').length,
    failed: outcomes.filter((outcome) => outcome.state === 'fail').length,
    notRun: outcomes.filter((outcome) => outcome.state === 'not_run').length,
  };
}
