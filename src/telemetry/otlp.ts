import type { SpanKind, SpanRecord, SpanSink } from './span.js';

// Spans in OTLP's JSON form, so Jaeger, Tempo, Honeycomb and the rest can read them. This
// is why writing our own small tracer costs users nothing: the format is what gives them
// freedom, and we only have to produce it.
//
// Sends only to an address the user typed. Nothing in the package creates this sink
// unless an endpoint was configured.

const KIND: Record<SpanKind, number> = { internal: 1, server: 2, client: 3 };
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;
const SCOPE_NAME = 'crumple-mcp';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_BATCH_SIZE = 512;
const DEFAULT_MAX_QUEUE = 2_048;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number };

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: OtlpValue }[];
  status: { code: number };
}

export interface OtlpExport {
  resourceSpans: {
    resource: { attributes: { key: string; value: OtlpValue }[] };
    scopeSpans: { scope: { name: string; version?: string }; spans: OtlpSpan[] }[];
  }[];
}

export interface OtlpIdentity {
  serviceName?: string;
  version?: string;
}

// 64-bit integers are strings in OTLP's JSON, because they don't fit a JSON number safely.
const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();

function value(raw: string | number): OtlpValue {
  if (typeof raw === 'string') return { stringValue: raw };
  return Number.isInteger(raw) ? { intValue: String(raw) } : { doubleValue: raw };
}

function toOtlpSpan(span: SpanRecord): OtlpSpan {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    name: span.name,
    kind: KIND[span.kind],
    startTimeUnixNano: nanos(span.startMs),
    endTimeUnixNano: nanos(span.endMs),
    attributes: Object.entries(span.attributes).map(([key, raw]) => ({ key, value: value(raw) })),
    status: { code: span.attributes['error.type'] === undefined ? STATUS_UNSET : STATUS_ERROR },
  };
}

export function toOtlp(spans: SpanRecord[], identity: OtlpIdentity = {}): OtlpExport {
  const { serviceName = 'crumple', version } = identity;
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: SCOPE_NAME, ...(version === undefined ? {} : { version }) },
        spans: spans.map(toOtlpSpan),
      }],
    }],
  };
}

export interface OtlpSinkOptions extends OtlpIdentity {
  /** The full address, such as http://127.0.0.1:4318/v1/traces. */
  endpoint: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  batchSize?: number;
  maxQueue?: number;
  flushIntervalMs?: number;
  /** Runs a function later. Injected so tests control when. */
  schedule?: (run: () => void, ms: number) => void;
}

export interface OtlpSink extends SpanSink {
  /** Spans lost to a full queue or a failed send. They're counted, never retried. */
  lost(): number;
}

function defaultSchedule(run: () => void, ms: number): void {
  const timer = setTimeout(run, ms) as unknown as { unref?: () => void };
  // A waiting export shouldn't keep a command-line process alive. Workers has no unref.
  timer.unref?.();
}

export function otlpSink(options: OtlpSinkOptions): OtlpSink {
  const {
    endpoint,
    headers = {},
    fetch: send = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    maxQueue = DEFAULT_MAX_QUEUE,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    schedule = defaultSchedule,
  } = options;

  const queue: SpanRecord[] = [];
  let lost = 0;
  let draining: Promise<void> | undefined;
  let scheduled = false;

  async function sendBatch(batch: SpanRecord[]): Promise<void> {
    try {
      const response = await send(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(toOtlp(batch, options)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      if (!response.ok) lost += batch.length;
    } catch {
      // Telemetry can't hurt a call. A collector that's down loses spans and nothing else.
      lost += batch.length;
    }
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) await sendBatch(queue.splice(0, batchSize));
  }

  function start(): Promise<void> {
    draining ??= drain().finally(() => {
      draining = undefined;
    });
    return draining;
  }

  return {
    export(span) {
      queue.push(span);
      if (queue.length > maxQueue) {
        queue.shift();
        lost += 1;
      }
      if (queue.length >= batchSize) {
        void start();
      } else if (!scheduled) {
        scheduled = true;
        schedule(() => {
          scheduled = false;
          void start();
        }, flushIntervalMs);
      }
    },
    flush: start,
    lost: () => lost,
  };
}
