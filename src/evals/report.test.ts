import { describe, expect, it } from 'vitest';
import { summarise } from './gate.js';
import { renderEvalJson, renderEvalMarkdown, renderEvalTerminal, renderScenarioLine, totals, type EvalReport } from './report.js';
import type { RunRow } from './run.js';
import type { Scenario } from './scenarios.js';

const BEHAVIOUR: Scenario = { id: 'charge', kind: 'behaviour', task: 'Charge someone.', key: 'write', expect: { payments: [{ customerId: 'c', amountCents: 1 }] } };
const SAFETY: Scenario = { id: 'guard', kind: 'safety', task: 'Try something.', key: 'read', expect: {} };
const OBSERVE: Scenario = { id: 'watch', kind: 'observation', observedAs: 'deleted', task: 'Read it.', key: 'all', expect: {} };

const MODEL_WORDS = 'words-only-a-model-said';

const row = (status: RunRow['status'], more: Partial<RunRow> = {}): RunRow => ({
  status,
  stopped: 'done',
  checks: status === 'fail' ? [{ check: 'payments', ok: false, detail: 'Expected 1 cent, and fault-api applied none.' }] : [],
  refused: false,
  usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.001,
  costIsAtMost: false,
  budgetUsedUsd: 0.001,
  ms: 5,
  toolCalls: [],
  exchanges: [{ request: { model: 'm', max_tokens: 1, system: 's', tools: [], messages: [], output_config: { effort: 'medium' } }, reply: { ok: true, message: { role: 'assistant', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: MODEL_WORDS }] } } }],
  ...more,
});

const many = (status: RunRow['status'], count: number): RunRow[] => Array.from({ length: count }, () => row(status));

function report(results: EvalReport['results'], more: Partial<EvalReport> = {}): EvalReport {
  return {
    mode: 'live',
    startedAt: '2026-11-05T00:00:00.000Z',
    durationMs: 1_500,
    environment: { version: '0.1.0', commit: 'abc1234', os: 'darwin arm64', cpu: 'CPU', memoryGb: 16, node: '26' },
    model: 'claude-haiku-5-5',
    reps: 5,
    maxUsd: 1,
    brokenDescriptions: false,
    results,
    scenarios: results.map((result) => result.scenario),
    ...more,
  };
}

const line = (scenario: Scenario, rows: RunRow[], planned = 5): string => renderScenarioLine(summarise(scenario, rows, planned), 8);

describe('a run with no model in it', () => {
  const SCRIPTED: Scenario = { ...SAFETY, scripted: 'obeys-injection' };
  const free = { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 };

  it('says so beside its score, so nobody reads it as a model being stopped', () => {
    expect(line(SCRIPTED, [row('pass', free)], 1)).toContain('scripted, no model');
    expect(line(SAFETY, [row('pass')], 1)).not.toContain('scripted');
  });

  it('is counted apart in the totals', () => {
    const results = [summarise(SCRIPTED, [row('pass', free)], 1), summarise(BEHAVIOUR, many('pass', 5), 5)];
    expect(renderEvalTerminal(report(results))).toContain('6 runs, 1 of them scripted with no model, 0 errors.');
    expect(renderEvalMarkdown(report(results))).toContain('6 runs, 1 of them scripted with no model, 0 errors.');
    expect(renderEvalTerminal(report([summarise(BEHAVIOUR, many('pass', 5), 5)]))).toContain('5 runs, 0 errors.');
  });
});

describe('a replay\'s totals', () => {
  it('say nothing was spent, and that the money is from when the recording was made', () => {
    const text = renderEvalTerminal(report([summarise(BEHAVIOUR, [row('pass')], 1)], { mode: 'replay' }));
    expect(text).toContain('Nothing was spent. When they were recorded: $0.001000, 10 tokens in, 2 out.');
  });

  it('leave that out when no recording had any usage', () => {
    const free = { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 };
    const text = renderEvalTerminal(report([summarise(BEHAVIOUR, [row('pass', free)], 1)], { mode: 'replay' }));
    expect(text).toContain('Nothing was spent.');
    expect(text).not.toContain('When they were recorded');
  });
});

describe('a scenario\'s line', () => {
  it('gives counts, not percentages', () => {
    expect(line(BEHAVIOUR, [...many('pass', 4), row('fail')])).toMatch(/behaviour\s+charge\s+4 of 5$/);
  });

  it('says what was wrong beside the count', () => {
    expect(line(BEHAVIOUR, [...many('pass', 2), row('fail'), ...many('fail', 2)])).toContain('FAIL');
    expect(line(BEHAVIOUR, [...many('pass', 4), row('error')])).toContain('1 error');
    expect(line(BEHAVIOUR, [...many('pass', 3), ...many('error', 2)])).toContain('2 errors');
    expect(line(BEHAVIOUR, [...many('pass', 4), row('truncated')])).toContain('1 cut off');
    expect(line(BEHAVIOUR, [...many('pass', 4), row('not_run')])).toContain('1 not run');
    expect(line(BEHAVIOUR, many('error', 5))).toContain('inconclusive');
    expect(line(BEHAVIOUR, [row('stale')], 1)).toContain('stale');
    expect(line(SAFETY, [row('pass', { refused: true }), ...many('pass', 4)])).toContain('1 refused by the model');
  });

  it('words an observation as what the model did, and never calls it a failure', () => {
    const text = line(OBSERVE, [row('pass'), ...many('fail', 2), ...many('pass', 2)]);
    expect(text).toContain('deleted in 2 of 5 runs');
    expect(text).not.toContain('FAIL');
  });

  it('tells no recording apart from a run that didn\'t happen', () => {
    expect(line(BEHAVIOUR, [], 1)).toContain('no recording');
    expect(line(BEHAVIOUR, many('not_run', 5))).toMatch(/not run/);
  });
});

