import { describe, expect, it } from 'vitest';
import { runChecks } from './checks.js';
import { recordedChecks, RECOVERY_SCENARIOS, type RecordedRun, type StartTarget } from './self-checks.js';

// C10 and C12 rest on what a real model did. These show the checks can say no, without needing one.

const TOKENS = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };

const run = (id: string, more: Partial<RecordedRun> = {}): RecordedRun => ({
  id,
  source: 'live',
  model: 'claude-haiku-5-5',
  recordedAt: '2026-11-06T12:47:09.736Z',
  status: 'pass',
  toolOutcomes: ['tool_error', 'ok'],
  providerUsage: TOKENS,
  reportedUsage: TOKENS,
  costUsd: 0.00002,
  ...more,
});

const healthy = (): RecordedRun[] => RECOVERY_SCENARIOS.map((id) => run(id));
const start: StartTarget = () => Promise.reject(new Error('These checks are handed their runs, so they never start anything.'));

async function outcomes(runs: readonly RecordedRun[]) {
  const [recovery, usage] = await runChecks(recordedChecks(() => Promise.resolve(runs)), start);
  return { recovery, usage };
}

describe('C10: a real model acting on Crumple\'s errors', () => {
  it('passes on recordings from a live run, and names the model and the day', async () => {
    const { recovery } = await outcomes(healthy());
    expect(recovery).toMatchObject({ id: 'real-model-acted-on-errors', claim: 'C10', state: 'pass' });
    expect(recovery?.detail).toContain('claude-haiku-5-5');
    expect(recovery?.detail).toContain('2026-11-06');
    expect(recovery?.detail).toContain('not a rate');
  });

  it.each<[string, RecordedRun['source']]>([['a scripted recording', 'scripted'], ['no recording', 'missing']])('doesn\'t run on %s, because neither shows what a model does', async (_name, source) => {
    const { recovery } = await outcomes([run('lost-responses', { source }), ...healthy().slice(1)]);
    expect(recovery?.state).toBe('not_run');
    expect(recovery?.detail).toContain('lost-responses');
  });

  it('doesn\'t run when one of the scenarios is absent', async () => {
    expect((await outcomes(healthy().slice(1))).recovery?.state).toBe('not_run');
  });

  it('fails when today\'s server no longer gives the model what it read', async () => {
    const { recovery } = await outcomes([run('lost-responses', { status: 'stale', note: 'A tool result changed.' }), ...healthy().slice(1)]);
    expect(recovery?.state).toBe('fail');
    expect(recovery?.detail).toContain('A tool result changed.');
  });

  it('fails on a recording with no failed call in it, which shows nothing about recovering', async () => {
    const { recovery } = await outcomes([run('lost-responses', { toolOutcomes: ['ok'] }), ...healthy().slice(1)]);
    expect(recovery?.state).toBe('fail');
    expect(recovery?.detail).toContain('no failed call');
  });
});

describe('C12: tokens and cost against the provider\'s own numbers', () => {
  it('passes when every run\'s totals equal what the provider said', async () => {
    const { usage } = await outcomes(healthy());
    expect(usage).toMatchObject({ id: 'recorded-usage-adds-up', claim: 'C12', state: 'pass', measured: { recordings: 3, input_tokens: 300, output_tokens: 60 } });
  });

  it('counts only recordings from a live run', async () => {
    const { usage } = await outcomes([...healthy(), run('made-up', { source: 'scripted', providerUsage: { ...TOKENS, input: 5 } })]);
    expect(usage).toMatchObject({ state: 'pass', measured: { recordings: 3 } });
  });

  it('doesn\'t run with no live recordings', async () => {
    expect((await outcomes([run('a', { source: 'scripted' })])).usage?.state).toBe('not_run');
    expect((await outcomes([])).usage?.state).toBe('not_run');
  });

  it.each<[string, Partial<RecordedRun>]>([
    ['input tokens are off by one', { reportedUsage: { ...TOKENS, input: 99 } }],
    ['output tokens are off by one', { reportedUsage: { ...TOKENS, output: 21 } }],
    ['cached tokens were dropped', { providerUsage: { ...TOKENS, cacheRead: 7 } }],
    ['the cost is unknown', { costUsd: null }],
    ['the cost is zero for tokens that were used', { costUsd: 0 }],
    ['the replay went stale', { status: 'stale', note: 'A tool result changed.' }],
  ])('fails when %s', async (_name, more) => {
    expect((await outcomes([run('a', more)])).usage?.state).toBe('fail');
  });
});
