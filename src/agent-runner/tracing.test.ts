import { afterEach, describe, expect, it } from 'vitest';
import { calling, finished, reply, scriptedModel, toolUse } from '../../tests/helpers/fake-claude.js';
import { startCrumple } from '../cli/prove.js';
import { agentChecks, type Target, type TargetSetup, type TracingAgent } from '../prove/index.js';
import { runChecks } from '../prove/checks.js';
import { createTelemetry, memorySink } from '../telemetry/index.js';
import { runAgent } from './loop.js';

// C11, over real sockets: the agent's spans and Crumple's spans, in one trace.

const started: Target[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((target) => target.stop().catch(() => undefined)));
});
async function crumple(setup: TargetSetup = {}): Promise<Target> {
  const target = await startCrumple(setup);
  started.push(target);
  return target;
}

const CUSTOMER = { id: 'cus_1' };
const SECRET_TASK = 'a-task-that-must-not-reach-a-span';
const SECRET_ARGUMENT = 'an-argument-that-must-not-reach-a-span';

async function traced(target: Target, script: Parameters<typeof scriptedModel>[0], options: { key?: keyof Target['keys'] } = {}) {
  const sink = memorySink();
  // Strict, so anything off the allowlist fails the test instead of being dropped quietly.
  const telemetry = createTelemetry({ sinks: [sink], strict: true });
  const run = await runAgent({ task: SECRET_TASK, mcp: { url: target.url, token: target.keys[options.key ?? 'read'] }, model: scriptedModel(script), telemetry });
  return { run, spans: sink.spans() };
}

