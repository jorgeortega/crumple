import { afterEach, describe, expect, it } from 'vitest';
import { calling, fakeClaudeApi, finished, scriptedModel, toolUse, type FakeApi } from '../../tests/helpers/fake-claude.js';
import { recordingServer, type RecordedCall, type RecordingServer } from '../../tests/helpers/recording-server.js';
import { claude } from './claude.js';
import { runAgent } from './loop.js';
import type { ModelRequest, ToolResultBlock } from './model.js';
import { firstDifference, recorder } from './recording.js';

const servers: RecordingServer[] = [];
const apis: FakeApi[] = [];
afterEach(async () => {
  await Promise.all([...servers.splice(0).map((server) => server.close()), ...apis.splice(0).map((api) => api.close())]);
});
const fake = async (options: Parameters<typeof recordingServer>[0]) => {
  const server = await recordingServer(options);
  servers.push(server);
  return server;
};

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

describe('a recording', () => {
  it('never holds the key, even going through the real adapter', async () => {
    const key = 'test-key-that-must-stay-hidden';
    const api = await fakeClaudeApi([{ body: finished() }]);
    apis.push(api);
    const { url } = await fake({});
    const kept = recorder(claude({ model: 'claude-haiku-5-5', apiKey: key, baseUrl: api.url }));
    await runAgent({ task: 't', mcp: { url }, model: kept });
    expect(api.requests[0]?.headers['x-api-key']).toBe(key);
    expect(JSON.stringify(kept.exchanges)).not.toContain(key);
  });
});

describe('ways a tool call can fail, which all reach the model', () => {
  const answering = (status: number, body: unknown) => (call: RecordedCall) =>
    new Response(JSON.stringify(typeof body === 'function' ? (body as (id: unknown) => unknown)((JSON.parse(call.rawBody) as { id: unknown }).id) : body), { status, headers: { 'content-type': 'application/json' } });

  async function outcome(callResult: (call: RecordedCall) => Response) {
    const { url } = await fake({ callResult });
    const model = scriptedModel([calling(toolUse('g', 'getThing', {})), finished()]);
    const run = await runAgent({ task: 't', mcp: { url }, model });
    const [result] = model.requests[1]?.messages[2]?.content as ToolResultBlock[];
    return { outcome: run.toolCalls[0]?.outcome, result };
  }

  it.each<[number, string]>([[401, 'refused'], [403, 'refused'], [500, 'unreachable']])('an HTTP %i', async (status, expected) => {
    const seen = await outcome(answering(status, {}));
    expect(seen.outcome).toBe(expected);
    expect(seen.result).toMatchObject({ is_error: true, content: expect.stringContaining(`HTTP ${String(status)}`) as string });
  });

  it('a refusal with no message still says it was refused', async () => {
    const seen = await outcome(answering(200, (id: unknown) => ({ jsonrpc: '2.0', id, error: { code: -32602 } })));
    expect(seen.outcome).toBe('refused');
    expect(seen.result?.content).toBe('The server refused this call.');
  });
});

describe('a server with no tools to offer', () => {
  it('spends nothing when its list fails before any tool arrives', async () => {
    const { url } = await fake({
      override: (call) => {
        if (call.method !== 'tools/list') return undefined;
        const { id, params } = JSON.parse(call.rawBody) as { id: unknown; params?: { cursor?: string } };
        return params?.cursor === undefined
          ? new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { resultType: 'complete', tools: [], nextCursor: 'more' } }), { headers: { 'content-type': 'application/json' } })
          : new Response('{}', { status: 500 });
      },
    });
    const model = scriptedModel([]);
    const run = await runAgent({ task: 't', mcp: { url }, model });
    expect(run.stopped).toBe('mcp_unavailable');
    expect(run.notes.join(' ')).toContain('listed no tools');
    expect(model.requests).toEqual([]);
  });
});

describe('waiting between attempts, with the real clock', () => {
  const REQUEST = { model: 'claude-haiku-5-5', max_tokens: 1, system: 's', tools: [], messages: [], output_config: { effort: 'medium' } };

  it('waits, then tries again', async () => {
    const api = await fakeClaudeApi([{ status: 429, body: {}, headers: { 'retry-after': '0' } }, { body: finished() }]);
    apis.push(api);
    const reply = await claude({ model: REQUEST.model, apiKey: 'k', baseUrl: api.url }).complete(REQUEST, { signal: AbortSignal.timeout(2_000), mayAttempt: () => true, onLost: () => undefined });
    expect(reply.ok).toBe(true);
    expect(api.requests).toHaveLength(2);
  });

  it('stops waiting when the deadline comes', async () => {
    const api = await fakeClaudeApi([{ status: 500, body: {} }, { body: finished() }]);
    apis.push(api);
    const abort = new AbortController();
    setTimeout(() => { abort.abort(); }, 30);
    const started = performance.now();
    const reply = await claude({ model: REQUEST.model, apiKey: 'k', baseUrl: api.url }).complete(REQUEST, { signal: abort.signal, mayAttempt: () => true, onLost: () => undefined });
    expect(reply).toEqual({ ok: false, code: 'timeout' });
    expect(api.requests).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(400);
  });
});
