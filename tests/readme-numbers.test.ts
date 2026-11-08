import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BREAKER } from '../src/executor/breaker.js';
import { DEFAULT_ATTEMPT_TIMEOUT_MS, DEFAULT_ATTEMPTS, DEFAULT_BACKOFF, DEFAULT_DEADLINE_MS, MAX_RESPONSE_BYTES } from '../src/executor/call.js';
import { DEFAULT_LIMITS } from '../src/executor/limits.js';
import { runOnce } from './helpers/cli.js';

// The README's numbers come from proof/ and the code, never from a person. Each generated block is
// worked out here from what it quotes, and this fails when they differ. To update them:
//   UPDATE_README=1 npx vitest run tests/readme-numbers.test.ts

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const README = join(ROOT, 'README.md');
const readText = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const readJson = (path: string): unknown => JSON.parse(readText(path));

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

function defaultsBlock(): string {
  const { windowSize, minimumCalls, failureRate, openMs } = DEFAULT_BREAKER;
  const { perCaller, queuePerCaller, perUpstream, queueUpstream } = DEFAULT_LIMITS;
  const rows: [string, string, string][] = [
    ['Deadline for a whole call', `${String(DEFAULT_DEADLINE_MS)} ms`, '`deadlineMs`'],
    ['Timeout for one attempt', `${String(DEFAULT_ATTEMPT_TIMEOUT_MS)} ms`, '`attemptTimeoutMs`'],
    ['Attempts', String(DEFAULT_ATTEMPTS), '`retry.attempts`'],
    ['Backoff', `doubling from ${String(DEFAULT_BACKOFF.baseMs)} ms, capped at ${String(DEFAULT_BACKOFF.capMs)} ms`, '`retry.baseMs`, `retry.capMs`'],
    ['Calls at once, per caller', `${String(perCaller)}, then ${String(queuePerCaller)} queued`, '`limits.perCaller`, `limits.queuePerCaller`'],
    ['Calls at once, to the API', `${String(perUpstream)}, then ${String(queueUpstream)} queued`, '`limits.perUpstream`, `limits.queueUpstream`'],
    ['Circuit breaker opens', `at ${String(failureRate * 100)}% failures of the last ${String(windowSize)} calls, after at least ${String(minimumCalls)}`, ''],
    ['Circuit breaker stays open', `${String(openMs)} ms, then tries one call`, ''],
    ['Largest answer from the API', `${String(MAX_RESPONSE_BYTES)} bytes`, ''],
  ];
  return ['| | Default | Config field |', '|---|---|---|', ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}

async function helpBlock(): Promise<string> {
  const { out } = await runOnce(['--help']);
  return ['```', out.trimEnd(), '```'].join('\n');
}

const BLOCKS: Record<string, () => string | Promise<string>> = { defaults: defaultsBlock, claims: claimsBlock, evals: evalsBlock, load: loadBlock, help: helpBlock };

const block = (name: string): RegExp => new RegExp(`(<!-- generated:${name} -->\\n)[\\s\\S]*?(<!-- /generated -->)`);

if (process.env.UPDATE_README === '1') {
  let text = readFileSync(README, 'utf8');
  for (const [name, render] of Object.entries(BLOCKS)) {
    const rendered = await render();
    text = text.replace(block(name), (_, open: string, close: string) => `${open}${rendered}\n${close}`);
  }
  writeFileSync(README, text);
}

const readme = readFileSync(README, 'utf8');
const bodyOf = (name: string): string | undefined => block(name).exec(readme)?.[0].split('\n').slice(1, -1).join('\n');

/** GitHub's anchors: lower case, spaces to dashes, and punctuation gone. */
const anchor = (heading: string): string => heading.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

describe('the README', () => {
  it.each(Object.keys(BLOCKS))('quotes %s exactly', async (name) => {
    expect(bodyOf(name)).toBe(await BLOCKS[name]?.());
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
    // These two are rules, and not results: a rule Crumple can't express, and the coverage bars.
    const measured = prose.replace('up to $100', '').replace('The bar is 85% branch coverage, and 95%', '').match(/\$\d[\d.]*|\b\d[\d,.]* ?(?:ms|tokens?|calls\/s)\b|\b\d+ of \d+\b|\b\d+(?:\.\d+)?%/g);
    expect(measured).toBeNull();
  });

  it('links only to files and headings that exist', () => {
    const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] ?? '').filter((link) => !/^https?:/.test(link));
    expect(links.length).toBeGreaterThan(0);
    const headings = new Set([...readme.matchAll(/^#{1,6} (.+)$/gm)].map((match) => anchor(match[1] ?? '')));
    const missing = links.filter((link) => (link.startsWith('#') ? !headings.has(link.slice(1)) : !existsSync(join(dirname(README), link))));
    expect(missing).toEqual([]);
  });

  it('documents every error code the executor can return', () => {
    const union = /export type ErrorCode =([\s\S]*?);/.exec(readText('src/executor/errors.ts'))?.[1] ?? '';
    const codes = [...union.matchAll(/'(\w+)'/g)].map((match) => match[1]);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect(readme).toContain(`| \`${String(code)}\` |`);
  });

  it('documents every failure fault-api can be asked for', () => {
    const faults = readText('src/fault-api/faults.ts');
    const numbers = /const NUMBERS[\s\S]*?\n};/.exec(faults)?.[0] ?? '';
    const flags = /const FLAGS[\s\S]*?\n};/.exec(faults)?.[0] ?? '';
    const names = [...[...numbers.matchAll(/^ {2}'?([a-z-]+)'?\(fault/gm)].map((match) => match[1]), ...[...flags.matchAll(/^ {2}'?([a-z-]+)'?:/gm)].map((match) => match[1])];
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(readme).toMatch(new RegExp(`\\| \`${String(name)}(=\\d+)?\` \\|`));
  });

  it('names every module on the capability map', () => {
    const map = readText('CAPABILITY-MAP.md');
    const modules = [...map.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]);
    expect(modules.length).toBeGreaterThan(10);
    for (const module of modules) expect(readme).toContain(`| \`${String(module)}\` |`);
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