describe('the agent\'s spans', () => {
  it('have the shape the telemetry spec gives them, with tokens on the model call', async () => {
    const target = await crumple();
    const { run, spans } = await traced(target, [calling(toolUse('g', 'getCustomer', CUSTOMER)), finished()]);

    const root = spans.find((span) => span.name === 'invoke_agent');
    expect(root?.traceId).toBe(run.traceId);
    expect(root?.parentSpanId).toBeUndefined();
    expect(root?.attributes['crumple.cost_usd']).toBe(run.costUsd);

    const chats = spans.filter((span) => span.name === 'chat claude-haiku-5-5');
    expect(chats).toHaveLength(2);
    expect(chats[0]).toMatchObject({ kind: 'client', parentSpanId: root?.spanId });
    expect(chats[0]?.attributes).toMatchObject({ 'gen_ai.provider.name': 'anthropic', 'gen_ai.request.model': 'claude-haiku-5-5', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20, 'gen_ai.usage.cache_read.input_tokens': 0, 'gen_ai.usage.cache_write.input_tokens': 0 });
    expect(chats[0]?.attributes['crumple.cost_usd']).toBeGreaterThan(0);

    expect(spans.find((span) => span.name === 'tools/call getCustomer')).toMatchObject({ kind: 'client', parentSpanId: root?.spanId, attributes: { 'gen_ai.tool.name': 'getCustomer', 'mcp.method.name': 'tools/call' } });
  });

  it('never hold the task, a tool\'s arguments or what the model said', async () => {
    const target = await crumple();
    const { spans } = await traced(target, [calling(toolUse('g', 'getCustomer', { id: SECRET_ARGUMENT })), finished('what-the-model-said')]);
    const text = JSON.stringify(spans);
    expect(text).not.toContain(SECRET_TASK);
    expect(text).not.toContain(SECRET_ARGUMENT);
    expect(text).not.toContain('what-the-model-said');
  });

  it('mark what went wrong: a refused tool, a model failure, and how the run ended', async () => {
    const target = await crumple();
    const { spans } = await traced(target, [calling(toolUse('d', 'deleteCustomer', CUSTOMER)), { ok: false, code: 'overloaded', status: 529 }]);
    expect(spans.find((span) => span.name === 'tools/call deleteCustomer')?.attributes['error.type']).toBe('refused');
    expect(spans.filter((span) => span.name.startsWith('chat')).at(-1)?.attributes['error.type']).toBe('overloaded');
    expect(spans.find((span) => span.name === 'invoke_agent')?.attributes['error.type']).toBe('model_error');
  });

  it('leave out what a reply didn\'t report, rather than recording a false 0', async () => {
    const target = await crumple();
    const { spans, run } = await traced(target, [reply([], 'end_turn', { usage: {} })]);
    const chat = spans.find((span) => span.name.startsWith('chat'));
    expect(chat?.attributes).not.toHaveProperty('gen_ai.usage.input_tokens');
    expect(chat?.attributes).not.toHaveProperty('crumple.cost_usd');
    expect(run.costUsd).toBeNull();
    expect(spans.find((span) => span.name === 'invoke_agent')?.attributes).not.toHaveProperty('crumple.cost_usd');
  });

  it('end even when something throws', async () => {
    const target = await crumple();
    const sink = memorySink();
    await expect(runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model: scriptedModel([]), telemetry: createTelemetry({ sinks: [sink] }) })).rejects.toThrow();
    expect(sink.spans().find((span) => span.name === 'invoke_agent')?.attributes['error.type']).toBe('crashed');
  });

  it('exist without a sink, so a run always has a trace id', async () => {
    const target = await crumple();
    const run = await runAgent({ task: 't', mcp: { url: target.url, token: target.keys.read }, model: scriptedModel([finished()]) });
    expect(run.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('C11: one trace across the agent and the server', () => {
  it('joins them, so the server\'s span sits under the agent\'s call', async () => {
    const target = await crumple();
    const { run, spans } = await traced(target, [calling(toolUse('g', 'getCustomer', CUSTOMER)), finished()]);
    const server = target.spans?.().find((span) => span.kind === 'server' && span.name === 'tools/call getCustomer');
    expect(server?.traceId).toBe(run.traceId);
    expect(server?.parentSpanId).toBe(spans.find((span) => span.name === 'tools/call getCustomer')?.spanId);
  });

  it('gives each parallel call its own place in the trace', async () => {
    const target = await crumple();
    const { spans } = await traced(target, [calling(toolUse('a', 'getCustomer', CUSTOMER), toolUse('b', 'listCustomers', {})), finished()]);
    const mine = spans.filter((span) => span.name.startsWith('tools/call'));
    const parents = target.spans?.().filter((span) => span.kind === 'server' && span.name.startsWith('tools/call')).map((span) => span.parentSpanId);
    expect(new Set(parents)).toEqual(new Set(mine.map((span) => span.spanId)));
  });
});

describe('the trace-joined check can fail', () => {
  const outcome = async (agent: TracingAgent, start = startCrumple) => (await runChecks(agentChecks(agent), start))[0];

  const realAgent = (): TracingAgent => async (url, key) => {
    const sink = memorySink();
    const { traceId } = await runAgent({ task: 't', mcp: { url, token: key }, model: scriptedModel([calling(toolUse('g', 'getCustomer', CUSTOMER)), finished()]), telemetry: createTelemetry({ sinks: [sink] }) });
    return { traceId, callSpanId: sink.spans().find((span) => span.name === 'tools/call getCustomer')?.spanId ?? '' };
  };

  it('passes for the real thing', async () => {
    expect(await outcome(realAgent())).toMatchObject({ state: 'pass', claim: 'C11' });
  });

  it('fails when the agent\'s trace isn\'t the server\'s', async () => {
    const separate: TracingAgent = async (url, key) => ({ ...(await realAgent()(url, key)), traceId: '0'.repeat(32) });
    expect((await outcome(separate))?.detail).toContain('each started their own trace');
  });

  it('fails when the span isn\'t under the agent\'s call', async () => {
    const elsewhere: TracingAgent = async (url, key) => ({ ...(await realAgent()(url, key)), callSpanId: 'not-this-one' });
    expect((await outcome(elsewhere))?.detail).toContain('not under the agent');
  });

  it('fails on a server that keeps no spans', async () => {
    const silent: typeof startCrumple = async (setup) => {
      const target = await startCrumple(setup);
      return Object.fromEntries(Object.entries(target).filter(([name]) => name !== 'spans')) as unknown as Target;
    };
    expect((await outcome(realAgent(), silent))?.detail).toContain('kept no span');
  });

  it.each<[string, string, string]>([
    ['who called', 'crumple.caller', 'who called'],
    ['the decision', 'crumple.decision', 'permission decision'],
    ['the attempt', 'http.request.method', 'attempt'],
  ])('fails when the trace doesn\'t show %s', async (_name, attribute, expected) => {
    const missing: typeof startCrumple = async (setup) => {
      const target = await startCrumple(setup);
      return {
        ...target,
        spans: () => (target.spans?.() ?? []).map((span) => ({ ...span, attributes: Object.fromEntries(Object.entries(span.attributes).filter(([name]) => name !== attribute)) })),
      };
    };
    expect((await outcome(realAgent(), missing))?.detail).toContain(expected);
  });
});