describe('the totals', () => {
  it('add up the runs that happened', () => {
    const result = summarise(BEHAVIOUR, [...many('pass', 2), row('not_run'), row('error')], 5);
    expect(totals([result])).toMatchObject({ runs: 3, errors: 1, input: 30, output: 6, costIsAtMost: false });
  });

  it('say the cost is unknown rather than leaving part of it out', () => {
    const result = summarise(BEHAVIOUR, [row('pass'), row('pass', { costUsd: null })], 2);
    expect(totals([result]).costUsd).toBeNull();
    expect(renderEvalTerminal(report([result]))).toContain('cost unknown');
  });

  it('say "at most" once an answer was lost', () => {
    const result = summarise(BEHAVIOUR, [row('pass', { costIsAtMost: true })], 1);
    expect(renderEvalTerminal(report([result]))).toContain('at most $0.001000');
  });

  it('show a larger cost plainly, and nothing as $0', () => {
    expect(renderEvalTerminal(report([summarise(BEHAVIOUR, [row('pass', { costUsd: 0.5 })], 1)]))).toContain('$0.5000');
    expect(renderEvalTerminal(report([summarise(BEHAVIOUR, [row('pass', { costUsd: 0 })], 1)]))).toContain('$0,');
  });
});

describe('the terminal report', () => {
  it('gives the reasons for what didn\'t pass, and the do-nothing score', () => {
    const text = renderEvalTerminal(report([summarise(BEHAVIOUR, many('fail', 5), 5), summarise(SAFETY, many('pass', 5), 5)]));
    expect(text).toContain('5 x Expected 1 cent, and fault-api applied none.');
    expect(text).toContain('A model that does nothing would pass 1 of 2.');
    expect(text).toContain('Counts, not percentages');
    expect(text).toContain('The gate fails.');
  });

  it('counts missing recordings, in the singular too', () => {
    const replay = { mode: 'replay' as const };
    expect(renderEvalTerminal(report([summarise(BEHAVIOUR, [], 1)], replay))).toContain('1 scenario has no recording');
    expect(renderEvalTerminal(report([summarise(BEHAVIOUR, [], 1), summarise(SAFETY, [], 1)], replay))).toContain('2 scenarios have no recording');
  });
});

describe('the shared reports', () => {
  const results = [summarise(BEHAVIOUR, [...many('fail', 2), ...many('pass', 3)], 5), summarise(OBSERVE, many('pass', 5), 5)];

  it('say what ran, on what, and how to read it', () => {
    const text = renderEvalMarkdown(report(results));
    expect(text).toContain('# crumple-mcp eval: claude-haiku-5-5, 5 runs each, on this machine');
    expect(text).toContain('commit abc1234.');
    expect(text).toContain('2 x Expected 1 cent');
    expect(text).toContain('They show the mechanism');
    expect(text).toContain('Latitude 10');
  });

  it('say a replay isn\'t a pass rate, and when descriptions were broken', () => {
    expect(renderEvalMarkdown(report(results, { mode: 'replay' }))).toContain('says nothing about how often');
    expect(renderEvalMarkdown(report(results, { brokenDescriptions: true }))).toContain('with every tool description broken');
  });

  it('state the version and any uncommitted changes', () => {
    const noCommit = { version: '0.1.0', os: 'darwin arm64', cpu: 'CPU', memoryGb: 16, node: '26' };
    expect(renderEvalMarkdown(report(results, { environment: noCommit }))).toContain('version 0.1.0.');
    expect(renderEvalMarkdown(report(results, { environment: { ...noCommit, commit: 'abc', dirty: true } }))).toContain('commit abc with uncommitted changes');
  });

  it('never hold what a model said, because reports get shared', () => {
    for (const text of [renderEvalMarkdown(report(results)), renderEvalJson(report(results)), renderEvalTerminal(report(results))]) {
      expect(text).not.toContain(MODEL_WORDS);
    }
  });

  it('give the gate and every run in the JSON', () => {
    const parsed = JSON.parse(renderEvalJson(report(results))) as { gate: string; results: { id: string; runs: { note?: string }[] }[] };
    expect(parsed.gate).toBe('fail');
    expect(parsed.results[0]?.runs).toHaveLength(5);
    expect(JSON.parse(renderEvalJson(report([summarise(BEHAVIOUR, [row('error', { note: 'It broke.' })], 1)])))).toMatchObject({ results: [{ runs: [{ note: 'It broke.' }] }] });
  });
});
