// W3C Trace Context, the id that joins one request's spans across processes.
// https://www.w3.org/TR/trace-context/
//
// A traceparent comes from the caller, so it's untrusted. Anything off means "no parent"
// and a new trace, never an error: a bad trace id must not stop a tool call.

export interface TraceContext {
  traceId: string;
  spanId: string;
  flags: string;
}

const PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const MAX_LENGTH = 256;
const FORBIDDEN_VERSION = 'ff';
const CURRENT_VERSION = '00';

export function parseTraceparent(value: unknown): TraceContext | undefined {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return undefined;

  const match = PATTERN.exec(value);
  if (!match) return undefined;
  const [, version, traceId = '', spanId = '', flags = '', rest] = match;

  if (version === FORBIDDEN_VERSION) return undefined;
  if (version === CURRENT_VERSION && rest !== undefined) return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;

  return { traceId, spanId, flags };
}

export function formatTraceparent({ traceId, spanId, flags }: TraceContext): string {
  return `${CURRENT_VERSION}-${traceId}-${spanId}-${flags}`;
}
