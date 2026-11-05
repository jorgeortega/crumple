import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { harness, runOnce } from '../../tests/helpers/cli.js';
import { wrongServer } from '../../tests/helpers/wrong-server.js';
import { SELF_CHECKS, type StartTarget } from '../prove/index.js';
import { runSelf, startCrumple } from './prove.js';

const folders: string[] = [];
const tempFolder = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'crumple-prove-'));
  folders.push(folder);
  return folder;
};
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const failedIds = async (start: StartTarget): Promise<string[]> => {
  const report = await runSelf(start, harness().io);
  return report.checks.filter((check) => check.state === 'fail').map((check) => check.id);
};

describe('prove --self on the real Crumple', () => {
  it('passes every check, over real sockets, in well under the 60 seconds demo gets', async () => {
    const started = performance.now();
    const report = await runSelf(startCrumple, harness().io);
    const failing = report.checks.filter((check) => check.state !== 'pass').map((check) => `${check.id}: ${check.detail}`);
    expect(failing).toEqual([]);
    expect(report.checks).toHaveLength(SELF_CHECKS.length);
    expect(performance.now() - started).toBeLessThan(30_000);

    const states = Object.fromEntries((report.claims ?? []).map((claim) => [claim.id, claim.state]));
    expect(states).toMatchObject({ C1: 'pass', C2: 'partly', C3: 'pass', C4: 'pass', C5: 'pass', C6: 'pass', C7: 'pass', C8: 'pass', C9: 'pass', C10: 'partly', C11: 'not_run', C15: 'not_run' });
  }, 60_000);
});

// Task 22's "break a behaviour on purpose and confirm the report fails", on Crumple itself rather
// than on a server written to be wrong.
describe('breaking Crumple on purpose', () => {
  const broken = (change: Parameters<StartTarget>[0]): StartTarget => (setup) => startCrumple({ ...setup, ...change });

  it.each<[string, Parameters<StartTarget>[0], string]>([
    ['no retries', { retry: { attempts: 1 } }, 'one-effect'],
    ['limits too high to refuse anything', { limits: { perCaller: 100, queuePerCaller: 100, perUpstream: 100, queueUpstream: 100 } }, 'noisy-caller'],
    ['a breaker that never opens', { breaker: { minimumCalls: 1000, windowSize: 2000 } }, 'breaker-opens'],
    ['a deadline far too long', { deadlineMs: 60_000, attemptTimeoutMs: 60_000 }, 'deadline-holds'],
  ])('%s fails the report', async (_name, change, id) => {
    const check = SELF_CHECKS.filter((candidate) => candidate.id === id);
    const { runChecks } = await import('../prove/index.js');
    const [outcome] = await runChecks(check, broken(change));
    expect(outcome?.state).toBe('fail');
  }, 20_000);

  it('turns into a failing report and a non-zero exit against a server that\'s wrong', async () => {
    const ids = await failedIds(wrongServer);
    expect(ids).toHaveLength(SELF_CHECKS.length);
  }, 60_000);
});

describe('the command', () => {
  it('writes the report in three forms, and exits 0 when nothing failed', async () => {
    const folder = tempFolder();
    const { code, out } = await runOnce(['prove', '--self', '--out', folder, '--name', 'latest'], { env: { CRUMPLE_PROVE_COMMIT: 'abc1234', CRUMPLE_PROVE_DIRTY: '0' } });
    expect(code).toBe(0);
    expect(out).toMatch(/pass\s+one-effect/);
    expect(out).toContain('10 passed, 0 failed, 0 not run');

    const markdown = readFileSync(join(folder, 'latest.md'), 'utf8');
    expect(markdown).toContain('commit abc1234.');
    expect(markdown).toContain('| C5 | A write is never applied twice | pass |');
    expect(markdown).toContain('Latitude 10');
    expect(out.toLowerCase()).not.toContain('latitude');

    const json = JSON.parse(readFileSync(join(folder, 'latest.json'), 'utf8')) as { counts: unknown; environment: { commit: string; dirty: boolean; node: string } };
    expect(json.counts).toEqual({ passed: 10, failed: 0, notRun: 0 });
    expect(json.environment).toMatchObject({ commit: 'abc1234', dirty: false, node: process.versions.node });
    expect(readFileSync(join(folder, 'latest.svg'), 'utf8')).toContain('10 passed · 0 failed · 0 not run');
  }, 60_000);

  it('states uncommitted changes when told, and the version when there\'s no commit', async () => {
    const dirty = await runSelf(() => Promise.reject(new Error('unused')), harness({ env: { CRUMPLE_PROVE_COMMIT: 'abc', CRUMPLE_PROVE_DIRTY: '1' } }).io);
    expect(dirty.environment).toMatchObject({ commit: 'abc', dirty: true });
    const plain = await runSelf(() => Promise.reject(new Error('unused')), harness().io);
    expect(plain.environment.commit).toBeUndefined();
    expect(plain.environment.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each<[string, string[], RegExp]>([
    ['nothing to check', ['prove'], /Say what to check/],
    ['a misspelt flag', ['prove', '--slef'], /--slef/],
    ['a name that isn\'t safe for files', ['prove', '--self', '--name', '../evil'], /--name should be letters/],
  ])('refuses %s', async (_name, argv, message) => {
    const { code, err } = await runOnce(argv);
    expect(code).toBe(2);
    expect(err).toMatch(message);
  });
});
