import { describe, expect, it } from 'vitest';
import { countChecks, type CheckOutcome } from './checks.js';
import { CLAIMS, rollUpClaims } from './claims.js';
import { renderMarkdown, type ProveReport } from './report.js';
import { SUITES, suiteOutcome, withSuites, type Suite, type SuiteRun } from './suites.js';

const SUITE: Suite = { id: 'a-suite', claim: 'C14', title: 'A suite', script: 'test:something' };
const GOOD: SuiteRun = { exitCode: 0, passed: 7, failed: 0, skipped: 0, durationMs: 12_345 };

const selfOutcomes = (): CheckOutcome[] => CLAIMS.filter(({ pending }) => pending === undefined).map(({ id }) => ({ id: `check-${id}`, title: id, claim: id, state: 'pass', detail: 'held' }));

const selfReport = (): ProveReport => {
  const checks = selfOutcomes();
  return {
    kind: 'self',
    target: 'self',
    startedAt: '2026-11-06T00:00:00.000Z',
    durationMs: 1_000,
    environment: { version: '0.1.0', commit: 'abc1234', os: 'darwin arm64', cpu: 'a CPU', memoryGb: 16, node: '26.10.0' },
    checks,
    claims: rollUpClaims(checks),
  };
};

const passing = (): CheckOutcome[] => SUITES.map((suite) => suiteOutcome(suite, GOOD));

describe('suiteOutcome', () => {
  it('passes a suite that ran and held, naming the command and what it found', () => {
    const outcome = suiteOutcome(SUITE, GOOD);
    expect(outcome).toMatchObject({ id: 'a-suite', claim: 'C14', title: 'A suite', state: 'pass', measured: { durationMs: 12_345 } });
    expect(outcome.detail).toContain('npm run test:something');
    expect(outcome.detail).toContain('7 tests passed');
    expect(outcome.detail).toContain('12.3 s');
  });

  it.each<[string, Partial<SuiteRun>, RegExp]>([
    ['a non-zero exit', { exitCode: 1 }, /exit code 1/],
    ['a suite that never finished', { exitCode: null }, /didn't finish/],
    ['a failed test', { failed: 2 }, /2 tests failed/],
    ['a skipped test, which proves nothing', { skipped: 1 }, /1 test was skipped/],
    ['no tests at all', { passed: 0 }, /no test passed/],
  ])('fails on %s', (_, change, reason) => {
    const outcome = suiteOutcome(SUITE, { ...GOOD, ...change });
    expect(outcome.state).toBe('fail');
    expect(outcome.detail).toMatch(reason);
  });

  it('never reports a test count when a test failed in a run that exited 0', () => {
    expect(suiteOutcome(SUITE, { ...GOOD, failed: 1 }).detail).not.toContain('tests passed');
  });
});

describe('SUITES', () => {
  it('covers exactly the claims that prove --self says it can\'t reach', () => {
    const elsewhere = CLAIMS.filter(({ pending }) => pending !== undefined).map(({ id }) => id);
    expect(SUITES.map(({ claim }) => claim)).toEqual(elsewhere);
  });

  it('says plainly that the first run isn\'t a stranger\'s machine', () => {
    expect(SUITES.find(({ claim }) => claim === 'C16')?.title).toContain('on this machine');
  });
});

describe('withSuites', () => {
  it('starts from 15 of 18, and reaches all of them once every suite passes', () => {
    const before = selfReport();
    expect(before.claims?.filter(({ state }) => state === 'pass')).toHaveLength(15);
    const after = withSuites(before, passing());
    expect(after.claims).toHaveLength(18);
    expect(after.claims?.every(({ state }) => state === 'pass')).toBe(true);
    expect(after.claims?.some(({ pending }) => pending !== undefined)).toBe(false);
  });

  it('adds the suites to the checks and the time taken', () => {
    const after = withSuites(selfReport(), passing());
    expect(countChecks(after.checks).passed).toBe(CLAIMS.length);
    expect(after.durationMs).toBe(1_000 + 3 * 12_345);
  });

  it('fails the claim when its suite fails, and leaves the others alone', () => {
    const [first, ...rest] = SUITES;
    if (!first) throw new Error('no suites');
    const after = withSuites(selfReport(), [suiteOutcome(first, { ...GOOD, exitCode: 1 }), ...rest.map((suite) => suiteOutcome(suite, GOOD))]);
    expect(after.claims?.find(({ id }) => id === first.claim)?.state).toBe('fail');
    expect(after.claims?.filter(({ state }) => state === 'pass')).toHaveLength(17);
  });

  it('keeps saying where a claim runs when its suite wasn\'t given', () => {
    const c15 = SUITES.filter(({ claim }) => claim !== 'C15').map((suite) => suiteOutcome(suite, GOOD));
    const claim = withSuites(selfReport(), c15).claims?.find(({ id }) => id === 'C15');
    expect(claim?.state).toBe('not_run');
    expect(claim?.pending).toContain('test:workers');
  });

  it('doesn\'t change the report it was given', () => {
    const before = selfReport();
    withSuites(before, passing());
    expect(before.checks).toHaveLength(15);
    expect(before.durationMs).toBe(1_000);
  });

  it('writes a report with no empty "not checked" column, naming what checked each claim', () => {
    const text = renderMarkdown(withSuites(selfReport(), passing()));
    expect(text).not.toContain('Not checked here');
    expect(text).toMatch(/\| C14 \| It speaks real MCP \| pass \| `python-sdk-interop` \|/);
  });
});
