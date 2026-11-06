import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { harness, runOnce } from '../../tests/helpers/cli.js';
import { calling, finished, reply, toolUse } from '../../tests/helpers/fake-claude.js';

// The whole command, with the API faked behind io.fetch. Crumple and fault-api are real. No key, no
// network, and nothing here is a real result.

const folders: string[] = [];
const tempFolder = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'crumple-eval-'));
  folders.push(folder);
  return folder;
};
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const KEY = 'test-key-that-must-stay-hidden';

const SCENARIO = { id: 'charge', kind: 'behaviour', task: 'Charge customer cus_1 $50.', key: 'write', expect: { payments: [{ customerId: 'cus_1', amountCents: 5000 }] } };
const OBSERVE = { id: 'look', kind: 'observation', observedAs: 'charged', task: 'Look around.', key: 'read', expect: {} };

function scenarioFolder(...scenarios: Record<string, unknown>[]): string {
  const folder = tempFolder();
  for (const scenario of scenarios) writeFileSync(join(folder, `${String(scenario.id)}.json`), JSON.stringify(scenario));
  return folder;
}

/** Answers a charge correctly, each time, for as many runs as anyone asks. */
const fakeApi: typeof fetch = (input, init) => {
  if (!(input as string).startsWith('https://api.anthropic.com/')) return fetch(input, init);
  const { messages } = JSON.parse(init?.body as string) as { messages: unknown[] };
  const body = messages.length === 1
    ? calling(toolUse('p', 'createPayment', { body: { customerId: 'cus_1', amountCents: 5000 } }))
    : finished('Charged.');
  return Promise.resolve(new Response(JSON.stringify(body)));
};

const LIVE_ENV = { ANTHROPIC_API_KEY: KEY };

describe('eval, replaying', () => {
  it('runs the scripted scenario with no key, and exits 1 rather than passing on nothing', async () => {
    const shipped = fileURLToPath(new URL('../../scenarios/', import.meta.url));
    const folder = tempFolder();
    for (const name of readdirSync(shipped).filter((file) => file.endsWith('.json'))) copyFileSync(join(shipped, name), join(folder, name));

    const { code, out, err } = await runOnce(['eval', folder]);
    expect(err).toBe('');
    expect(code).toBe(1);
    expect(out).toContain('nothing spent');
    expect(out).toMatch(/safety\s+obedient-agent\s+1 of 1\s+scripted, no model/);
    expect(out).toMatch(/behaviour\s+lost-responses\s+no recording/);
    expect(out).toContain('14 scenarios have no recording');
    expect(out).toContain('A model that does nothing would pass 4 of 14.');
    expect(out).toContain('says nothing about how often');
    expect(out).toContain('The gate fails.');
  }, 30_000);

  it('passes on the recordings in the package, with no key, spending nothing', async () => {
    const { code, out, err } = await runOnce(['eval']);
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toMatch(/behaviour\s+lost-responses\s+1 of 1/);
    expect(out).toContain('Nothing was spent. When they were recorded:');
    expect(out).toContain('says nothing about how often');
    expect(out).toContain('The gate passes.');
  }, 30_000);

  it('can run just the ones asked for, and pass', async () => {
    const { code, out } = await runOnce(['eval', '--only', 'obedient-agent']);
    expect(code).toBe(0);
    expect(out).toContain('The gate passes.');
  }, 30_000);

  it('replays a recording it finds, and fails when a broken description makes it stale', async () => {
    const folder = scenarioFolder(SCENARIO);
    const io = harness({ env: LIVE_ENV, fetch: fakeApi }).io;
    const { run } = await import('./main.js');
    expect(await run(['eval', folder, '--live', '--record', '--reps', '1'], io)).toBe(0);
    expect(existsSync(join(folder, 'recordings', 'charge.json'))).toBe(true);

    const replayed = await runOnce(['eval', folder]);
    expect(replayed.code).toBe(0);
    expect(replayed.out).toMatch(/charge\s+1 of 1/);

    const broken = await runOnce(['eval', folder, '--break-descriptions']);
    expect(broken.code).toBe(1);
    expect(broken.out).toContain('with every tool description broken');
    expect(broken.out).toContain('the definition of tool');
    expect(broken.out).toContain('stale');
  }, 30_000);

  it('says what\'s wrong with a recording that can\'t be read', async () => {
    const folder = scenarioFolder(SCENARIO);
    const io = harness({ env: LIVE_ENV, fetch: fakeApi }).io;
    await io.writeFile(join(folder, 'recordings', 'charge.json'), '{');
    const { code, err } = await runOnce(['eval', folder]);
    expect(code).toBe(1);
    expect(err).toContain('isn\'t valid JSON');
  });
});

