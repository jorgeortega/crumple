import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { harness, runOnce } from '../../tests/helpers/cli.js';
import { recordingServer, type RecordingServer } from '../../tests/helpers/recording-server.js';
import { wrongServer } from './wrong-server.js';
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
    expect(report.checks).toHaveLength(SELF_CHECKS.length + 3);
    expect(performance.now() - started).toBeLessThan(30_000);

    const states = Object.fromEntries((report.claims ?? []).map((claim) => [claim.id, claim.state]));
    expect(states).toMatchObject({ C1: 'pass', C2: 'partly', C3: 'pass', C4: 'pass', C5: 'pass', C6: 'pass', C7: 'pass', C8: 'pass', C9: 'pass', C10: 'partly', C11: 'pass', C12: 'not_run', C15: 'not_run', C17: 'pass', C18: 'pass' });
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
    // Every check about the server. The other two are about prove, which hasn't changed.
    expect(ids).toEqual([...SELF_CHECKS.map((check) => check.id), 'trace-joined']);
  }, 60_000);
});

describe('prove against a server', () => {
  const servers: RecordingServer[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });
  const server = async (options: Parameters<typeof recordingServer>[0] = {}) => {
    const started = await recordingServer(options);
    servers.push(started);
    return started;
  };

  it('says what it will do first, and reports what it found', async () => {
    const { url, toolCalls } = await server({ checkOrigin: true });
    const { code, out } = await runOnce(['prove', url]);
    expect(code).toBe(0);
    expect(out.indexOf('Run this only on servers you own')).toBeLessThan(out.indexOf('speaks-mcp'));
    expect(out).toContain('It sends at most 30 requests, and calls no tool you didn\'t name.');
    expect(out).toMatch(/pass\s+speaks-mcp/);
    expect(out).toContain('answered with no credential');
    expect(out).toContain('@modelcontextprotocol/conformance');
    expect(out).toContain('Can\'t be checked from outside');
    expect(toolCalls().filter((name) => !name.startsWith('crumple_prove_'))).toEqual([]);
  });

  it('exits 1 when a check fails, and doesn\'t fail for what didn\'t run', async () => {
    const { url } = await server();
    const { code, out } = await runOnce(['prove', url]);
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL\s+refuses-foreign-origin/);
    expect(out).toContain('How to fix these');
  });

  it('takes the token from the environment, and never prints it', async () => {
    const secret = 'prove-secret-value';
    const { url, calls } = await server({ requireToken: secret, checkOrigin: true });
    const folder = tempFolder();
    const { code, out, err } = await runOnce(['prove', url, '--out', folder], { env: { CRUMPLE_PROVE_TOKEN: secret } });
    expect(code).toBe(0);
    expect(calls.some((call) => call.headers.authorization === `Bearer ${secret}`)).toBe(true);
    for (const text of [out, err, readFileSync(join(folder, 'prove.md'), 'utf8'), readFileSync(join(folder, 'prove.json'), 'utf8')]) expect(text).not.toContain(secret);
  });

  it('passes the named tool, its arguments and the burst along', async () => {
    const { url, toolCalls, calls } = await server({ checkOrigin: true });
    const { out } = await runOnce(['prove', url, '--call', 'getThing', '--args', '{"id":"7"}', '--parallel', '3']);
    expect(toolCalls().filter((name) => name === 'getThing')).toHaveLength(5);
    expect(calls.find((call) => call.tool === 'getThing')?.arguments).toEqual({ id: '7' });
    expect(out).toMatch(/pass\s+parallel\s+3 at once/);
  });

  it('holds to --max-requests', async () => {
    const { url, calls } = await server();
    const { out } = await runOnce(['prove', url, '--max-requests', '2']);
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(out).toContain('of 2 requests used');
  });

  it('writes a shareable report that leaves out a key in the address', async () => {
    const { url } = await server({ checkOrigin: true });
    const folder = tempFolder();
    await runOnce(['prove', `${url}?key=very-secret`, '--out', folder]);
    const markdown = readFileSync(join(folder, 'prove.md'), 'utf8');
    expect(markdown).not.toContain('very-secret');
    expect(markdown).toContain('isn\'t a security audit');
    expect(markdown).toContain('Latitude 10');
    expect(markdown).toContain('C5');
    expect(readFileSync(join(folder, 'prove.svg'), 'utf8')).toContain('not run');
  });

  it('runs a local process given after --, without repeating its command line', async () => {
    const folder = tempFolder();
    const fixture = fileURLToPath(new URL('../../tests/fixtures/stdio-server.mjs', import.meta.url));
    const { code, out } = await runOnce(['prove', '--out', folder, '--', process.execPath, fixture, '--key', 'in-a-command']);
    expect(code).toBe(0);
    expect(out).toContain('a local process');
    expect(out).not.toContain('in-a-command');
    expect(readFileSync(join(folder, 'prove.md'), 'utf8')).not.toContain('in-a-command');
  }, 15_000);

  it('runs on real Crumple, with the same result a stranger would get', async () => {
    const target = await startCrumple({});
    try {
      const { code, out } = await runOnce(['prove', target.url, '--call', 'getCustomer', '--args', '{"id":"cus_1"}', '--parallel', '5'], { env: { CRUMPLE_PROVE_TOKEN: target.keys.read } });
      expect(out).toContain('Protocol 2026-07-28');
      expect(out).toMatch(/pass\s+refuses-foreign-origin/);
      expect(out).toMatch(/pass\s+bad-arguments/);
      expect(out).toMatch(/pass\s+parallel/);
      expect(out).toContain('0 failed');
      expect(code).toBe(0);
    } finally {
      await target.stop();
    }
  }, 15_000);

  it.each<[string, string[], Record<string, string>, RegExp]>([
    ['nothing to check', ['prove'], {}, /Say what to check/],
    ['two things to check', ['prove', '--self', 'https://a.test/mcp'], {}, /Choose one/],
    ['an address and a command', ['prove', 'https://a.test/mcp', '--', 'node'], {}, /Choose one/],
    ['an empty command', ['prove', '--'], {}, /Put the command to run after --/],
    ['something that isn\'t a URL', ['prove', 'not a url'], {}, /isn't a URL/],
    ['another scheme', ['prove', 'ftp://a.test/mcp'], {}, /Only http and https/],
    ['a token over plain http elsewhere', ['prove', 'http://a.test/mcp'], { CRUMPLE_PROVE_TOKEN: 'x' }, /plain http/],
    ['--args with no --call', ['prove', 'http://127.0.0.1:1/mcp', '--args', '{}'], {}, /--args goes with --call/],
    ['--parallel with no --call', ['prove', 'http://127.0.0.1:1/mcp', '--parallel', '2'], {}, /--parallel goes with --call/],
    ['--args that aren\'t JSON', ['prove', 'http://127.0.0.1:1/mcp', '--call', 'a', '--args', 'nope'], {}, /JSON object/],
    ['--args that aren\'t an object', ['prove', 'http://127.0.0.1:1/mcp', '--call', 'a', '--args', '[1]'], {}, /JSON object/],
    ['too many at once', ['prove', 'http://127.0.0.1:1/mcp', '--call', 'a', '--parallel', '51'], {}, /--parallel should be a whole number from 1 to 50/],
    ['a budget too big', ['prove', 'http://127.0.0.1:1/mcp', '--max-requests', '501'], {}, /--max-requests should be/],
    ['a budget of nothing', ['prove', 'http://127.0.0.1:1/mcp', '--max-requests', '0'], {}, /--max-requests should be/],
    ['a timeout that isn\'t a number', ['prove', 'http://127.0.0.1:1/mcp', '--timeout-ms', 'soon'], {}, /--timeout-ms should be/],
  ])('refuses %s', async (_name, argv, env, message) => {
    const { code, err } = await runOnce(argv, { env });
    expect(code).toBe(2);
    expect(err).toMatch(message);
  });

  it.each(['http://127.0.0.1:1/mcp', 'http://localhost:1/mcp', 'http://[::1]:1/mcp'])('allows a token over plain http to this machine: %s', async (url) => {
    const { code, err, out } = await runOnce(['prove', url, '--timeout-ms', '200'], { env: { CRUMPLE_PROVE_TOKEN: 'x' } });
    expect(err).toBe('');
    expect(code).toBe(1);
    expect(out).toContain('speaks-mcp');
  });
});

