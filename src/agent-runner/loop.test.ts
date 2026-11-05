import { afterEach, describe, expect, it } from 'vitest';
import { calling, finished, reply, scriptedModel, toolUse } from '../../tests/helpers/fake-claude.js';
import { recordingServer, type RecordingServer } from '../../tests/helpers/recording-server.js';
import { startCrumple } from '../cli/prove.js';
import type { Target, TargetSetup } from '../prove/index.js';
import { MAX_RESULT_CHARS, runAgent } from './loop.js';
import type { Message, ToolResultBlock } from './model.js';

// A scripted model, and everything else real: Crumple and fault-api over real sockets.

const started: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((one) => one.stop().catch(() => undefined)));
});

async function crumple(setup: TargetSetup = {}): Promise<Target> {
  const target = await startCrumple(setup);
  started.push(target);
  return target;
}

const CUSTOMER = { id: 'cus_1' };
const PAYMENT = { body: { customerId: 'cus_1', amountCents: 5000 } };

const resultsIn = (message: Message | undefined): ToolResultBlock[] => (message?.content ?? []) as ToolResultBlock[];

describe('the loop', () => {
  it('finishes when the model does, and offers it the server\'s tools, sorted', async () => {
    const target = await crumple();
    const model = scriptedModel([finished('Nothing to do.')]);
    const run = await runAgent({ task: 'Say hi.', mcp: { url: target.url, token: target.keys.read }, model });

    expect(run).toMatchObject({ stopped: 'done', text: 'Nothing to do.', turns: 1, toolCalls: [] });
    const names = model.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain('getCustomer');
    expect(names).toEqual([...names].sort());
    expect(model.requests[0]?.tools[0]?.input_schema).toMatchObject({ type: 'object' });
    expect(model.requests[0]).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 8000, output_config: { effort: 'medium' }, messages: [{ role: 'user', content: 'Say hi.' }] });
  });

  it('never sends what API version 2026-10-21 refuses, and doesn\'t force a tool', async () => {
    const target = await crumple();
    const model = scriptedModel([finished()]);
    await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model });
    for (const refused of ['temperature', 'top_p', 'top_k', 'tool_choice']) expect(model.requests[0]).not.toHaveProperty(refused);
  });

  it('runs a tool, sends back the result, and only ever adds to the history', async () => {
    const target = await crumple();
    const thinking = { type: 'thinking', thinking: '', signature: 'opaque-signature' };
    const model = scriptedModel([
      reply([thinking, toolUse('t1', 'getCustomer', CUSTOMER)], 'tool_use'),
      finished('Ada is the customer.'),
    ]);
    const run = await runAgent({ task: 'Who is cus_1?', mcp: { url: target.url, token: target.keys.read }, model });

    expect(run).toMatchObject({ stopped: 'done', text: 'Ada is the customer.', turns: 2 });
    expect(run.toolCalls).toMatchObject([{ name: 'getCustomer', args: CUSTOMER, outcome: 'ok' }]);
    expect(target.upstream.requests()).toHaveLength(1);

    const [first, second] = model.requests;
    // The earlier turn is still there, unchanged, with its thinking block empty and intact.
    expect(second?.messages[0]).toEqual(first?.messages[0]);
    expect(second?.messages[1]).toEqual({ role: 'assistant', content: [thinking, toolUse('t1', 'getCustomer', CUSTOMER)] });
    const [result] = resultsIn(second?.messages[2]);
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(result?.is_error).toBeUndefined();
    expect(result?.content).toContain('Ada');
  });

  it('runs parallel calls at once, and returns every result in one message, in the order asked', async () => {
    const target = await crumple({ fault: 'delay=150' });
    const model = scriptedModel([
      calling(toolUse('a', 'getCustomer', CUSTOMER), toolUse('b', 'listCustomers', {})),
      finished(),
    ]);
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model });

    expect(run.toolCalls.map((call) => call.name)).toEqual(['getCustomer', 'listCustomers']);
    expect(model.requests[1]?.messages).toHaveLength(3);
    expect(resultsIn(model.requests[1]?.messages[2]).map((block) => block.tool_use_id)).toEqual(['a', 'b']);

    const [one, two] = target.upstream.requests();
    expect(Math.abs((one?.at ?? 0) - (two?.at ?? 1_000))).toBeLessThan(150);
  });
});

