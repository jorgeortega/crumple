import { describe, expect, it } from 'vitest';
import { DURATION_BUCKETS_S, metricsSink, type SpanRecord } from './index.js';

function operation(ms: number, overrides: Partial<SpanRecord> = {}, tool = 'get_customer', errorType?: string): SpanRecord {
  return {
    traceId: 't',
    spanId: 's',
    name: `tools/call ${tool}`,
    kind: 'server',
    startMs: 0,
    endMs: ms,
    attributes: {
      'mcp.method.name': 'tools/call',
      'gen_ai.tool.name': tool,
      ...(errorType === undefined ? {} : { 'error.type': errorType }),
    },
    ...overrides,
  };
}

describe('metricsSink', () => {
  it('uses the buckets the conventions specify', () => {
    expect(DURATION_BUCKETS_S).toEqual([0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]);
  });

  it('counts each operation, by tool', () => {
    const sink = metricsSink();
    sink.export(operation(10));
    sink.export(operation(10));
    sink.export(operation(10, {}, 'delete_customer'));
    const { operations } = sink.snapshot();
    expect(operations['tools/call get_customer']?.count).toBe(2);
    expect(operations['tools/call delete_customer']?.count).toBe(1);
  });

  it('counts errors by type', () => {
    const sink = metricsSink();
    sink.export(operation(10, {}, 'get_customer', 'tool_error'));
    sink.export(operation(10, {}, 'get_customer', 'tool_error'));
    sink.export(operation(10, {}, 'get_customer', 'timeout'));
    sink.export(operation(10));
    expect(sink.snapshot().operations['tools/call get_customer']?.errors).toEqual({ tool_error: 2, timeout: 1 });
  });

  it('places durations in buckets, in seconds', () => {
    const sink = metricsSink();
    sink.export(operation(15));
    sink.export(operation(15));
    sink.export(operation(500));
    sink.export(operation(400_000));
    const metric = sink.snapshot().operations['tools/call get_customer'];
    expect(metric?.buckets[1]).toBe(2);
    expect(metric?.buckets[5]).toBe(1);
    expect(metric?.buckets.at(-1)).toBe(1);
    expect(metric?.buckets).toHaveLength(DURATION_BUCKETS_S.length + 1);
    expect(metric?.sumSeconds).toBeCloseTo(400.53);
  });

  it('estimates percentiles from the buckets, staying inside the right one', () => {
    const sink = metricsSink();
    for (let i = 0; i < 90; i += 1) sink.export(operation(15));
    for (let i = 0; i < 10; i += 1) sink.export(operation(700));
    const metric = sink.snapshot().operations['tools/call get_customer'];
    expect(metric?.p50Seconds).toBeGreaterThan(0.01);
    expect(metric?.p50Seconds).toBeLessThanOrEqual(0.02);
    expect(metric?.p99Seconds).toBeGreaterThan(0.5);
    expect(metric?.p99Seconds).toBeLessThanOrEqual(1);
  });

  it('reports the top boundary for durations past the last bucket, rather than inventing one', () => {
    const sink = metricsSink();
    sink.export(operation(400_000));
    expect(sink.snapshot().operations['tools/call get_customer']?.p99Seconds).toBe(300);
  });

  it('only counts server spans for MCP operations', () => {
    const sink = metricsSink();
    sink.export(operation(10, { kind: 'client' }));
    sink.export(operation(10, { attributes: {} }));
    expect(sink.snapshot().operations).toEqual({});
  });

  it('counts a method with no tool under the method alone', () => {
    const sink = metricsSink();
    sink.export(operation(10, { attributes: { 'mcp.method.name': 'tools/list' } }));
    expect(sink.snapshot().operations['tools/list']?.count).toBe(1);
  });

  // A refused call can name any tool, so a caller could otherwise fill memory with names.
  it('can\'t grow forever from made-up tool names', () => {
    const sink = metricsSink({ maxOperations: 2 });
    for (const tool of ['a', 'b', 'c', 'd']) sink.export(operation(10, {}, tool));
    const { operations } = sink.snapshot();
    expect(Object.keys(operations).sort()).toEqual(['other', 'tools/call a', 'tools/call b']);
    expect(operations['other']?.count).toBe(2);
  });

  it('can\'t grow forever from error types either', () => {
    const sink = metricsSink({ maxErrorTypes: 1 });
    sink.export(operation(10, {}, 'x', 'one'));
    sink.export(operation(10, {}, 'x', 'two'));
    sink.export(operation(10, {}, 'x', 'three'));
    expect(sink.snapshot().operations['tools/call x']?.errors).toEqual({ one: 1, other: 2 });
  });

  it('returns a snapshot a caller can\'t use to alter the totals', () => {
    const sink = metricsSink();
    sink.export(operation(10));
    const first = sink.snapshot();
    const metric = first.operations['tools/call get_customer'];
    if (metric) metric.count = 99;
    expect(sink.snapshot().operations['tools/call get_customer']?.count).toBe(1);
  });
});
