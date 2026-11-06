import { fail, pass, type CheckOutcome, type CheckResult } from './checks.js';
import { CLAIMS, rollUpClaims } from './claims.js';
import type { ProveReport } from './report.js';

// The three claims prove --self can't reach, because they need Python, workerd or a packed tarball.
// npm run prove runs their suites and folds the results in here, so no report's "pass" on them is
// typed by hand. This is only reachable from the repo's own script: the package has no flag for it,
// so a stranger's npx run can't mark a claim as passed.

export interface Suite {
  id: string;
  claim: string;
  title: string;
  /** The npm script that runs it. */
  script: string;
}

export const SUITES: readonly Suite[] = [
  { id: 'python-sdk-interop', claim: 'C14', title: 'The official Python SDK, a separate implementation, lists and calls tools', script: 'test:interop' },
  { id: 'demo-limits-in-workerd', claim: 'C15', title: 'The demo\'s rate limit, daily cap and reset, in workerd, with no public path to a paid model', script: 'test:workers' },
  { id: 'first-run-from-tarball', claim: 'C16', title: 'A first run from a packed tarball in an empty folder on this machine, not a clean machine or the published package', script: 'test:install' },
];

export interface SuiteRun {
  /** null when it was killed or never started. */
  exitCode: number | null;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

const tests = (count: number): string => `${String(count)} ${count === 1 ? 'test' : 'tests'}`;

function verdict({ script }: Suite, run: SuiteRun): CheckResult {
  const measured = { durationMs: run.durationMs };
  const command = `npm run ${script}`;
  if (run.exitCode === null) return fail(`${command} didn't finish.`, measured);
  if (run.failed > 0) return fail(`${command}: ${tests(run.failed)} failed.`, measured);
  // First, because when a suite's setup fails its tests only show as skipped, which says less.
  if (run.exitCode !== 0) return fail(`${command} ended with exit code ${String(run.exitCode)}. Run it by itself to see why.`, measured);
  // It would exit 0 with a tool missing, and a green result has to mean it really ran.
  if (run.skipped > 0) return fail(`${command}: ${run.skipped === 1 ? '1 test was' : `${String(run.skipped)} tests were`} skipped, and a skipped test proves nothing.`, measured);
  if (run.passed === 0) return fail(`${command}: no test passed, so it shows nothing.`, measured);
  return pass(`${command}: ${tests(run.passed)} passed in ${(run.durationMs / 1000).toFixed(1)} s.`, measured);
}

export function suiteOutcome(suite: Suite, run: SuiteRun): CheckOutcome {
  return { id: suite.id, title: suite.title, claim: suite.claim, ...verdict(suite, run) };
}

/** A claim stops being "checked elsewhere" only for the suites that were actually given. */
export function withSuites(report: ProveReport, outcomes: readonly CheckOutcome[]): ProveReport {
  const covered = new Set(outcomes.map(({ claim }) => claim));
  const claims = CLAIMS.map((claim) => (covered.has(claim.id) ? { id: claim.id, text: claim.text } : claim));
  const checks = [...report.checks, ...outcomes];
  const spent = outcomes.reduce((total, { measured }) => total + (measured?.durationMs ?? 0), 0);
  return { ...report, durationMs: report.durationMs + spent, checks, claims: rollUpClaims(checks, claims) };
}