describe('when a tool doesn\'t work, the model gets to read why', () => {
  it('hands over a server\'s refusal instead of crashing, because official clients raise it', async () => {
    const target = await crumple();
    const model = scriptedModel([calling(toolUse('d', 'deleteCustomer', CUSTOMER)), finished('I couldn\'t.')]);
    const run = await runAgent({ task: 'Delete cus_1.', mcp: { url: target.url, token: target.keys.read }, model });

    expect(run).toMatchObject({ stopped: 'done', text: 'I couldn\'t.' });
    expect(run.toolCalls[0]?.outcome).toBe('refused');
    const [result] = resultsIn(model.requests[1]?.messages[2]);
    expect(result?.is_error).toBe(true);
    expect(result?.content.length).toBeGreaterThan(0);
    expect(target.upstream.effects()).toEqual([]);
  });

  it('marks a tool\'s own failure as an error, with Crumple\'s structured message', async () => {
    const target = await crumple({ fault: 'status=400', retry: { attempts: 1 } });
    const model = scriptedModel([calling(toolUse('g', 'getCustomer', CUSTOMER)), finished()]);
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model });

    expect(run.toolCalls[0]?.outcome).toBe('tool_error');
    const [result] = resultsIn(model.requests[1]?.messages[2]);
    expect(result?.is_error).toBe(true);
    expect(JSON.parse(result?.content ?? '{}')).toMatchObject({ code: 'rejected', retry: 'no' });
  });

  it('says so when the server has gone away, and carries on', async () => {
    const target = await crumple();
    const model = scriptedModel([
      async () => {
        await target.stop();
        return calling(toolUse('g', 'getCustomer', CUSTOMER));
      },
      finished('It was unreachable.'),
    ]);
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model });

    expect(run).toMatchObject({ stopped: 'done', text: 'It was unreachable.' });
    expect(run.toolCalls[0]?.outcome).toBe('unreachable');
    const [result] = resultsIn(model.requests[1]?.messages[2]);
    expect(result).toMatchObject({ is_error: true, content: 'The tool gave no answer: unreachable.' });
  });
});

describe('how a run ends', () => {
  it('runs no tools from a turn cut off by max_tokens, because its arguments may be cut off too', async () => {
    const target = await crumple();
    const model = scriptedModel([reply([toolUse('p', 'createPayment', PAYMENT)], 'max_tokens')]);
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.write }, model });

    expect(run).toMatchObject({ stopped: 'max_tokens', toolCalls: [] });
    expect(target.upstream.requests()).toEqual([]);
  });

  it('notices a model\'s refusal, which arrives as a normal answer, and keeps its category', async () => {
    const target = await crumple();
    const model = scriptedModel([reply([], 'refusal', { stop_details: { category: 'cyber' } })]);
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model });
    expect(run).toMatchObject({ stopped: 'model_refused', refusalCategory: 'cyber', text: '' });
  });

  it('copes with a refusal that gives no details', async () => {
    const target = await crumple();
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model: scriptedModel([reply([], 'refusal')]) });
    expect(run).toMatchObject({ stopped: 'model_refused', refusalCategory: null });
  });

  it('stops and names a stop reason it doesn\'t know, rather than guessing', async () => {
    const target = await crumple();
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model: scriptedModel([reply([], 'pause_turn')]) });
    expect(run).toMatchObject({ stopped: 'unexpected_stop', unexpectedStop: 'pause_turn' });
  });

  it('stops when a different model answers, because a score from it would measure nothing', async () => {
    const target = await crumple();
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model: scriptedModel([reply([], 'end_turn', { model: 'claude-opus-5-5' })]) });
    expect(run.stopped).toBe('wrong_model');
  });

  it('carries on when the model that answered is the one asked for', async () => {
    const target = await crumple();
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model: scriptedModel([reply([], 'end_turn', { model: 'claude-haiku-5-5' })]) });
    expect(run.stopped).toBe('done');
  });

  it('stops at the turn limit, however keen the model is', async () => {
    const target = await crumple();
    const again = calling(toolUse('g', 'getCustomer', CUSTOMER));
    const model = scriptedModel([again, again, again]);
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model, limits: { maxTurns: 2 } });
    expect(run).toMatchObject({ stopped: 'max_turns', turns: 2 });
    expect(model.requests).toHaveLength(2);
  });

  it('stops before running calls that would pass the tool limit, and runs none of them', async () => {
    const target = await crumple();
    const model = scriptedModel([calling(toolUse('a', 'getCustomer', CUSTOMER), toolUse('b', 'getCustomer', CUSTOMER), toolUse('c', 'getCustomer', CUSTOMER))]);
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model, limits: { maxToolCalls: 2 } });
    expect(run).toMatchObject({ stopped: 'max_tool_calls', toolCalls: [] });
    expect(target.upstream.requests()).toEqual([]);
  });

  it('stops at the deadline while waiting for a model', async () => {
    const target = await crumple();
    const model = scriptedModel([
      (_request, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { resolve({ ok: false, code: 'timeout' }); });
      }),
    ]);
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model, limits: { deadlineMs: 100 } });
    expect(run.stopped).toBe('deadline');
  });

  it('stops at the deadline between turns', async () => {
    const target = await crumple({ fault: 'delay=200' });
    const model = scriptedModel([calling(toolUse('g', 'getCustomer', CUSTOMER))]);
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model, limits: { deadlineMs: 100 } });
    expect(run.stopped).toBe('deadline');
    expect(model.requests).toHaveLength(1);
  });

  it('reports a model failure with its code and request id, and nothing else from the answer', async () => {
    const target = await crumple();
    const model = scriptedModel([{ ok: false, code: 'overloaded', status: 529, requestId: 'req_1' }]);
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model });
    expect(run).toMatchObject({ stopped: 'model_error', modelError: { code: 'overloaded', status: 529, requestId: 'req_1' } });
  });

  it('reports a bare model failure too', async () => {
    const target = await crumple();
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model: scriptedModel([{ ok: false, code: 'unreachable' }]) });
    expect(run.modelError).toEqual({ code: 'unreachable' });
  });

  it('stops without a word when the money has run out', async () => {
    const target = await crumple();
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model: scriptedModel([{ ok: false, code: 'max_usd' }]) });
    expect(run.stopped).toBe('max_usd');
  });
});

