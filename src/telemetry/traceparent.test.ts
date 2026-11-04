import { describe, expect, it } from 'vitest';
import { formatTraceparent, parseTraceparent } from './traceparent.js';

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';

describe('parseTraceparent', () => {
  it('reads a valid value', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({ traceId: TRACE, spanId: SPAN, flags: '01' });
  });

  it('keeps flags other than sampled', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)?.flags).toBe('00');
  });

  // W3C says to accept higher versions, reading the fields it knows, so old parsers
  // don't break tracing when the format grows.
  it('reads a future version, ignoring what follows', () => {
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01-extra`)?.traceId).toBe(TRACE);
  });

  // It comes from the caller, so anything off means no parent, never an error: a bad
  // trace id must not stop a tool call.
  it.each([
    ['nothing', undefined],
    ['a number', 42],
    ['an object', { traceparent: 'x' }],
    ['an empty string', ''],
    ['too few parts', `00-${TRACE}-${SPAN}`],
    ['extra parts on version 00', `00-${TRACE}-${SPAN}-01-extra`],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-${SPAN}-01`],
    ['an all-zero span id', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['the forbidden version ff', `ff-${TRACE}-${SPAN}-01`],
    ['uppercase hex', `00-${TRACE.toUpperCase()}-${SPAN}-01`],
    ['a short trace id', `00-${TRACE.slice(1)}-${SPAN}-01`],
    ['non-hex characters', `00-${'z'.repeat(32)}-${SPAN}-01`],
    ['a very long value', `01-${TRACE}-${SPAN}-01-${'x'.repeat(1000)}`],
  ])('ignores %s', (_name, value) => {
    expect(parseTraceparent(value)).toBeUndefined();
  });
});

describe('formatTraceparent', () => {
  it('writes the W3C format, which reads back the same', () => {
    const context = { traceId: TRACE, spanId: SPAN, flags: '01' };
    expect(formatTraceparent(context)).toBe(`00-${TRACE}-${SPAN}-01`);
    expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
  });
});