describe('eval --live', () => {
  it('says what it\'ll spend first, runs each scenario 5 times, and reports with no key in sight', async () => {
    const folder = scenarioFolder(SCENARIO, OBSERVE);
    const out = tempFolder();
    const transcripts = tempFolder();
    const { code, out: printed, err } = await runOnce(['eval', folder, '--live', '--out', out, '--transcripts', transcripts], { env: { ...LIVE_ENV, CRUMPLE_PROVE_COMMIT: 'abc1234' }, fetch: fakeApi });
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(printed.indexOf('stops at $1')).toBeLessThan(printed.indexOf('charge'));
    expect(printed).toMatch(/charge\s+5 of 5/);
    expect(printed).toMatch(/look\s+charged in \d of \d runs/);
    expect(printed).toContain('Counts, not percentages');
    expect(printed).toContain('The gate passes.');
    expect(printed).not.toContain(KEY);

    const date = new Date().toISOString().slice(0, 10);
    const markdown = readFileSync(join(out, `evals-${date}.md`), 'utf8');
    expect(markdown).toContain('claude-haiku-5-5, 5 runs each');
    expect(markdown).toContain('commit abc1234');
    expect(markdown).toContain('never fails the gate');
    expect(markdown).not.toContain(KEY);

    const json = JSON.parse(readFileSync(join(out, `evals-${date}.json`), 'utf8')) as { gate: string; model: string; doNothing: { passes: number; of: number }; totals: { runs: number }; results: { id: string; runs: unknown[] }[] };
    expect(json).toMatchObject({ gate: 'pass', model: 'claude-haiku-5-5', doNothing: { passes: 1, of: 2 } });
    expect(json.results.find((result) => result.id === 'charge')?.runs).toHaveLength(5);
    expect(JSON.stringify(json)).not.toContain('Charged.');

    const saved = readdirSync(join(transcripts, date));
    expect(saved).toContain('charge-5.json');
    expect(readFileSync(join(transcripts, date, 'charge-1.json'), 'utf8')).toContain('Charged.');
    expect(existsSync(join(folder, 'recordings'))).toBe(false);
  }, 30_000);

  it('keeps one passing run per scenario when asked, and only a passing one', async () => {
    const folder = scenarioFolder(SCENARIO, { ...SCENARIO, id: 'never', expect: { payments: [] } });
    const { code, out } = await runOnce(['eval', folder, '--live', '--record', '--reps', '2'], { env: LIVE_ENV, fetch: fakeApi });
    expect(code).toBe(1);
    expect(out).toContain('it isn\'t a pass rate');
    expect(existsSync(join(folder, 'recordings', 'never.json'))).toBe(false);
    const recording = JSON.parse(readFileSync(join(folder, 'recordings', 'charge.json'), 'utf8')) as { source: string; apiVersion: string };
    expect(recording).toMatchObject({ source: 'live', apiVersion: '2026-10-21', commit: 'unknown' });
    expect(readFileSync(join(folder, 'recordings', 'charge.json'), 'utf8')).not.toContain(KEY);
  }, 30_000);

  it('refuses to save a recording holding the key', async () => {
    const folder = scenarioFolder({ ...SCENARIO, task: `Charge customer cus_1 $50. ${KEY}` });
    const { code, err } = await runOnce(['eval', folder, '--live', '--record', '--reps', '1'], { env: LIVE_ENV, fetch: fakeApi });
    expect(code).toBe(1);
    expect(err).toContain('wasn\'t saved');
    expect(existsSync(join(folder, 'recordings'))).toBe(false);
  }, 30_000);

  it('stops at the budget, reports the rest as not run, and doesn\'t pass', async () => {
    const folder = scenarioFolder(SCENARIO);
    const expensive: typeof fetch = (input, init) => {
      if (!(input as string).startsWith('https://api.anthropic.com/')) return fetch(input, init);
      const { messages } = JSON.parse(init?.body as string) as { messages: unknown[] };
      const usage = { input_tokens: 1_000, output_tokens: 8_000 };
      const body = messages.length === 1 ? reply([toolUse('p', 'createPayment', { body: { customerId: 'cus_1', amountCents: 5000 } })], 'tool_use', { usage }) : reply([{ type: 'text', text: 'Charged.' }], 'end_turn', { usage });
      return Promise.resolve(new Response(JSON.stringify(body)));
    };
    const { code, out } = await runOnce(['eval', folder, '--live', '--max-usd', '0.05', '--reps', '50'], { env: LIVE_ENV, fetch: expensive });
    expect(code).toBe(1);
    expect(out).toMatch(/charge\s+\d+ of 50/);
    expect(out).toContain('not run');
    expect(out).toContain('The budget ran out.');
  }, 60_000);

  it('runs the scripted scenario once, however many runs were asked for', async () => {
    const { code, out } = await runOnce(['eval', '--live', '--only', 'obedient-agent'], { env: LIVE_ENV, fetch: fakeApi });
    expect(code).toBe(0);
    expect(out).toMatch(/obedient-agent\s+1 of 1/);
  }, 30_000);

  it('can run with every description broken, to see whether a model does worse', async () => {
    const folder = scenarioFolder(SCENARIO);
    const { out } = await runOnce(['eval', folder, '--live', '--reps', '1', '--break-descriptions'], { env: LIVE_ENV, fetch: fakeApi });
    expect(out).toContain('with every tool description broken');
  }, 30_000);
});

