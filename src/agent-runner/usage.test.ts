import { afterEach, describe, expect, it } from 'vitest';
import { calling, fakeClaudeApi, finished, reply, scriptedModel, toolUse, type FakeApi } from '../../tests/helpers/fake-claude.js';
import { recordingServer, type RecordingServer } from '../../tests/helpers/recording-server.js';
import { claude } from './claude.js';
import { runAgent } from './loop.js';
import type { ModelReply, ModelRequest } from './model.js';
import { costOfCall, PRICES_READ, ratesFor } from './prices.js';
import { createMeter } from './usage.js';

const MILLION = 1_000_000;

describe('the price of one call', () => {
  it.each<[string, Parameters<typeof costOfCall>[1], number]>([
    ['Haiku input', { input_tokens: 50_000, output_tokens: 0 }, 0.005],
    ['Haiku output', { input_tokens: 0, output_tokens: 1_000 }, 0.0005],
    ['Haiku cache reads', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 100_000 }, 0.001],
    ['Haiku cache writes', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 80_000 }, 0.01],
    ['Haiku at exactly 100,000 tokens, still the lower rate', { input_tokens: 100_000, output_tokens: 0 }, 0.01],
    ['Haiku just over, at the higher rate', { input_tokens: 100_001, output_tokens: 0 }, 0.0500005],
    ['Haiku over because of what was cached, with output at the higher rate too', { input_tokens: 1_000, output_tokens: 1_000, cache_read_input_tokens: 99_001 }, 0.0005 + 0.0025 + 0.00495005],
  ])('%s', (_name, usage, expected) => {
    expect(costOfCall('claude-haiku-5-5', usage)).toBeCloseTo(expected, 9);
  });

  it.each<[string, number, number, number, number]>([
    ['claude-sonnet-5-5', 2, 10, 0.1, 2.5],
    ['claude-opus-5-5', 4, 20, 0.2, 5],
  ])('%s has one set of rates at any length', (model, input, output, read, write) => {
    const usage = { input_tokens: MILLION, output_tokens: MILLION, cache_read_input_tokens: MILLION, cache_creation_input_tokens: MILLION };
    expect(costOfCall(model, usage)).toBeCloseTo(input + output + read + write, 9);
  });

  it('says it can\'t be known, rather than 0, for a model with no price', () => {
    expect(costOfCall('claude-unknown', { input_tokens: 1, output_tokens: 1 })).toBeNull();
    expect(ratesFor('toString', 1)).toBeUndefined();
  });

  it('says it can\'t be known when usage is missing', () => {
    expect(costOfCall('claude-haiku-5-5', {})).toBeNull();
    expect(costOfCall('claude-haiku-5-5', { input_tokens: 1 })).toBeNull();
  });

  it('has prices someone has looked at in the last 90 days', () => {
    const ageDays = (Date.now() - Date.parse(PRICES_READ)) / 86_400_000;
    expect(ageDays).toBeLessThan(90);
  });
});

