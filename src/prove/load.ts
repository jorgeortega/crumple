import { callResult, createBudget, createHttpTransport, openSession, type Session } from '../mcp-client/client.js';
import { CREDIT_MARKDOWN, type Environment } from './report.js';
import { structured, type StartTarget, type Target, type TargetSetup } from './self-checks.js';

// Numbers for "how much can it take", on the machine in front of you. Most of this is measuring, but
// a few things have to hold, and a run where they don't says so and exits 1. Every number goes in the
// report with the machine and the commit, and with what it doesn't show.

export interface LoadOptions {
  /** How long each measured step runs. */
  stepMs?: number;
  /** Calls before measuring starts, which aren't counted, so a cold start doesn't skew the numbers. */
  warmupMs?: number;
  overheadCalls?: number;
}

export interface Latency {
  calls: number;
  failed: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface ThroughputStep extends Latency {
  concurrency: number;
  perSecond: number;
}

export interface LoadResult {
  stepMs: number;
  /** reachedApi counts both sides. Fast numbers from calls that never arrived would show nothing. */
  overhead: { direct: Latency; through: Latency; reachedApi: number; addedP50Ms: number; addedP95Ms: number };
  throughput: ThroughputStep[];
  noisy: {
    delayMs: number;
    floodConcurrency: number;
    floodAnswered: number;
    floodRefused: number;
    floodOther: number;
    quietAlone: Latency;
    quietDuring: Latency;
  };
  /** Things that had to hold, and didn't. Empty is the only passing result. */
  problems: string[];
}

export const CONCURRENCY_STEPS = [1, 10, 50] as const;
export const FLOOD_CONCURRENCY = 100;
export const SLOW_API_MS = 200;

const CUSTOMER = { id: 'cus_1' };
// High enough that nothing is refused, because this step measures the path and not the limits.
const OPEN_LIMITS = { perCaller: 1000, queuePerCaller: 1000, perUpstream: 1000, queueUpstream: 1000 };

/** The nearest value at or above the rank. It's always a time that really happened. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(Math.ceil(sorted.length * fraction) - 1, 0);
  return sorted[rank] ?? 0;
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

function latency(samples: readonly Sample[]): Latency {
  const times = samples.filter((sample) => sample.outcome === 'ok').map((sample) => sample.ms).sort((a, b) => a - b);
  return {
    calls: samples.length,
    failed: samples.filter((sample) => sample.outcome !== 'ok').length,
    p50Ms: round(percentile(times, 0.5)),
    p95Ms: round(percentile(times, 0.95)),
    p99Ms: round(percentile(times, 0.99)),
    maxMs: round(times.at(-1) ?? 0),
  };
}

interface Sample {
  ms: number;
  outcome: 'ok' | 'overloaded' | 'other';
}

async function connect(target: Target, key: string): Promise<Session> {
  const opened = await openSession(createHttpTransport({ url: target.url, token: key, timeoutMs: 40_000, budget: createBudget() }));
  if (!opened.ok) throw new Error(`Couldn't connect: ${opened.reason}`);
  return opened.session;
}

async function callOnce(session: Session): Promise<Sample> {
  const started = performance.now();
  const result = callResult(await session.callTool('getCustomer', CUSTOMER));
  const ms = performance.now() - started;
  if (result.kind === 'result' && !result.isError) return { ms, outcome: 'ok' };
  return { ms, outcome: structured(result)?.code === 'overloaded' ? 'overloaded' : 'other' };
}

/** Each worker makes its next call when the last one ends, as an agent waiting on its tools would. */
async function drive(session: Session, concurrency: number, forMs: number): Promise<Sample[]> {
  const samples: Sample[] = [];
  const until = performance.now() + forMs;
  const worker = async (): Promise<void> => {
    while (performance.now() < until) samples.push(await callOnce(session));
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return samples;
}

async function withTarget<T>(start: StartTarget, setup: TargetSetup, run: (target: Target) => Promise<T>): Promise<T> {
  const target = await start(setup);
  try {
    return await run(target);
  } finally {
    await target.stop();
  }
}

async function measureOverhead(start: StartTarget, calls: number): Promise<LoadResult['overhead']> {
  return withTarget(start, {}, async (target) => {
    const session = await connect(target, target.keys.read);
    const directly = async (): Promise<Sample> => {
      const started = performance.now();
      const response = await fetch(`${target.upstream.url}/customers/${CUSTOMER.id}`, { headers: { authorization: `Bearer ${target.credential}` } });
      await response.text();
      return { ms: performance.now() - started, outcome: response.ok ? 'ok' : 'other' };
    };
    const direct: Sample[] = [];
    const through: Sample[] = [];
    // Turn about, so one side doesn't get a warmer process than the other.
    for (let i = 0; i < calls; i += 1) {
      direct.push(await directly());
      through.push(await callOnce(session));
    }
    const [directLatency, throughLatency] = [latency(direct), latency(through)];
    return {
      direct: directLatency,
      through: throughLatency,
      reachedApi: target.upstream.requests().length,
      addedP50Ms: round(throughLatency.p50Ms - directLatency.p50Ms),
      addedP95Ms: round(throughLatency.p95Ms - directLatency.p95Ms),
    };
  });
}

async function measureThroughput(start: StartTarget, concurrency: number, stepMs: number, warmupMs: number): Promise<ThroughputStep> {
  return withTarget(start, { limits: OPEN_LIMITS }, async (target) => {
    const session = await connect(target, target.keys.read);
    if (warmupMs > 0) await drive(session, concurrency, warmupMs);
    const started = performance.now();
    const samples = await drive(session, concurrency, stepMs);
    const elapsedMs = performance.now() - started;
    return { concurrency, perSecond: Math.round(samples.filter((sample) => sample.outcome === 'ok').length / (elapsedMs / 1000)), ...latency(samples) };
  });
}

async function measureNoisy(start: StartTarget, stepMs: number): Promise<LoadResult['noisy']> {
  const setup: TargetSetup = { fault: `delay=${String(SLOW_API_MS)}` };
  const quietAlone = await withTarget(start, setup, async (target) => latency(await drive(await connect(target, target.keys.other), 1, stepMs)));

  return withTarget(start, setup, async (target) => {
    const noisy = await connect(target, target.keys.read);
    const quiet = await connect(target, target.keys.other);
    const [flood, quietSamples] = await Promise.all([drive(noisy, FLOOD_CONCURRENCY, stepMs), drive(quiet, 1, stepMs)]);
    return {
      delayMs: SLOW_API_MS,
      floodConcurrency: FLOOD_CONCURRENCY,
      floodAnswered: flood.filter((sample) => sample.outcome === 'ok').length,
      floodRefused: flood.filter((sample) => sample.outcome === 'overloaded').length,
      floodOther: flood.filter((sample) => sample.outcome === 'other').length,
      quietAlone,
      quietDuring: latency(quietSamples),
    };
  });
}

function findProblems(result: Omit<LoadResult, 'problems'>): string[] {
  const problems: string[] = [];
  const { overhead, throughput, noisy } = result;
  if (overhead.direct.failed > 0 || overhead.through.failed > 0) problems.push(`${String(overhead.direct.failed + overhead.through.failed)} calls failed under load while measuring overhead.`);
  const made = overhead.direct.calls + overhead.through.calls;
  if (overhead.reachedApi !== made) problems.push(`${String(made)} calls were made and the API saw ${String(overhead.reachedApi)}, so these times show nothing.`);
  for (const step of throughput) {
    if (step.failed > 0) problems.push(`At ${String(step.concurrency)} concurrent, ${String(step.failed)} of ${String(step.calls)} calls failed under load.`);
  }
  if (noisy.quietDuring.calls === 0) problems.push('During the flood, the other caller made no calls, so this shows nothing.');
  if (noisy.quietDuring.failed > 0) problems.push(`During the flood, ${String(noisy.quietDuring.failed)} of the other caller's ${String(noisy.quietDuring.calls)} calls failed.`);
  if (noisy.floodRefused === 0) problems.push('Nothing was refused, so the excess was let through or queued without limit.');
  if (noisy.floodOther > 0) problems.push(`${String(noisy.floodOther)} flooding calls got neither an answer nor a clear refusal.`);
  return problems;
}

export async function runLoad(start: StartTarget, options: LoadOptions = {}): Promise<LoadResult> {
  const { stepMs = 5_000, warmupMs = 1_000, overheadCalls = 500 } = options;
  const overhead = await measureOverhead(start, overheadCalls);
  // One at a time: these measure time, and they shouldn't compete with each other.
  const throughput: ThroughputStep[] = [];
  for (const concurrency of CONCURRENCY_STEPS) throughput.push(await measureThroughput(start, concurrency, stepMs, warmupMs));
  const noisy = await measureNoisy(start, stepMs);
  const measured = { stepMs, overhead, throughput, noisy };
  return { ...measured, problems: findProblems(measured) };
}

export interface LoadReport extends LoadResult {
  startedAt: string;
  durationMs: number;
  environment: Environment;
}

const ms = (value: number): string => `${String(value)} ms`;

function throughputRows(steps: readonly ThroughputStep[]): string[][] {
  return steps.map((step) => [String(step.concurrency), String(step.perSecond), ms(step.p50Ms), ms(step.p95Ms), ms(step.p99Ms), String(step.failed)]);
}

function noisySentence({ noisy }: LoadResult): string {
  return `${String(noisy.floodConcurrency)} concurrent callers on one key flooded an API taking ${String(noisy.delayMs)} ms. ${String(noisy.floodAnswered)} of their calls were answered and ${String(noisy.floodRefused)} refused with overloaded, on the default limits. The other caller got ${String(noisy.quietDuring.calls - noisy.quietDuring.failed)} of ${String(noisy.quietDuring.calls)} through.`;
}

const verdict = (report: LoadResult): string => (report.problems.length === 0 ? 'Everything that had to hold, held.' : `${String(report.problems.length)} didn't hold.`);

export function renderLoadTerminal(report: LoadReport): string {
  const { overhead, noisy } = report;
  const lines = [
    'crumple-mcp prove --load  on this machine, not production',
    '',
    `  Added per call  p50 ${ms(overhead.addedP50Ms)}, p95 ${ms(overhead.addedP95Ms)}, next to calling the API directly`,
    '',
    '  concurrent  calls/s  p50       p95       p99       failed',
  ];
  for (const [concurrency = '', perSecond = '', p50 = '', p95 = '', p99 = '', failed = ''] of throughputRows(report.throughput)) {
    lines.push(`  ${concurrency.padEnd(11)} ${perSecond.padEnd(8)} ${p50.padEnd(9)} ${p95.padEnd(9)} ${p99.padEnd(9)} ${failed}`);
  }
  lines.push(
    '',
    `  ${noisySentence(report)}`,
    `  Its p95 was ${ms(noisy.quietDuring.p95Ms)}, and ${ms(noisy.quietAlone.p95Ms)} with nobody else there.`,
    '',
  );
  for (const problem of report.problems) lines.push(`  FAIL  ${problem}`);
  lines.push(`  ${verdict(report)} ${(report.durationMs / 1000).toFixed(1)} s.`);
  return lines.join('\n');
}

function table(header: string[], rows: string[][]): string[] {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)];
}