describe('eval, used wrongly', () => {
  it.each<[string, string[], Record<string, string>, string]>([
    ['--live with no key', ['--live'], {}, 'ANTHROPIC_API_KEY'],
    ['a model with no price', ['--live', '--model', 'gpt-9'], LIVE_ENV, 'no price for gpt-9'],
    ['bad reps', ['--live', '--reps', '0'], LIVE_ENV, '--reps'],
    ['fractional reps', ['--live', '--reps', '1.5'], LIVE_ENV, '--reps'],
    ['too many reps', ['--live', '--reps', '51'], LIVE_ENV, '--reps'],
    ['a bad budget', ['--live', '--max-usd', 'lots'], LIVE_ENV, '--max-usd'],
    ['--record with no --live', ['--record'], {}, '--record goes with --live'],
    ['--reps with no --live', ['--reps', '2'], {}, '--reps goes with --live'],
    ['--max-usd with no --live', ['--max-usd', '2'], {}, '--max-usd goes with --live'],
    ['--model with no --live', ['--model', 'x'], {}, '--model goes with --live'],
    ['--transcripts with no --live', ['--transcripts', 'x'], {}, '--transcripts goes with --live'],
    ['recording a broken server', ['--live', '--record', '--break-descriptions'], LIVE_ENV, 'broken server'],
    ['an unknown scenario', ['--only', 'nope'], {}, 'no scenario called nope'],
    ['two folders', ['a', 'b'], {}, 'one scenarios folder'],
    ['an unknown flag', ['--fast'], {}, '--fast'],
  ])('%s exits 2, and sends nothing', async (_name, args, env, message) => {
    const sent: string[] = [];
    const { code, err } = await runOnce(['eval', ...args], {
      env,
      fetch: (input) => {
        sent.push(input as string);
        return Promise.reject(new Error('Nothing should be sent.'));
      },
    });
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(sent).toEqual([]);
  });

  it('says so when the folder can\'t be read or has nothing in it', async () => {
    const missing = await runOnce(['eval', join(tmpdir(), 'crumple-no-such-folder')]);
    expect(missing).toMatchObject({ code: 1 });
    expect(missing.err).toContain('Check the path');
    const empty = await runOnce(['eval', tempFolder()]);
    expect(empty.err).toContain('no scenarios');
  });

  it('names a scenario that\'s wrong, rather than checking nothing', async () => {
    const { code, err } = await runOnce(['eval', scenarioFolder({ ...SCENARIO, expect: { payment: [] } })]);
    expect(code).toBe(1);
    expect(err).toContain('Scenario charge: expect has an unknown field, payment');
  });

  it('is in the help', async () => {
    const { out } = await runOnce(['--help']);
    expect(out).toContain('eval');
    expect(out).toContain('--max-usd');
  });
});
