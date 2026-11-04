import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTelemetry, otlpSink, toOtlp, type SpanRecord } from './index.js';

// The official example from open-telemetry/opentelemetry-proto, examples/trace.json. What
// we send has to have this shape, or Jaeger, Tempo and the rest can't read it.
const sample = JSON.parse(readFileSync(new URL('../../tests/fixtures/otlp/trace.json', import.meta.url), 'utf8')) as {
  resourceSpans: {
    resource: { attributes: unknown[] };
    scopeSpans: { scope: Record<string, unknown>; spans: Record<string, unknown>[] }[];
  }[];
};

const SPAN: SpanRecord = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  parentSpanId: '00f067aa0ba902b7',
  name: 'tools/call get_customer',
  kind: 'server',
  startMs: 1_000,
  endMs: 1_250,
  attributes: {
    'mcp.method.name': 'tools/call',
    'http.response.status_code': 503,
    'crumple.cost_usd': 0.25,
  },
};

describe('toOtlp', () => {
  const output = toOtlp([SPAN], { serviceName: 'crumple', version: '1.2.3' });
  const span = output.resourceSpans[0]?.scopeSpans[0]?.spans[0];

  it('has the same structure as the official example', () => {
    const [resourceSpan] = output.resourceSpans;
    const [sampleResource] = sample.resourceSpans;
    expect(Object.keys(resourceSpan ?? {}).sort()).toEqual(Object.keys(sampleResource ?? {}).sort());
    const known = new Set([...Object.keys(sampleResource?.scopeSpans[0]?.spans[0] ?? {}), 'status']);
    for (const key of Object.keys(span ?? {})) expect(known).toContain(key);
  });

  it('names the service and the library', () => {
    const [resourceSpan] = output.resourceSpans;
    expect(resourceSpan?.resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'crumple' } }]);
    expect(resourceSpan?.scopeSpans[0]?.scope).toEqual({ name: 'crumple-mcp', version: '1.2.3' });
  });

  it('writes times in nanoseconds, as strings, because they don\'t fit a JSON number', () => {
    expect(span?.startTimeUnixNano).toBe('1000000000');
    expect(span?.endTimeUnixNano).toBe('1250000000');
  });

  it('writes ids and the parent', () => {
    expect(span?.traceId).toBe(SPAN.traceId);
    expect(span?.spanId).toBe(SPAN.spanId);
    expect(span?.parentSpanId).toBe(SPAN.parentSpanId);
  });

  it('leaves out the parent on a root span', () => {
    const root = { ...SPAN };
    delete root.parentSpanId;
    const rootOutput = toOtlp([root]).resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(rootOutput && 'parentSpanId' in rootOutput).toBe(false);
  });

  it.each([
    ['internal', 1],
    ['server', 2],
    ['client', 3],
  ] as const)('writes a %s span as kind %i', (kind, number) => {
    expect(toOtlp([{ ...SPAN, kind }]).resourceSpans[0]?.scopeSpans[0]?.spans[0]?.kind).toBe(number);
  });

  it('types attributes by value: whole numbers as strings, others as doubles', () => {
    expect(span?.attributes).toEqual([
      { key: 'mcp.method.name', value: { stringValue: 'tools/call' } },
      { key: 'http.response.status_code', value: { intValue: '503' } },
      { key: 'crumple.cost_usd', value: { doubleValue: 0.25 } },
    ]);
  });

  it('marks a span with an error.type as an error', () => {
    const failed = toOtlp([{ ...SPAN, attributes: { 'error.type': '503' } }]).resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(failed?.status).toEqual({ code: 2 });
    expect(span?.status).toEqual({ code: 0 });
  });
});