describe('summing a run', () => {
  const REQUEST = { max_tokens: 100 } as ModelRequest;

  it('works out cost per call, because totals would give the wrong answer', () => {
    const meter = createMeter({ model: 'claude-haiku-5-5', maxUsd: 100 });
    meter.onRequest(REQUEST);
    // Two calls of 60,000 are 120,000 together, and neither pays the higher rate.
    meter.onReply({ role: 'assistant', content: [], stop_reason: 'tool_use', usage: { input_tokens: 60_000, output_tokens: 0 } });
    meter.onReply({ role: 'assistant', content: [], stop_reason: 'end_turn', usage: { input_tokens: 60_000, output_tokens: 0 } });
    const { costUsd, usage } = meter.result();
    expect(costUsd).toBeCloseTo(0.012, 9);
    expect(usage.input).toBe(120_000);
  });

  it('adds up every kind of token', () => {
    const meter = createMeter({ model: 'claude-haiku-5-5', maxUsd: 100 });
    meter.onRequest(REQUEST);
    meter.onReply({ role: 'assistant', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } });
    expect(meter.result().usage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  });

  it('turns a call with no usage into "can\'t be known", and still counts it against the cap', () => {
    const meter = createMeter({ model: 'claude-haiku-5-5', maxUsd: 100 });
    meter.onRequest(REQUEST);
    meter.onReply({ role: 'assistant', content: [], stop_reason: 'end_turn', usage: {} });
    expect(meter.result().costUsd).toBeNull();
    expect(meter.result().usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('marks the total as "at most" once an answer is lost', () => {
    const meter = createMeter({ model: 'claude-haiku-5-5', maxUsd: 100 });
    meter.onRequest(REQUEST);
    meter.onLost();
    const { costUsd, costIsAtMost } = meter.result();
    expect(costIsAtMost).toBe(true);
    expect(costUsd).toBeGreaterThan(0);
  });

  it('allows nothing for a model with no price', () => {
    const meter = createMeter({ model: 'claude-unknown', maxUsd: 1_000 });
    meter.onRequest(REQUEST);
    expect(meter.mayAttempt()).toBe(false);
  });
});

describe('the cap holds', () => {
  const servers: RecordingServer[] = [];
  const apis: FakeApi[] = [];
  afterEach(async () => {
    await Promise.all([...servers.splice(0).map((server) => server.close()), ...apis.splice(0).map((api) => api.close())]);
  });
  const mcpUrl = async (): Promise<string> => {
    const server = await recordingServer({});
    servers.push(server);
    return server.url;
  };

  it.each<[string, number]>([
    ['claude-haiku-5-5', 0.05],
    ['claude-sonnet-5-5', 0.5],
    ['claude-opus-5-5', 1],
  ])('on %s, against a model that always spends its whole allowance', async (name, maxUsd) => {
    // As bad as it gets: a tool call every time, using all of max_tokens, with a prompt as big as the request's characters.
    const greedy = (request: ModelRequest, options: { mayAttempt(): boolean }): Promise<ModelReply> => {
      if (!options.mayAttempt()) return Promise.resolve({ ok: false, code: 'max_usd' });
      return Promise.resolve({
        ok: true,
        message: reply([toolUse(`t${String(request.messages.length)}`, 'getThing', {})], 'tool_use', { usage: { input_tokens: JSON.stringify(request).length, output_tokens: request.max_tokens } }),
      });
    };
    const model = scriptedModel(Array.from({ length: 200 }, () => greedy), name);
    const run = await runAgent({ task: 't', mcp: { url: await mcpUrl() }, model, limits: { maxUsd, maxTurns: 200, maxToolCalls: 200 } });

    expect(run.stopped).toBe('max_usd');
    expect(run.costUsd).toBeGreaterThan(0);
    expect(run.costUsd).toBeLessThanOrEqual(maxUsd);
  }, 30_000);

  it('makes no call at all when even the first could pass the cap', async () => {
    const api = await fakeClaudeApi([]);
    apis.push(api);
    // 8,000 tokens of output on Opus is 16 cents, worst case, before any input.
    const model = claude({ model: 'claude-opus-5-5', apiKey: 'k', baseUrl: api.url });
    const run = await runAgent({ task: 't', mcp: { url: await mcpUrl() }, model, limits: { maxUsd: 0.1 } });
    expect(run).toMatchObject({ stopped: 'max_usd', costUsd: 0 });
    expect(api.requests).toEqual([]);
  });

  it('across retries whose answers are all lost, with the real adapter', async () => {
    const api = await fakeClaudeApi([], 'drop');
    apis.push(api);
    const model = claude({ model: 'claude-haiku-5-5', apiKey: 'k', baseUrl: api.url, attempts: 1000, sleep: () => Promise.resolve() });
    const maxUsd = 0.05;
    const run = await runAgent({ task: 't', mcp: { url: await mcpUrl() }, model, limits: { maxUsd } });

    expect(run).toMatchObject({ stopped: 'max_usd', costIsAtMost: true });
    expect(api.requests.length).toBeGreaterThan(1);
    expect(run.costUsd).toBeLessThanOrEqual(maxUsd);
  }, 30_000);

  it('refuses a model with no price before spending anything', async () => {
    const model = scriptedModel([], 'claude-from-the-future');
    const run = await runAgent({ task: 't', mcp: { url: 'http://127.0.0.1:9/mcp' }, model });
    expect(run.stopped).toBe('no_price');
    expect(model.requests).toEqual([]);
    expect(run.notes.join(' ')).toContain('no price');
  });

  it('reports what a normal run used and cost', async () => {
    const model = scriptedModel([calling(toolUse('a', 'getThing', {})), finished()]);
    const run = await runAgent({ task: 't', mcp: { url: await mcpUrl() }, model });
    // The fixtures report 100 in and 20 out, each time.
    expect(run.usage).toEqual({ input: 200, output: 40, cacheRead: 0, cacheWrite: 0 });
    expect(run.costUsd).toBeCloseTo((200 * 0.1 + 40 * 0.5) / MILLION, 12);
    expect(run.costIsAtMost).toBe(false);
  });
});
