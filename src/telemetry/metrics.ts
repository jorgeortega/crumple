import type { SpanRecord, SpanSink } from './span.js';

// Latency and counts come from the same records as the traces, rather than a second system
// that could disagree with them. The buckets are the ones OpenTelemetry specifies for
// mcp.server.operation.duration. They aren't exported as OTLP metrics in this version: a
// trace backend can derive them from spans.
export const DURATION_BUCKETS_S = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

const TOP_BOUNDARY_S = 300;
const OTHER = 'other';

export interface OperationMetric {
  count: number;
  sumSeconds: number;
  /** One count per bucket, plus a last one for anything past the top boundary. */
  buckets: number[];
  errors: Record<string, number>;
  /** Estimates, because a histogram only knows which bucket a value fell in. */
  p50Seconds: number;
  p95Seconds: number;
  p99Seconds: number;
}

export interface MetricsSnapshot {
  operations: Record<string, OperationMetric>;
}

export interface MetricsSink extends SpanSink {
  snapshot(): MetricsSnapshot;
}

interface Totals {
  count: number;
  sumSeconds: number;
  buckets: number[];
  errors: Map<string, number>;
}

function bucketIndex(seconds: number): number {
  const index = DURATION_BUCKETS_S.findIndex((boundary) => seconds <= boundary);
  return index === -1 ? DURATION_BUCKETS_S.length : index;
}

const boundaryAt = (index: number) => DURATION_BUCKETS_S[index] ?? TOP_BOUNDARY_S;

function percentile(totals: Totals, fraction: number): number {
  const rank = totals.count * fraction;
  let seen = 0;
  for (const [index, inBucket] of totals.buckets.entries()) {
    if (inBucket === 0 || seen + inBucket < rank) {
      seen += inBucket;
      continue;
    }
    // Past the top there's no upper boundary, so report the top rather than invent one.
    if (index === DURATION_BUCKETS_S.length) return boundaryAt(index);
    const lower = index === 0 ? 0 : boundaryAt(index - 1);
    return lower + (boundaryAt(index) - lower) * ((rank - seen) / inBucket);
  }
  return 0;
}

export function metricsSink(options: { maxOperations?: number; maxErrorTypes?: number } = {}): MetricsSink {
  // A refused call can name any tool, so names are capped or a caller could fill memory.
  const { maxOperations = 1_000, maxErrorTypes = 100 } = options;
  const operations = new Map<string, Totals>();

  function totalsFor(key: string): Totals {
    const name = operations.has(key) || operations.size < maxOperations ? key : OTHER;
    let totals = operations.get(name);
    if (!totals) {
      totals = { count: 0, sumSeconds: 0, buckets: new Array<number>(DURATION_BUCKETS_S.length + 1).fill(0), errors: new Map() };
      operations.set(name, totals);
    }
    return totals;
  }

  return {
    export(span: SpanRecord) {
      const method = span.attributes['mcp.method.name'];
      if (span.kind !== 'server' || method === undefined) return;

      const tool = span.attributes['gen_ai.tool.name'];
      const totals = totalsFor(tool === undefined ? method : `${method} ${tool}`);
      const seconds = (span.endMs - span.startMs) / 1000;
      const index = bucketIndex(seconds);

      totals.count += 1;
      totals.sumSeconds += seconds;
      totals.buckets[index] = (totals.buckets[index] ?? 0) + 1;

      const errorType = span.attributes['error.type'];
      if (errorType !== undefined) {
        const key = totals.errors.has(errorType) || totals.errors.size < maxErrorTypes ? errorType : OTHER;
        totals.errors.set(key, (totals.errors.get(key) ?? 0) + 1);
      }
    },
    snapshot() {
      const result: MetricsSnapshot = { operations: {} };
      for (const [name, totals] of operations) {
        result.operations[name] = {
          count: totals.count,
          sumSeconds: totals.sumSeconds,
          buckets: [...totals.buckets],
          errors: Object.fromEntries(totals.errors),
          p50Seconds: percentile(totals, 0.5),
          p95Seconds: percentile(totals, 0.95),
          p99Seconds: percentile(totals, 0.99),
        };
      }
      return result;
    },
  };
}
