import { describe, expect, it } from 'vitest';
import { formatTrace, memorySink, type SpanRecord } from './index.js';

function record(overrides: Partial<SpanRecord>): SpanRecord {
  return {
    traceId: 't',
    spanId: 's',
    name: 'span',
    kind: 'internal',
    startMs: 0,
    endMs: 1,
    attributes: {},
    ...overrides,
  };
}

describe('memorySink', () => {
  it('keeps spans in the order they ended', () => {
    const sink = memorySink();
    sink.export(record({ spanId: 'a' }));
    sink.export(record({ spanId: 'b' }));
    expect(sink.spans().map((span) => span.spanId)).toEqual(['a', 'b']);
  });

  it('can\'t grow forever: past its capacity, the oldest go first', () => {
    const sink = memorySink({ capacity: 3 });
    for (const spanId of ['a', 'b', 'c', 'd', 'e']) sink.export(record({ spanId }));
    expect(sink.spans().map((span) => span.spanId)).toEqual(['c', 'd', 'e']);
    expect(sink.dropped()).toBe(2);
  });

  it('finds one trace', () => {
    const sink = memorySink();
    sink.export(record({ traceId: 'x', spanId: 'a' }));
    sink.export(record({ traceId: 'y', spanId: 'b' }));
    expect(sink.trace('x').map((span) => span.spanId)).toEqual(['a']);
  });

  it('clears', () => {
    const sink = memorySink();
    sink.export(record({}));
    sink.clear();
    expect(sink.spans()).toEqual([]);
  });

  it('returns a list a caller can\'t use to alter what was recorded', () => {
    const sink = memorySink();
    sink.export(record({}));
    sink.spans().pop();
    expect(sink.spans()).toHaveLength(1);
  });
});

describe('formatTrace', () => {
  it('shows a trace as a tree a person can read', () => {
    const output = formatTrace([
      record({ spanId: 'attempt-2', parentSpanId: 'server', name: 'GET /customers/{id}', kind: 'client', startMs: 40, endMs: 60, attributes: { 'http.request.resend_count': 1 } }),
      record({ spanId: 'attempt-1', parentSpanId: 'server', name: 'GET /customers/{id}', kind: 'client', startMs: 5, endMs: 20, attributes: { 'error.type': '503' } }),
      record({ spanId: 'server', name: 'tools/call get_customer', kind: 'server', startMs: 0, endMs: 70 }),
    ]);
    expect(output).toBe([
      'tools/call get_customer  server  70 ms',
      '  GET /customers/{id}  client  15 ms  error: 503',
      '  GET /customers/{id}  client  20 ms',
    ].join('\n'));
  });

  it('treats a span whose parent is elsewhere as a root, as with a remote caller', () => {
    expect(formatTrace([record({ parentSpanId: 'in-another-process', name: 'a' })])).toBe('a  internal  1 ms');
  });

  it('shows nothing for nothing', () => {
    expect(formatTrace([])).toBe('');
  });
});
