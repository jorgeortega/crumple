import { describe, expect, it, vi } from 'vitest';
import { ATTRIBUTES, type Attributes } from './attributes.js';
import { createTelemetry, memorySink, parseTraceparent, type SpanSink, type TelemetryOptions } from './index.js';

// Fixed time and ids, so every assertion is exact and nothing depends on a clock.
function setup(options: TelemetryOptions = {}) {
  let clock = 1_000;
  let id = 0;
  const memory = memorySink();
  const telemetry = createTelemetry({
    sinks: [memory],
    now: () => clock,
    randomId: (bytes) => (++id).toString(16).padStart(bytes * 2, '0'),
    strict: true,
    ...options,
  });
  return { telemetry, memory, tick: (ms: number) => (clock += ms) };
}

describe('spans', () => {
  it('records name, kind, times and attributes when it ends', () => {
    const { telemetry, memory, tick } = setup();
    const span = telemetry.startSpan('tools/call get_customer', {
      kind: 'server',
      attributes: { 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': 'get_customer' },
    });
    tick(25);
    span.end({ attributes: { 'crumple.decision': 'allow' } });

    expect(memory.spans()).toEqual([{
      traceId: span.context.traceId,
      spanId: span.context.spanId,
      name: 'tools/call get_customer',
      kind: 'server',
      startMs: 1_000,
      endMs: 1_025,
      attributes: { 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': 'get_customer', 'crumple.decision': 'allow' },
    }]);
  });

  it('records nothing until it ends, and only once', () => {
    const { telemetry, memory } = setup();
    const span = telemetry.startSpan('execute');
    expect(memory.spans()).toEqual([]);
    span.end();
    span.end();
    span.setAttributes({ 'crumple.decision': 'allow' });
    expect(memory.spans()).toHaveLength(1);
    expect(memory.spans()[0]?.attributes).toEqual({});
  });

  it('defaults to an internal span', () => {
    const { telemetry, memory } = setup();
    telemetry.startSpan('authorize').end();
    expect(memory.spans()[0]?.kind).toBe('internal');
  });

  it('records a failure as error.type', () => {
    const { telemetry, memory } = setup();
    telemetry.startSpan('GET /customers/{id}', { kind: 'client' }).end({ errorType: '503' });
    expect(memory.spans()[0]?.attributes['error.type']).toBe('503');
  });

  it('nests children under one trace', () => {
    const { telemetry, memory } = setup();
    const server = telemetry.startSpan('tools/call x', { kind: 'server' });
    const execute = server.child('execute');
    const attempt = execute.child('GET /customers/{id}', { kind: 'client' });
    attempt.end();
    execute.end();
    server.end();

    const [recordedAttempt, recordedExecute, recordedServer] = memory.spans();
    expect(recordedAttempt?.parentSpanId).toBe(execute.context.spanId);
    expect(recordedExecute?.parentSpanId).toBe(server.context.spanId);
    expect(recordedServer?.parentSpanId).toBeUndefined();
    expect(new Set(memory.spans().map((span) => span.traceId)).size).toBe(1);
  });

  // C11: this is what joins the agent's trace to the server's.
  it('continues a trace from a caller\'s traceparent', () => {
    const { telemetry, memory } = setup();
    const trace = '0af7651916cd43dd8448eb211c80319c';
    const parent = parseTraceparent(`00-${trace}-b7ad6b7169203331-01`);
    telemetry.startSpan('tools/call x', { kind: 'server', ...(parent ? { parent } : {}) }).end();
    expect(memory.spans()[0]?.traceId).toBe(trace);
    expect(memory.spans()[0]?.parentSpanId).toBe('b7ad6b7169203331');
  });

  it('gives each root its own trace', () => {
    const { telemetry } = setup();
    expect(telemetry.startSpan('a').context.traceId).not.toBe(telemetry.startSpan('b').context.traceId);
  });

  it('writes a traceparent an upstream API can continue from', () => {
    const { telemetry } = setup();
    const span = telemetry.startSpan('a');
    expect(parseTraceparent(span.traceparent())).toEqual(span.context);
  });

  it('makes valid random ids when none are injected', () => {
    const telemetry = createTelemetry();
    const { traceId, spanId } = telemetry.startSpan('a').context;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('what can get in', () => {
  it('drops an unknown key and counts it, outside tests', () => {
    const { telemetry, memory } = setup({ strict: false });
    const attributes = { 'tool.arguments': '{"card":"4242"}', 'crumple.decision': 'allow' } as unknown as Attributes;
    telemetry.startSpan('a', { attributes }).end();
    expect(memory.spans()[0]?.attributes).toEqual({ 'crumple.decision': 'allow' });
    expect(telemetry.droppedAttributes()).toBe(1);
  });

  it('throws on an unknown key under test, so a developer finds out at once', () => {
    const { telemetry } = setup();
    const attributes = { 'tool.arguments': 'x' } as unknown as Attributes;
    expect(() => telemetry.startSpan('a', { attributes })).toThrow('tool.arguments');
  });

  it('drops a value of the wrong type', () => {
    const { telemetry, memory } = setup({ strict: false });
    const attributes = {
      'gen_ai.usage.input_tokens': 'lots',
      'crumple.decision': 7,
      'crumple.cost_usd': Number.NaN,
    } as unknown as Attributes;
    telemetry.startSpan('a', { attributes }).end();
    expect(memory.spans()[0]?.attributes).toEqual({});
    expect(telemetry.droppedAttributes()).toBe(3);
  });

  // The conventions make these opt-in. The owner decided there's no opt-in here at all.
  it.each([
    'gen_ai.tool.call.arguments',
    'gen_ai.tool.call.result',
    'http.request.body',
    'http.request.header.authorization',
    'url.full',
    'url.path',
    'url.query',
  ])('has no way to record %s', (key) => {
    expect(Object.keys(ATTRIBUTES)).not.toContain(key);
  });

  it('caps long values, so a caller can\'t bloat a trace', () => {
    const { telemetry, memory } = setup();
    telemetry.startSpan('n'.repeat(1000), { attributes: { 'jsonrpc.request.id': 'x'.repeat(1000) } }).end();
    expect(memory.spans()[0]?.attributes['jsonrpc.request.id']).toHaveLength(256);
    expect(memory.spans()[0]?.name).toHaveLength(256);
  });

  const SECRET = 'fake-upstream-credential-value';
  const stringKeys = (Object.entries(ATTRIBUTES) as [keyof Attributes, string][])
    .filter(([, type]) => type === 'string')
    .map(([key]) => key);

  // C4: some allowed values come from outside, so this path is tested for every one of them.
  it.each(stringKeys)('replaces a registered secret in %s', (key) => {
    const { telemetry, memory } = setup();
    telemetry.addSecret(SECRET);
    telemetry.startSpan('a', { attributes: { [key]: `oops ${SECRET} oops` } }).end();
    expect(JSON.stringify(memory.spans())).not.toContain(SECRET);
    expect(memory.spans()[0]?.attributes[key]).toBe('[redacted]');
  });

  it('replaces a registered secret in a span name and an error type', () => {
    const { telemetry, memory } = setup({ secrets: [SECRET] });
    telemetry.startSpan(`tools/call ${SECRET}`).end({ errorType: `boom ${SECRET}` });
    expect(JSON.stringify(memory.spans())).not.toContain(SECRET);
  });

  // Capping first could cut a secret in half, and half a secret wouldn't match.
  it('checks for secrets before capping, so a long value can\'t hide part of one', () => {
    const { telemetry, memory } = setup({ secrets: [SECRET] });
    const value = `${'x'.repeat(240)}${SECRET}`;
    telemetry.startSpan('a', { attributes: { 'jsonrpc.request.id': value } }).end();
    expect(memory.spans()[0]?.attributes['jsonrpc.request.id']).toBe('[redacted]');
  });

  it('ignores an empty secret, which would otherwise match everything', () => {
    const { telemetry, memory } = setup({ secrets: [''] });
    telemetry.addSecret('');
    telemetry.startSpan('a', { attributes: { 'crumple.decision': 'allow' } }).end();
    expect(memory.spans()[0]?.attributes['crumple.decision']).toBe('allow');
  });
});

describe('telemetry can\'t hurt a call', () => {
  it('keeps going when a sink throws, and counts the failure', () => {
    const broken: SpanSink = {
      export: () => {
        throw new Error('sink is down');
      },
    };
    const working = memorySink();
    const { telemetry } = setup({ sinks: [broken, working] });
    expect(() => {
      telemetry.startSpan('a').end();
    }).not.toThrow();
    expect(telemetry.sinkFailures()).toBe(1);
    expect(working.spans()).toHaveLength(1);
  });

  it('flushes every sink, and survives one failing', async () => {
    const flushed = vi.fn(() => Promise.resolve());
    const broken = vi.fn(() => Promise.reject(new Error('no')));
    const { telemetry } = setup({
      sinks: [
        { export: () => undefined, flush: flushed },
        { export: () => undefined, flush: broken },
        { export: () => undefined },
      ],
    });
    await expect(telemetry.flush()).resolves.toBeUndefined();
    expect(flushed).toHaveBeenCalledOnce();
    expect(telemetry.sinkFailures()).toBe(1);
  });

  it('sends nothing anywhere by default', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const telemetry = createTelemetry();
    telemetry.startSpan('a').child('b').end();
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
