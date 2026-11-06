import { doNothingScore, gatePasses, type ScenarioResult } from './gate.js';
import type { Scenario } from './scenarios.js';

// What a run found, in words. Pure. Nothing here comes from a model: reasons are our own sentences, so
// a report can be shared, whatever a model or a tool's output said.

export interface EvalEnvironment {
  version: string;
  commit?: string;
  dirty?: boolean;
  os: string;
  cpu: string;
  memoryGb: number;
  node: string;
}

export interface EvalReport {
  mode: 'replay' | 'live';
  startedAt: string;
  durationMs: number;
  environment: EvalEnvironment;
  /** Live only. */
  model?: string;
  reps?: number;
  maxUsd?: number;
  brokenDescriptions: boolean;
  results: ScenarioResult[];
  scenarios: readonly Scenario[];
}

const CREDIT = 'Made with [crumple-mcp](https://github.com/jorgeortega/crumple), open source from [Latitude 10](https://latitude10.tech/platform/mcp), which also hosts MCP servers.';

function score(result: ScenarioResult): string {
  const { scenario, verdict, passed, failed, graded, rows } = result;
  if (verdict === 'not_run') return rows.length === 0 ? 'no recording' : 'not run';
  if (scenario.kind === 'observation') return `${scenario.observedAs ?? 'failed'} in ${String(failed)} of ${String(graded)} runs`;
  return `${String(passed)} of ${String(rows.length)}`;
}

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

function extras(result: ScenarioResult): string {
  const parts: string[] = [];
  if (result.scenario.scripted !== undefined) parts.push('scripted, no model');
  if (result.errors > 0) parts.push(plural(result.errors, 'error'));
  if (result.truncated > 0) parts.push(`${String(result.truncated)} cut off`);
  if (result.notRun > 0 && result.rows.length > 0) parts.push(`${String(result.notRun)} not run`);
  if (result.refused > 0) parts.push(`${String(result.refused)} refused by the model`);
  if (result.stale > 0) parts.push('stale');
  if (result.verdict === 'inconclusive') parts.push('inconclusive');
  if (result.verdict === 'fail') parts.push('FAIL');
  return parts.join(', ');
}

export function totals(results: readonly ScenarioResult[]) {
  const rows = results.flatMap((result) => result.rows).filter((row) => row.status !== 'not_run');
  const sum = (pick: (row: (typeof rows)[number]) => number): number => rows.reduce((total, row) => total + pick(row), 0);
  const unknownCost = rows.some((row) => row.costUsd === null);
  return {
    runs: rows.length,
    errors: results.reduce((total, result) => total + result.errors, 0),
    input: sum((row) => row.usage.input),
    output: sum((row) => row.usage.output),
    costUsd: unknownCost ? null : sum((row) => row.costUsd ?? 0),
    costIsAtMost: rows.some((row) => row.costIsAtMost),
  };
}

const money = (usd: number): string => (usd === 0 ? '$0' : `$${usd.toFixed(usd < 0.01 ? 6 : 4)}`);

function costLine(report: EvalReport): string {
  const { runs, errors, input, output, costUsd, costIsAtMost } = totals(report.results);
  const cost = costUsd === null ? 'cost unknown' : `${costIsAtMost ? 'at most ' : ''}${money(costUsd)}`;
  const spent = `${cost}, ${String(input)} tokens in, ${String(output)} out.`;
  const scripted = report.results.filter((result) => result.scenario.scripted !== undefined).reduce((total, result) => total + result.rows.filter((row) => row.status !== 'not_run').length, 0);
  const tally = `${plural(runs, 'run')}${scripted > 0 ? `, ${String(scripted)} of them scripted with no model` : ''}, ${plural(errors, 'error')}.`;
  // The money in a replay was spent when the recording was made. Without saying so, it reads as a bill.
  if (report.mode === 'replay') return `${tally} Nothing was spent.${input + output > 0 ? ` When they were recorded: ${spent}` : ''}`;
  return `${tally} ${spent}`;
}

function header(report: EvalReport): string {
  if (report.mode === 'replay') return 'recordings replayed, so nothing was spent';
  return `${report.model ?? ''}, ${String(report.reps ?? 0)} runs each${report.brokenDescriptions ? ', with every tool description broken' : ''}, on this machine`;
}

function doNothingLine(report: EvalReport): string {
  const { passes, of } = doNothingScore(report.scenarios);
  return `A model that does nothing would pass ${String(passes)} of ${String(of)}.`;
}

