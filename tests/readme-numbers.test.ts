import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runOnce } from './helpers/cli.js';

// The README's numbers come from proof/, never from a person. Each generated block is worked out here
// from the report it quotes, and this fails when they differ. To update them after a new report:
//   UPDATE_README=1 npx vitest run tests/readme-numbers.test.ts

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const README = join(ROOT, 'README.md');
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

interface Latest {
  startedAt: string;
  environment: { commit: string; os: string; cpu: string; memoryGb: number; node: string };
  claims: { id: string; text: string; state: string; checks: string[] }[];
}
interface Evals {
  startedAt: string;
  model: string;
  reps: number;
  totals: { input: number; output: number; costUsd: number };
  doNothing: { passes: number; of: number };
  results: { id: string; passed: number; graded: number }[];
}
interface Timing { p50Ms: number; p95Ms: number; calls: number; failed: number }
interface Load {
  startedAt: string;
  overhead: { addedP50Ms: number; addedP95Ms: number };
  throughput: { concurrency: number; perSecond: number; failed: number }[];
  noisy: { floodConcurrency: number; floodRefused: number; quietAlone: Timing; quietDuring: Timing };
}

const day = (timestamp: string): string => timestamp.slice(0, 10);

function claimsBlock(): string {
  const { startedAt, environment: { commit, os, cpu, memoryGb, node }, claims } = readJson('proof/latest.json') as Latest;
  const passed = claims.filter(({ state }) => state === 'pass').length;
  return [
    `**${String(passed)} of ${String(claims.length)} claims passed**, at commit \`${commit}\` on ${day(startedAt)} (${os}, ${cpu}, ${String(memoryGb)} GB, Node ${node}).`,
    '',
    '| | Claim | Result | Checked by |',
    '|---|---|---|---|',
    ...claims.map(({ id, text, state, checks }) => `| ${id} | ${text} | ${state} | ${checks.map((check) => `\`${check}\``).join(', ')} |`),
  ].join('\n');
}

function evalsBlock(): string {
  const { startedAt, model, reps, totals, doNothing, results } = readJson('proof/evals-2026-11-06.json') as Evals;
  // A scripted scenario runs once, with no model, and shouldn't count as evidence about one.
  const models = results.filter(({ graded }) => graded === reps);
  const passed = models.reduce((sum, { passed: count }) => sum + count, 0);
  const graded = models.reduce((sum, { graded: count }) => sum + count, 0);
  return `\`${model}\`, ${String(reps)} runs of each of ${String(models.length)} scenarios: **${String(passed)} of ${String(graded)} model runs passed**, for $${totals.costUsd.toFixed(4)} (${String(totals.input)} tokens in, ${String(totals.output)} out), on ${day(startedAt)}. A model that does nothing would pass ${String(doNothing.passes)} of ${String(doNothing.of)}.`;
}

function loadBlock(): string {
  const { startedAt, overhead, throughput, noisy } = readJson('proof/load-2026-11-05.json') as Load;
  const busiest = throughput.at(-1);
  if (!busiest) throw new Error('The load report has no throughput.');
  const { quietDuring, quietAlone } = noisy;
  const through = quietDuring.calls - quietDuring.failed;
  return `Crumple added ${String(overhead.addedP50Ms)} ms at p50 and ${String(overhead.addedP95Ms)} ms at p95 to a call. ${String(busiest.concurrency)} concurrent callers got ${String(busiest.perSecond)} calls/s, with ${String(busiest.failed)} failed. While ${String(noisy.floodConcurrency)} callers on one key flooded a slow API, ${String(noisy.floodRefused)} of their calls were refused, and another caller got ${String(through)} of ${String(quietDuring.calls)} through, at a p95 of ${String(quietDuring.p95Ms)} ms against ${String(quietAlone.p95Ms)} ms alone. On ${day(startedAt)}.`;
}

const BLOCKS: Record<string, () => string> = { claims: claimsBlock, evals: evalsBlock, load: loadBlock };

const block = (name: string): RegExp => new RegExp(`(<!-- generated:${name} -->\\n)[\\s\\S]*?(\\n<!-- /generated -->)`);

if (process.env.UPDATE_README === '1') {
  let text = readFileSync(README, 'utf8');
  for (const [name, render] of Object.entries(BLOCKS)) text = text.replace(block(name), (_, open: string, close: string) => `${open}${render()}${close}`);
  writeFileSync(README, text);
}

const readme = readFileSync(README, 'utf8');
const bodyOf = (name: string): string | undefined => block(name).exec(readme)?.[0].split('\n').slice(1, -1).join('\n');

describe('the README', () => {
  it.each(Object.keys(BLOCKS))('quotes the %s report exactly', (name) => {
    expect(bodyOf(name)).toBe(BLOCKS[name]?.());
  });

  it('quotes the comparison from a real run of the demo', async () => {
    const { out, code } = await runOnce(['demo']);
    expect(code).toBe(0);
    const table = bodyOf('demo')?.split('\n').slice(1, -1) ?? [];
    expect(table).toHaveLength(3);
    for (const row of table) expect(out).toContain(row);
  }, 60_000);

  it('states no measured number outside a generated block', () => {
    const prose = readme
      .replace(/<!-- generated:[\s\S]*?<!-- \/generated -->/g, '')
      .replace(/```[\s\S]*?```/g, '');
    // "up to $100" is an example of a rule Crumple can't express, and not a result.
    const measured = prose.replace('up to $100', '').match(/\$\d[\d.]*|\b\d[\d,.]* ?(?:ms|tokens?|calls\/s)\b|\b\d+ of \d+\b|\b\d+(?:\.\d+)?%/g);
    expect(measured).toBeNull();
  });

  it('links only to files that exist', () => {
    const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] ?? '').filter((link) => !/^https?:/.test(link));
    expect(links.length).toBeGreaterThan(0);
    const missing = links.filter((link) => !existsSync(join(dirname(README), link)));
    expect(missing).toEqual([]);
  });

  it('says who wrote the code', () => {
    expect(readme).toContain('an AI coding agent, wrote the code');
  });

  it('says the limits the specs promised it would', () => {
    for (const limit of ['It isn\'t production-proven', 'It doesn\'t prevent one', 'Permissions stop at the tool', 'It can\'t make an unsafe API safe', 'it says nothing about production load', 'It isn\'t a replacement for agentgateway']) {
      expect(readme.replace(/\*\*/g, '')).toContain(limit);
    }
  });

  it('never calls itself production-proven or battle-tested', () => {
    expect(readme).not.toMatch(/battle-tested/i);
    expect(readme.replace('It isn\'t production-proven', '')).not.toMatch(/production-proven/i);
  });
});