describe('otlpSink', () => {
  const ENDPOINT = 'http://127.0.0.1:4318/v1/traces';

  function setup(respond: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 200 }))) {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetchFn = vi.fn((url: string, init?: RequestInit) => {
      sent.push({ url, init: init ?? {} });
      return respond();
    });
    return { sent, fetchFn: fetchFn as unknown as typeof fetch };
  }

  it('sends what\'s waiting on flush, to the address it was given', async () => {
    const { sent, fetchFn } = setup();
    const sink = otlpSink({ endpoint: ENDPOINT, headers: { 'x-honeycomb-team': 'value' }, fetch: fetchFn, schedule: () => undefined });
    sink.export(SPAN);
    expect(sent).toHaveLength(0);
    await sink.flush?.();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(ENDPOINT);
    expect(sent[0]?.init.method).toBe('POST');
    expect(sent[0]?.init.headers).toEqual({ 'content-type': 'application/json', 'x-honeycomb-team': 'value' });
    const body = JSON.parse(sent[0]?.init.body as string) as ReturnType<typeof toOtlp>;
    expect(body.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name).toBe(SPAN.name);
  });

  it('sends nothing when there\'s nothing to send', async () => {
    const { sent, fetchFn } = setup();
    await otlpSink({ endpoint: ENDPOINT, fetch: fetchFn, schedule: () => undefined }).flush?.();
    expect(sent).toHaveLength(0);
  });

  it('sends when a batch fills', async () => {
    const { sent, fetchFn } = setup();
    const sink = otlpSink({ endpoint: ENDPOINT, fetch: fetchFn, batchSize: 2, schedule: () => undefined });
    sink.export(SPAN);
    expect(sent).toHaveLength(0);
    sink.export(SPAN);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
  });

  it('sends on a timer, so a quiet server still reports, and schedules it only once', async () => {
    const { sent, fetchFn } = setup();
    const timers: (() => void)[] = [];
    const sink = otlpSink({ endpoint: ENDPOINT, fetch: fetchFn, schedule: (run) => timers.push(run) });
    sink.export(SPAN);
    sink.export(SPAN);
    expect(timers).toHaveLength(1);
    timers[0]?.();
    await sink.flush?.();
    expect(sent).toHaveLength(1);
    sink.export(SPAN);
    expect(timers).toHaveLength(2);
  });

  it('schedules on a real timer by default', async () => {
    vi.useFakeTimers();
    const { sent, fetchFn } = setup();
    const sink = otlpSink({ endpoint: ENDPOINT, fetch: fetchFn, flushIntervalMs: 1000 });
    sink.export(SPAN);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await sink.flush?.();
    expect(sent).toHaveLength(1);
  });

  it('splits a large backlog into batches', async () => {
    const { sent, fetchFn } = setup();
    const sink = otlpSink({ endpoint: ENDPOINT, fetch: fetchFn, batchSize: 2, schedule: () => undefined });
    for (let i = 0; i < 5; i += 1) sink.export(SPAN);
    await sink.flush?.();
    expect(sent).toHaveLength(3);
  });

  // Telemetry can't hurt a call. A collector that's down loses spans and nothing else.
  it('counts spans it lost to a failed response', async () => {
    const { fetchFn } = setup(() => Promise.resolve(new Response('no', { status: 500 })));
    const sink = otlpSink({ endpoint: ENDPOINT, fetch: fetchFn, schedule: () => undefined });
    sink.export(SPAN);
    await expect(sink.flush?.()).resolves.toBeUndefined();
    expect(sink.lost()).toBe(1);
  });

  it('counts spans it lost to a network failure, without throwing', async () => {
    const { fetchFn } = setup(() => Promise.reject(new Error('connection refused')));
    const sink = otlpSink({ endpoint: ENDPOINT, fetch: fetchFn, schedule: () => undefined });
    sink.export(SPAN);
    await expect(sink.flush?.()).resolves.toBeUndefined();
    expect(sink.lost()).toBe(1);
  });

  it('gives up on a collector that hangs', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('timed out'));
        });
      })) as unknown as typeof fetch;
    const sink = otlpSink({ endpoint: ENDPOINT, fetch: hanging, timeoutMs: 1, schedule: () => undefined });
    sink.export(SPAN);
    await sink.flush?.();
    expect(sink.lost()).toBe(1);
  });

  it('doesn\'t make a span wait for a collector that hangs', () => {
    const never = (() => new Promise(() => undefined)) as unknown as typeof fetch;
    const sink = otlpSink({ endpoint: ENDPOINT, fetch: never, batchSize: 1, schedule: () => undefined });
    const telemetry = createTelemetry({ sinks: [sink] });
    expect(() => {
      telemetry.startSpan('a').end();
    }).not.toThrow();
  });

  it('holds a bounded queue, dropping the oldest and counting them', async () => {
    const { sent, fetchFn } = setup();
    const sink = otlpSink({ endpoint: ENDPOINT, fetch: fetchFn, batchSize: 100, maxQueue: 2, schedule: () => undefined });
    sink.export({ ...SPAN, name: 'first' });
    sink.export({ ...SPAN, name: 'second' });
    sink.export({ ...SPAN, name: 'third' });
    await sink.flush?.();
    expect(sink.lost()).toBe(1);
    const body = JSON.parse(sent[0]?.init.body as string) as ReturnType<typeof toOtlp>;
    expect(body.resourceSpans[0]?.scopeSpans[0]?.spans.map((span) => span.name)).toEqual(['second', 'third']);
  });

  // C4, on the path that actually leaves the machine.
  it('can\'t carry a registered secret out', async () => {
    const SECRET = 'fake-upstream-credential-value';
    const { sent, fetchFn } = setup();
    const sink = otlpSink({ endpoint: ENDPOINT, fetch: fetchFn, schedule: () => undefined });
    const telemetry = createTelemetry({ sinks: [sink], secrets: [SECRET] });
    telemetry.startSpan(`tools/call ${SECRET}`, { attributes: { 'jsonrpc.request.id': SECRET } }).end({ errorType: SECRET });
    await telemetry.flush();
    expect(sent[0]?.init.body).not.toContain(SECRET);
  });
});
