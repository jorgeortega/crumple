import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runOnce } from '../../tests/helpers/cli.js';
import { percentile, runLoad, type StartTarget } from '../prove/index.js';
import { startCrumple } from './prove.js';
import { wrongServer } from './wrong-server.js';

// Short steps: these show the run can tell right from wrong, and the numbers themselves come from
// npm run prove:load.
const QUICK = { stepMs: 250, warmupMs: 0, overheadCalls: 20 };

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

describe('percentile', () => {
  it('takes the nearest value at or above the rank, and never interpolates a time nobody saw', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.95)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile([7], 0.99)).toBe(7);
  });

  it('is zero with nothing to measure', () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('a load run on Crumple', () => {
  it('measures all three things, and finds no problems', async () => {
    const result = await runLoad(startCrumple, QUICK);
    expect(result.problems).toEqual([]);

    expect(result.overhead.direct.calls).toBe(20);
    expect(result.overhead.through.calls).toBe(20);
    expect(result.overhead.through.failed).toBe(0);
    expect(result.overhead.through.p50Ms).toBeGreaterThan(0);
    expect(result.overhead.reachedApi).toBe(40);

    expect(result.throughput.map((step) => step.concurrency)).toEqual([1, 10, 50]);
    for (const step of result.throughput) {
      expect(step.calls).toBeGreaterThan(0);
      expect(step.failed).toBe(0);
      expect(step.perSecond).toBeGreaterThan(0);
    }

    expect(result.noisy.quietAlone.failed).toBe(0);
    expect(result.noisy.quietDuring.failed).toBe(0);
    expect(result.noisy.quietDuring.calls).toBeGreaterThan(0);
    expect(result.noisy.floodRefused).toBeGreaterThan(0);
    expect(result.noisy.floodOther).toBe(0);
  }, 30_000);
});

describe('a load run can fail', () => {
  it('fails on a server with no limits, because nothing gets refused', async () => {
    const result = await runLoad(wrongServer, QUICK);
    expect(result.noisy.floodRefused).toBe(0);
    expect(result.problems.join(' ')).toContain('Nothing was refused');
  }, 30_000);

  it('says fast numbers show nothing if the calls never reached the API', async () => {
    const answeringFromNowhere: StartTarget = async (setup) => {
      const target = await startCrumple(setup);
      return { ...target, upstream: { ...target.upstream, requests: () => [] } };
    };
    const result = await runLoad(answeringFromNowhere, QUICK);
    expect(result.problems.join(' ')).toContain('so these times show nothing');
  }, 30_000);

  it('fails when calls fail under load', async () => {
    const failing: StartTarget = (setup) => startCrumple({ ...setup, fault: 'status=503', retry: { attempts: 1 }, breaker: { minimumCalls: 100_000, windowSize: 200_000 } });
    const result = await runLoad(failing, QUICK);
    expect(result.throughput[0]?.failed).toBeGreaterThan(0);
    expect(result.problems.join(' ')).toContain('failed under load');
  }, 30_000);

  it('fails when the quiet caller is starved', async () => {
    // One slot for the whole API, so the flood really does take the quiet caller's place.
    const starving: StartTarget = (setup) => startCrumple({ ...setup, ...(setup.fault ? { limits: { perCaller: 1, queuePerCaller: 0, perUpstream: 1, queueUpstream: 0 } } : {}) });
    const result = await runLoad(starving, QUICK);
    expect(result.noisy.quietDuring.failed).toBeGreaterThan(0);
    expect(result.problems.join(' ')).toContain('other caller');
  }, 30_000);
});

describe('prove --load', () => {
  const tempFolder = (): string => {
    const folder = mkdtempSync(join(tmpdir(), 'crumple-load-'));
    folders.push(folder);
    return folder;
  };

  it('writes a dated report that states the machine, the commit and that it ran locally', async () => {
    const folder = tempFolder();
    const { code, out } = await runOnce(['prove', '--load', '--out', folder, '--step-ms', '250'], { env: { CRUMPLE_PROVE_COMMIT: 'abc1234', CRUMPLE_PROVE_DIRTY: '0' } });
    expect(code).toBe(0);
    expect(out).toContain('concurrent');

    const date = new Date().toISOString().slice(0, 10);
    const markdown = readFileSync(join(folder, `load-${date}.md`), 'utf8');
    expect(markdown).toContain('commit abc1234');
    expect(markdown).toMatch(/GB, Node \d+/);
    expect(markdown).toContain('ran locally');
    expect(markdown).toContain('one Node process');
    expect(markdown).toContain('nothing about production');
    expect(markdown).toContain('Cloudflare');

    const json = JSON.parse(readFileSync(join(folder, `load-${date}.json`), 'utf8')) as { environment: { commit: string }; throughput: unknown[] };
    expect(json.environment.commit).toBe('abc1234');
    expect(json.throughput).toHaveLength(3);
  }, 30_000);

  it('can\'t be combined with something else to check, and checks its step', async () => {
    expect((await runOnce(['prove', '--load', '--self'])).code).toBe(2);
    expect((await runOnce(['prove', '--load', 'https://example.test/mcp'])).code).toBe(2);
    const step = await runOnce(['prove', '--load', '--step-ms', 'soon']);
    expect(step.code).toBe(2);
    expect(step.err).toContain('--step-ms');
    expect((await runOnce(['prove', '--self', '--step-ms', '100'])).code).toBe(2);
  });

  it('is in the help', async () => {
    expect((await runOnce(['--help'])).out).toMatch(/prove --load\s+\S/);
  });
});
