import { ATTRIBUTES, type AttributeName, type Attributes } from './attributes.js';
import { formatTraceparent, type TraceContext } from './traceparent.js';

export type SpanKind = 'internal' | 'server' | 'client';

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs: number;
  attributes: Attributes;
}

export interface SpanSink {
  export(span: SpanRecord): void;
  flush?(): Promise<void>;
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
}

export interface EndOptions {
  attributes?: Attributes;
  /** A short code from our own list, never an upstream's error text. */
  errorType?: string;
}

export interface Span {
  readonly context: TraceContext;
  setAttributes(attributes: Attributes): void;
  child(name: string, options?: SpanOptions): Span;
  traceparent(): string;
  end(options?: EndOptions): void;
}

export interface TelemetryOptions {
  sinks?: SpanSink[];
  /** Milliseconds since the epoch. Injected so tests are exact. */
  now?: () => number;
  /** Lowercase hex for this many random bytes. Injected so tests are exact. */
  randomId?: (bytes: number) => string;
  /** Values that must never appear in a record, such as the upstream credential. */
  secrets?: Iterable<string>;
  /** Throw on an attribute that isn't allowed, rather than dropping it. For tests. */
  strict?: boolean;
}

export interface Telemetry {
  startSpan(name: string, options?: SpanOptions & { parent?: TraceContext }): Span;
  addSecret(secret: string): void;
  /** Cleans a value the way span values are cleaned, for records other than spans. */
  clean(value: string): string;
  now(): number;
  droppedAttributes(): number;
  sinkFailures(): number;
  /** Sends what's waiting. On Workers, pass the promise to waitUntil. */
  flush(): Promise<void>;
}

const MAX_VALUE_LENGTH = 256;
const REDACTED = '[redacted]';
const SAMPLED = '01';
const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;

function defaultRandomId(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  const { sinks = [], now = () => Date.now(), randomId = defaultRandomId, strict = false } = options;

  const secrets = new Set<string>();
  let dropped = 0;
  let failures = 0;

  function addSecret(secret: string): void {
    // An empty string is "contained" in every value, so it would redact everything.
    if (secret !== '') secrets.add(secret);
  }
  for (const secret of options.secrets ?? []) addSecret(secret);

  // Secrets are checked before capping: a cap could cut one in half, and half a secret
  // wouldn't match. The whole value goes, since what surrounds a secret can describe it.
  function clean(value: string): string {
    for (const secret of secrets) {
      if (value.includes(secret)) return REDACTED;
    }
    return value.length > MAX_VALUE_LENGTH ? value.slice(0, MAX_VALUE_LENGTH) : value;
  }

  function refuse(name: string, why: string): void {
    if (strict) throw new Error(`Telemetry can't record ${name}: ${why}. Allowed attributes are in attributes.ts.`);
    dropped += 1;
  }

  function merge(target: Attributes, incoming: Attributes): void {
    for (const [name, value] of Object.entries(incoming) as [AttributeName, unknown][]) {
      const type = (ATTRIBUTES as Record<string, string | undefined>)[name];
      if (type === undefined) {
        refuse(name, 'it isn\'t on the allowlist');
      } else if (type === 'string' && typeof value === 'string') {
        Object.assign(target, { [name]: clean(value) });
      } else if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
        Object.assign(target, { [name]: value });
      } else {
        refuse(name, `its value isn't a ${type}`);
      }
    }
  }

  function exportSpan(record: SpanRecord): void {
    // Telemetry must never hurt a call: a broken sink loses spans and nothing else.
    for (const sink of sinks) {
      try {
        sink.export(record);
      } catch {
        failures += 1;
      }
    }
  }

  function start(name: string, kind: SpanKind, attributes: Attributes, parent: TraceContext | undefined): Span {
    const context: TraceContext = {
      traceId: parent?.traceId ?? randomId(TRACE_ID_BYTES),
      spanId: randomId(SPAN_ID_BYTES),
      flags: parent?.flags ?? SAMPLED,
    };
    const collected: Attributes = {};
    merge(collected, attributes);
    const startMs = now();
    let ended = false;

    return {
      context,
      setAttributes(more) {
        if (!ended) merge(collected, more);
      },
      child: (childName, childOptions = {}) =>
        start(childName, childOptions.kind ?? 'internal', childOptions.attributes ?? {}, context),
      traceparent: () => formatTraceparent(context),
      end(endOptions = {}) {
        if (ended) return;
        ended = true;
        merge(collected, endOptions.attributes ?? {});
        if (endOptions.errorType !== undefined) merge(collected, { 'error.type': endOptions.errorType });
        exportSpan({
          traceId: context.traceId,
          spanId: context.spanId,
          ...(parent ? { parentSpanId: parent.spanId } : {}),
          name: clean(name),
          kind,
          startMs,
          endMs: now(),
          attributes: collected,
        });
      },
    };
  }

  return {
    startSpan: (name, spanOptions = {}) =>
      start(name, spanOptions.kind ?? 'internal', spanOptions.attributes ?? {}, spanOptions.parent),
    addSecret,
    clean,
    now,
    droppedAttributes: () => dropped,
    sinkFailures: () => failures,
    async flush() {
      const results = await Promise.allSettled(sinks.map(async (sink) => {
        await sink.flush?.();
      }));
      failures += results.filter((result) => result.status === 'rejected').length;
    },
  };
}
