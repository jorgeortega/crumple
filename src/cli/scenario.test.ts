import { describe, expect, it } from 'vitest';
import { calling, fakeClaudeApi, finished, reply, scriptedModel, toolUse } from '../../tests/helpers/fake-claude.js';
import { firstDifference, type Exchange, type ModelRequest } from '../agent-runner/index.js';
import type { ToolResultBlock } from '../agent-runner/model.js';
import type { StartTarget } from '../prove/index.js';
import { startCrumple } from './prove.js';
import { claude, RECORD_MAX_USD, recordScenario, replayRecording, SCENARIOS, seededKeys, type Scenario } from './scenario.js';

// The scripted model stands in for the real one. Everything else is real: Crumple and fault-api over
// real sockets. The first recording from a real model comes from npm run record.

const ABOUT = { commit: 'abc1234', now: () => Date.UTC(2026, 10, 5) };
const SCENARIO = SCENARIOS[0] as Scenario;
const PAYMENT = { body: { customerId: 'cus_1', amountCents: 5000 } };

/** Does what a model would: reads the key out of Crumple's error, and retries with it. */
const payingModel = () => scriptedModel([
  calling(toolUse('p1', 'createPayment', PAYMENT)),
  (request: ModelRequest) => {
    const [result] = request.messages.at(-1)?.content as ToolResultBlock[];
    const { idempotencyKey } = JSON.parse(result?.content ?? '{}') as { idempotencyKey?: string };
    return Promise.resolve(calling(toolUse('p2', 'createPayment', { ...PAYMENT, idempotencyKey })));
  },
  finished('Charged once.'),
]);

const recorded = async () => recordScenario(SCENARIO, payingModel(), ABOUT);

// A trace id and a time are meant to differ from run to run. Everything else has to match.
const comparable = ({ toolCalls, traceId: _traceId, ...rest }: Awaited<ReturnType<typeof recorded>>['run']) => ({ ...rest, toolCalls: toolCalls.map(({ name, args, outcome }) => ({ name, args, outcome })) });

describe('recording', () => {
  it('keeps every exchange, with what it needs to say where it came from', async () => {
    const { recording, run, effects } = await recorded();
    expect(run.stopped).toBe('done');
    expect(effects).toBe(1);
    expect(recording).toMatchObject({ format: 1, recordedAt: '2026-11-05T00:00:00.000Z', commit: 'abc1234', apiVersion: '2026-10-21', model: 'claude-haiku-5-5', scenario: SCENARIO });
    expect(recording.exchanges).toHaveLength(3);
  });

  it('keeps each request as it was when sent, although the loop goes on adding to its history', async () => {
    const { recording } = await recorded();
    expect(recording.exchanges.map(({ request }) => request.messages.length)).toEqual([1, 3, 5]);
  });

  it('never holds the key, even going through the real adapter', async () => {
    const key = 'test-key-that-must-stay-hidden';
    const api = await fakeClaudeApi([{ body: finished() }]);
    try {
      const { recording } = await recordScenario(SCENARIO, claude({ model: 'claude-haiku-5-5', apiKey: key, baseUrl: api.url }), ABOUT);
      expect(api.requests[0]?.headers['x-api-key']).toBe(key);
      expect(JSON.stringify(recording)).not.toContain(key);
    } finally {
      await api.close();
    }
  });

  it('is capped low, because it spends real money', () => {
    expect(RECORD_MAX_USD).toBe(0.1);
  });
});