describe('the command', () => {
  it('writes the report in three forms, and exits 0 when nothing failed', async () => {
    const folder = tempFolder();
    const { code, out } = await runOnce(['prove', '--self', '--out', folder, '--name', 'latest'], { env: { CRUMPLE_PROVE_COMMIT: 'abc1234', CRUMPLE_PROVE_DIRTY: '0' } });
    expect(code).toBe(0);
    expect(out).toMatch(/pass\s+one-effect/);
    expect(out).toContain('13 passed, 0 failed, 0 not run');

    const markdown = readFileSync(join(folder, 'latest.md'), 'utf8');
    expect(markdown).toContain('commit abc1234.');
    expect(markdown).toContain('| C5 | A write is never applied twice | pass |');
    expect(markdown).toContain('Latitude 10');
    expect(out.toLowerCase()).not.toContain('latitude');

    const json = JSON.parse(readFileSync(join(folder, 'latest.json'), 'utf8')) as { counts: unknown; environment: { commit: string; dirty: boolean; node: string } };
    expect(json.counts).toEqual({ passed: 13, failed: 0, notRun: 0 });
    expect(json.environment).toMatchObject({ commit: 'abc1234', dirty: false, node: process.versions.node });
    expect(readFileSync(join(folder, 'latest.svg'), 'utf8')).toContain('13 passed · 0 failed · 0 not run');
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
