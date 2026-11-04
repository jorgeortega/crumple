import type { SpanRecord, SpanSink } from './span.js';

const DEFAULT_CAPACITY = 10_000;

export interface MemorySink extends SpanSink {
  spans(): SpanRecord[];
  trace(traceId: string): SpanRecord[];
  dropped(): number;
  clear(): void;
}

// A ring, so a long-running server can't run out of memory keeping its own history.
export function memorySink(options: { capacity?: number } = {}): MemorySink {
  const { capacity = DEFAULT_CAPACITY } = options;
  let ring: SpanRecord[] = [];
  let next = 0;
  let dropped = 0;

  const spans = () => (ring.length < capacity ? [...ring] : [...ring.slice(next), ...ring.slice(0, next)]);

  return {
    export(span) {
      if (ring.length < capacity) {
        ring.push(span);
        return;
      }
      ring[next] = span;
      next = (next + 1) % capacity;
      dropped += 1;
    },
    spans,
    trace: (traceId) => spans().filter((span) => span.traceId === traceId),
    dropped: () => dropped,
    clear() {
      ring = [];
      next = 0;
    },
  };
}

// For `demo` and `prove`: one trace as a tree, for people rather than tools.
export function formatTrace(spans: SpanRecord[]): string {
  const ids = new Set(spans.map((span) => span.spanId));
  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs);
  const lines: string[] = [];

  function write(span: SpanRecord, depth: number): void {
    const error = span.attributes['error.type'];
    const parts = [`${'  '.repeat(depth)}${span.name}`, span.kind, `${span.endMs - span.startMs} ms`];
    lines.push([...parts, ...(error === undefined ? [] : [`error: ${error}`])].join('  '));
    for (const child of ordered) {
      if (child.parentSpanId === span.spanId) write(child, depth + 1);
    }
  }

  // A parent that isn't here is in another process, such as the caller's.
  for (const span of ordered) {
    if (span.parentSpanId === undefined || !ids.has(span.parentSpanId)) write(span, 0);
  }
  return lines.join('\n');
}
