import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calling, finished, scriptedModel, toolUse } from '../../tests/helpers/fake-claude.js';
import { startCrumple } from '../cli/prove.js';
import { replayRecordings } from './recorded.js';
import { runOne, toRecording, type Recording, type StartEvalTarget } from './run.js';
import { parseScenario, type Scenario } from './scenarios.js';

const start: StartEvalTarget = startCrumple;
const LOOKUP: Scenario = { id: 'lookup', kind: 'behaviour', task: 'Look up cus_1.', key: 'read', expect: {} };

async function recordingOf(source: Recording['source']): Promise<Recording> {
  const model = scriptedModel([calling(toolUse('a', 'getCustomer', { id: 'cus_1' })), finished()]);
  const row = await runOne(LOOKUP, model, start, { maxUsd: Number.POSITIVE_INFINITY });
  return toRecording(LOOKUP, row, { source, commit: 'abc1234', now: Date.parse('2026-11-06T00:00:00Z'), model: 'claude-haiku-5-5' });
}

describe('replaying what\'s in the recordings', () => {
  it('reports the provider\'s usage beside what the run worked out, from the same replies', async () => {
    const recording = await recordingOf('live');
    const [run] = await replayRecordings([{ scenario: LOOKUP, recording }], start);
    expect(run).toMatchObject({ id: 'lookup', source: 'live', model: 'claude-haiku-5-5', recordedAt: '2026-11-06T00:00:00.000Z', status: 'pass', toolOutcomes: ['ok'] });
    expect(run?.reportedUsage).toEqual(run?.providerUsage);
  });

  it('says what a recording says it is, and never calls one live on its own account', async () => {
    const recording = await recordingOf('scripted');
    expect((await replayRecordings([{ scenario: LOOKUP, recording }], start))[0]?.source).toBe('scripted');
  });

  it('says when there\'s no recording, without running anything', async () => {
    const [run] = await replayRecordings([{ scenario: LOOKUP, recording: undefined }], () => Promise.reject(new Error('Nothing should start.')));
    expect(run).toMatchObject({ id: 'lookup', source: 'missing', toolOutcomes: [] });
  });

  it('reads the provider\'s numbers from the replies in the recording', async () => {
    const recording = await recordingOf('live');
    const [first] = await replayRecordings([{ scenario: LOOKUP, recording }], start);
    const edited = JSON.parse(JSON.stringify(recording)) as { exchanges: { reply: { message: { usage: { input_tokens: number } } } }[] };
    const firstExchange = edited.exchanges[0];
    if (!firstExchange) throw new Error('The recording has no exchanges.');
    firstExchange.reply.message.usage.input_tokens += 1;
    const [second] = await replayRecordings([{ scenario: LOOKUP, recording: edited as unknown as Recording }], start);
    // The two sides add up the same replies by different routes, so an edit moves both.
    expect(second?.providerUsage.input).toBe((first?.providerUsage.input ?? 0) + 1);
    expect(second?.reportedUsage.input).toBe(second?.providerUsage.input);
  });
});

describe('the recordings in the repo', () => {
  const ROOT = new URL('../../scenarios/', import.meta.url);
  const IDS = ['lost-responses', 'api-down-then-up', 'wont-get-better'];

  it('are from a live run, so no scripted file passes for a real model', async () => {
    const found = IDS.map((id) => ({
      scenario: parseScenario(readFileSync(new URL(`${id}.json`, ROOT), 'utf8'), id),
      recording: JSON.parse(readFileSync(new URL(`recordings/${id}.json`, ROOT), 'utf8')) as Recording,
    }));
    const runs = await replayRecordings(found, start);
    for (const run of runs) expect(run).toMatchObject({ source: 'live', model: 'claude-haiku-5-5', status: 'pass' });
  });
});