describe('replaying', () => {
  it('Task 26\'s check: a recorded run replays identically, twice, with the tools really running', async () => {
    const { recording, run } = await recorded();
    const first = await replayRecording(recording);
    const second = await replayRecording(recording);

    for (const replayed of [first, second]) {
      expect(replayed.stale).toBeUndefined();
      expect(replayed.effects).toBe(1);
      expect(comparable(replayed.run)).toEqual(comparable(run));
    }
  }, 20_000);

  it('survives being saved to a file and read back', async () => {
    const { recording } = await recorded();
    const { stale } = await replayRecording(JSON.parse(JSON.stringify(recording)) as typeof recording);
    expect(stale).toBeUndefined();
  });

  it('needs the seeded keys: fresh ones make it stale, so this check can fail', async () => {
    const { recording } = await recorded();
    let fresh = 0;
    const unseeded: StartTarget = (setup) => startCrumple({ ...setup, newKey: () => `fresh-${String(fresh += 1)}` });
    const { stale } = await replayRecording(recording, unseeded);
    expect(stale).toContain('Turn 2');
    expect(stale).toContain('message 3');
  });

  it('is stale when a tool\'s definition changes, which is how a broken description gets caught for free', async () => {
    const { recording } = await recorded();
    const [first, ...others] = recording.exchanges as Exchange[];
    const tools = first?.request.tools.map((tool, i) => (i === 0 ? { ...tool, description: 'Now it says something else.' } : tool)) ?? [];
    const changed = { ...recording, exchanges: [{ ...first, request: { ...first?.request, tools } } as Exchange, ...others] };
    const { stale } = await replayRecording(changed);
    expect(stale).toContain('Turn 1');
    expect(stale).toContain('the definition of tool 1');
  });

  it('is stale when the server starts answering differently', async () => {
    const { recording } = await recorded();
    const { stale, run } = await replayRecording({ ...recording, scenario: { ...SCENARIO, fault: 'status=400' } });
    expect(run.stopped).toBe('stale');
    expect(stale).toContain('Turn 2');
  });

  it('is stale when the run goes on past the recording', async () => {
    const { recording } = await recorded();
    const { stale } = await replayRecording({ ...recording, exchanges: recording.exchanges.slice(0, 1) });
    expect(stale).toContain('the recording stops at turn 1');
  });

  it('is stale when the run finishes with recorded turns left over', async () => {
    const { recording } = await recorded();
    const extra = { request: recording.exchanges[0]?.request, reply: { ok: true, message: reply([], 'end_turn') } } as Exchange;
    const { stale } = await replayRecording({ ...recording, exchanges: [...recording.exchanges, extra] });
    expect(stale).toContain('1 recorded turns left over');
  });

  it('replays a model\'s failure too', async () => {
    const request = (await recorded()).recording.exchanges[0]?.request as ModelRequest;
    const { run, stale } = await replayRecording({ model: 'claude-haiku-5-5', scenario: SCENARIO, exchanges: [{ request, reply: { ok: false, code: 'overloaded', status: 529 } }] });
    expect(stale).toBeUndefined();
    expect(run).toMatchObject({ stopped: 'model_error', modelError: { code: 'overloaded' } });
  });

  it('spends nothing against the cap, since nothing is being spent', async () => {
    const { recording, run } = await recorded();
    const replayed = await replayRecording(recording);
    expect(replayed.run.stopped).toBe('done');
    expect(replayed.run.costUsd).toBe(run.costUsd);
  });
});

describe('where a request differs', () => {
  const BASE: ModelRequest = { model: 'm', max_tokens: 1, system: 's', tools: [{ name: 'a', input_schema: {} }], messages: [{ role: 'user', content: 'secret words' }], output_config: { effort: 'medium' } };

  it.each<[string, Partial<ModelRequest>, string]>([
    ['the model', { model: 'other' }, 'the model'],
    ['the system prompt', { system: 'other' }, 'the system prompt'],
    ['a tool', { tools: [{ name: 'b', input_schema: {} }] }, 'the definition of tool 1 of 1'],
    ['a new tool', { tools: [{ name: 'a', input_schema: {} }, { name: 'b', input_schema: {} }] }, 'the list of tools, which has grown'],
    ['a message', { messages: [{ role: 'user', content: 'other' }] }, 'message 1'],
    ['an extra message', { messages: [{ role: 'user', content: 'secret words' }, { role: 'assistant', content: 'x' }] }, 'message 2 (recorded: nothing, now: message assistant)'],
    ['anything else', { max_tokens: 2 }, 'other settings'],
  ])('names %s', (_name, change, expected) => {
    expect(firstDifference(BASE, { ...BASE, ...change })).toContain(expected);
  });

  it('never repeats what a message said', () => {
    expect(firstDifference(BASE, { ...BASE, messages: [{ role: 'user', content: 'other' }] })).not.toContain('secret');
  });
});

describe('seeded keys', () => {
  it('are the same each time, and look like what they stand in for', () => {
    const [one, two] = [seededKeys(), seededKeys()];
    expect(one()).toBe(two());
    expect(one()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