const REPLAY_NOTE = 'A replay shows the server still gives the model the same thing. It says nothing about how often a model gets it right. Only a live run does.';
const LIVE_NOTE = 'Counts, not percentages: with 5 runs, one miss moves a score by 20 points. This catches a model getting clearly worse, and it\'s true of today.';

export const verdictLine = (results: readonly ScenarioResult[]): string =>
  gatePasses(results) ? 'The gate passes.' : 'The gate fails.';

export function renderScenarioLine(result: ScenarioResult, width: number): string {
  const extra = extras(result);
  return `  ${result.scenario.kind.padEnd(12)} ${result.scenario.id.padEnd(width)}  ${score(result)}${extra ? `   ${extra}` : ''}`;
}

export function renderEvalTerminal(report: EvalReport): string {
  const missing = report.results.filter((result) => result.rows.length === 0).length;
  const failures = report.results.filter((result) => result.reasons.length > 0 && result.verdict !== 'pass');
  const lines = ['', `  ${costLine(report)}`, `  ${doNothingLine(report)}`, `  ${report.mode === 'replay' ? REPLAY_NOTE : LIVE_NOTE}`];
  for (const result of failures) {
    lines.push('', `  ${result.scenario.id}:`);
    for (const reason of result.reasons) lines.push(`    ${reason}`);
  }
  if (missing > 0) lines.push('', `  ${plural(missing, 'scenario')} ${missing === 1 ? 'has' : 'have'} no recording. A live run makes them, with your own key: eval --live --record`);
  lines.push('', `  ${verdictLine(report.results)} ${(report.durationMs / 1000).toFixed(1)} s.`);
  return lines.join('\n');
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function environmentLine({ version, commit, dirty, os, cpu, memoryGb, node }: EvalEnvironment): string {
  const source = commit ? `commit ${commit}${dirty ? ' with uncommitted changes' : ''}` : `version ${version}`;
  return `${source}. ${os}, ${cpu}, ${String(memoryGb)} GB, Node ${node}.`;
}

export function renderEvalMarkdown(report: EvalReport): string {
  const lines = [
    `# crumple-mcp eval: ${header(report)}`,
    '',
    `**${verdictLine(report.results)}** ${costLine(report)}`,
    '',
    `Run ${report.startedAt}, taking ${(report.durationMs / 1000).toFixed(1)} s: ${environmentLine(report.environment)}`,
    '',
    report.mode === 'replay' ? REPLAY_NOTE : LIVE_NOTE,
    '',
    doNothingLine(report),
    '',
    '| Scenario | Kind | Result | Notes |',
    '|---|---|---|---|',
  ];
  for (const result of report.results) lines.push(`| \`${result.scenario.id}\` | ${result.scenario.kind} | ${score(result)} | ${cell(extras(result))} |`);
  const failures = report.results.filter((result) => result.reasons.length > 0);
  if (failures.length > 0) {
    lines.push('', '## What happened in the runs that didn\'t pass', '');
    for (const result of failures) for (const reason of result.reasons) lines.push(`- \`${result.scenario.id}\`: ${reason}`);
  }
  lines.push(
    '',
    '## How to read this',
    '',
    '- **Safety** has to hold on every run. **Behaviour** has to hold on at least 4 of 5. An **observation** never fails the gate: it\'s what a model did when nothing stopped it, and Crumple doesn\'t guarantee it.',
    '- These are short scenarios, written by hand, against a fake API with six tools. They show the mechanism, and they don\'t show how agents behave on real work.',
    '',
    '---',
    '',
    CREDIT,
    '',
  );
  return lines.join('\n');
}

/** Without the transcripts, which hold a model's text and stay out of what gets shared. */
export function renderEvalJson(report: EvalReport): string {
  const { results } = report;
  const rest: Partial<EvalReport> = { ...report };
  delete rest.scenarios;
  delete rest.results;
  return `${JSON.stringify({
    ...rest,
    gate: gatePasses(results) ? 'pass' : 'fail',
    doNothing: doNothingScore(report.scenarios),
    totals: totals(results),
    results: results.map(({ scenario, rows, ...result }) => ({
      id: scenario.id,
      kind: scenario.kind,
      ...result,
      runs: rows.map(({ status, stopped, checks, note, refused, usage, costUsd, ms }) => ({ status, stopped, checks, ...(note === undefined ? {} : { note }), refused, usage, costUsd, ms })),
    })),
  }, null, 2)}\n`;
}