function environmentSentence({ version, commit, dirty, os, cpu, memoryGb, node }: Environment): string {
  const source = commit ? `commit ${commit}${dirty ? ' with uncommitted changes' : ''}` : `version ${version}`;
  return `${source}. ${os}, ${cpu}, ${String(memoryGb)} GB, Node ${node}.`;
}

export function renderLoadMarkdown(report: LoadReport): string {
  const { overhead, noisy } = report;
  const seconds = String(report.stepMs / 1000);
  return [
    `# crumple-mcp load run, ${report.startedAt.slice(0, 10)}`,
    '',
    `**${verdict(report)}**`,
    '',
    `Run ${report.startedAt}, taking ${(report.durationMs / 1000).toFixed(1)} s: ${environmentSentence(report.environment)}`,
    '',
    '## How to read this',
    '',
    'This ran locally, on the one machine above. It says nothing about production, and nothing about Cloudflare\'s network or Workers.',
    '',
    '- **Everything shares one Node process:** the program making the calls, Crumple and the API behind it, on one thread. So these numbers include the cost of all three, and they aren\'t Crumple\'s limit.',
    '- **The API does no real work and is a socket away.** Added latency is the useful number. A real API\'s time comes on top.',
    '- **Reads only, and no database.** Writes and `--db` aren\'t measured.',
    `- **One run, ${seconds} s a step.** Run it again and the numbers will move. It's not a soak test, so it can't show slow leaks.`,
    '',
    '## What Crumple adds to one call',
    '',
    `${String(overhead.through.calls)} calls each way, one at a time, taking turns, and the API saw all ${String(overhead.reachedApi)}. "Through Crumple" also counts the test client's MCP encoding, so this is what an agent would see.`,
    '',
    ...table(['', 'p50', 'p95', 'p99', 'failed'], [
      ['The API directly', ms(overhead.direct.p50Ms), ms(overhead.direct.p95Ms), ms(overhead.direct.p99Ms), String(overhead.direct.failed)],
      ['Through Crumple', ms(overhead.through.p50Ms), ms(overhead.through.p95Ms), ms(overhead.through.p99Ms), String(overhead.through.failed)],
      ['Added', ms(overhead.addedP50Ms), ms(overhead.addedP95Ms), '', ''],
    ]),
    '',
    '## Concurrent callers on a fast API',
    '',
    `Each caller makes its next call when the last one ends. ${seconds} s per row, after a warm-up that isn't counted. The limits are raised for this table so nothing is refused, because it measures the path and not the limits.`,
    '',
    ...table(['Concurrent', 'Calls/s', 'p50', 'p95', 'p99', 'Failed'], throughputRows(report.throughput)),
    '',
    '## One noisy caller and a slow API (C9)',
    '',
    `${noisySentence(report)} Limits here are the defaults, untouched.`,
    '',
    ...table(['The other caller', 'Calls', 'Failed', 'p50', 'p95', 'Slowest'], [
      ['Alone', String(noisy.quietAlone.calls), String(noisy.quietAlone.failed), ms(noisy.quietAlone.p50Ms), ms(noisy.quietAlone.p95Ms), ms(noisy.quietAlone.maxMs)],
      ['During the flood', String(noisy.quietDuring.calls), String(noisy.quietDuring.failed), ms(noisy.quietDuring.p50Ms), ms(noisy.quietDuring.p95Ms), ms(noisy.quietDuring.maxMs)],
    ]),
    '',
    'The flood is the worst case for this setup: a refused caller calls again at once, and it shares a thread with everything else.',
    '',
    ...(report.problems.length > 0 ? ['## What didn\'t hold', '', ...report.problems.map((problem) => `- ${problem}`), ''] : []),
    '---',
    '',
    CREDIT_MARKDOWN,
    '',
  ].join('\n');
}

export const renderLoadJson = (report: LoadReport): string => `${JSON.stringify(report, null, 2)}\n`;