describe('the tools a server offers', () => {
  const servers: RecordingServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });
  const fake = async (options: Parameters<typeof recordingServer>[0]) => {
    const server = await recordingServer(options);
    servers.push(server);
    return server;
  };

  it('spends nothing when it can\'t connect', async () => {
    const model = scriptedModel([]);
    const run = await runAgent({ task: 't', mcp: { url: 'http://127.0.0.1:9/mcp' }, model });
    expect(run.stopped).toBe('mcp_unavailable');
    expect(run.notes.join(' ')).toContain('Couldn\'t connect');
    expect(model.requests).toEqual([]);
  });

  it('leaves out a name Claude won\'t accept and says so, rather than renaming it', async () => {
    const { url } = await fake({ tools: [{ name: 'has.dot', description: 'd', inputSchema: { type: 'object' } }, { name: 'fine', description: 'd', inputSchema: { type: 'object' } }] });
    const model = scriptedModel([finished()]);
    const run = await runAgent({ task: 't', mcp: { url }, model });
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual(['fine']);
    expect(run.notes.join(' ')).toContain('won\'t accept');
  });

  it('copes with a tool that has no description or schema', async () => {
    const { url } = await fake({ tools: [{ name: 'bare' }] });
    const model = scriptedModel([finished()]);
    await runAgent({ task: 't', mcp: { url }, model });
    expect(model.requests[0]?.tools).toEqual([{ name: 'bare', input_schema: { type: 'object' } }]);
  });

  it('says so when the list never finishes', async () => {
    const { url } = await fake({ endlessPages: true });
    const run = await runAgent({ task: 't', mcp: { url }, model: scriptedModel([finished()]) });
    expect(run.notes.join(' ')).toContain('didn\'t finish');
  });

  it('cuts a huge result, and says it did', async () => {
    const huge = 'x'.repeat(MAX_RESULT_CHARS + 50);
    const { url } = await fake({
      callResult: (call) => new Response(
        JSON.stringify({ jsonrpc: '2.0', id: (JSON.parse(call.rawBody) as { id: unknown }).id, result: { resultType: 'complete', content: [{ type: 'text', text: huge }] } }),
        { headers: { 'content-type': 'application/json' } },
      ),
    });
    const model = scriptedModel([calling(toolUse('b', 'getThing', {})), finished()]);
    await runAgent({ task: 't', mcp: { url }, model });
    const [result] = resultsIn(model.requests[1]?.messages[2]);
    expect(result?.content).toContain('Cut by the agent');
    expect(result?.content.length).toBeLessThan(MAX_RESULT_CHARS + 200);
  });
});
