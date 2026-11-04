import { describe, expect, it } from 'vitest';
import { createAudit, createTelemetry, memoryAuditSink, type AuditEvent, type AuditSink } from './index.js';

function setup(secrets: string[] = []) {
  const memory = memoryAuditSink();
  const telemetry = createTelemetry({ now: () => 5_000, secrets });
  return { audit: createAudit(telemetry, [memory]), memory };
}

describe('audit events', () => {
  it('records who did what, what was decided and which trace it belongs to', () => {
    const { audit, memory } = setup();
    audit.record({ caller: 'key_1', tool: 'delete_customer', decision: 'deny', reason: 'writes_not_allowed', traceId: 'abc' });
    expect(memory.events()).toEqual([{
      at: 5_000,
      caller: 'key_1',
      tool: 'delete_customer',
      decision: 'deny',
      reason: 'writes_not_allowed',
      traceId: 'abc',
    }]);
  });

  it('leaves out what wasn\'t given', () => {
    const { audit, memory } = setup();
    audit.record({ caller: 'key_1', tool: 'get_customer', decision: 'allow' });
    expect(memory.events()[0]).toEqual({ at: 5_000, caller: 'key_1', tool: 'get_customer', decision: 'allow' });
  });

  it('keeps only the known fields, so arguments can\'t be slipped in', () => {
    const { audit, memory } = setup();
    const event = { caller: 'key_1', tool: 'x', decision: 'allow', arguments: { card: '4242' } } as unknown as Omit<AuditEvent, 'at'>;
    audit.record(event);
    expect(JSON.stringify(memory.events())).not.toContain('4242');
  });

  it('replaces a registered secret in every text field', () => {
    const SECRET = 'fake-upstream-credential-value';
    const { audit, memory } = setup([SECRET]);
    audit.record({ caller: SECRET, tool: SECRET, decision: 'deny', reason: SECRET, traceId: SECRET });
    expect(JSON.stringify(memory.events())).not.toContain(SECRET);
  });

  it('survives a broken sink, and counts the failure', () => {
    const broken: AuditSink = {
      write: () => {
        throw new Error('disk full');
      },
    };
    const working = memoryAuditSink();
    const audit = createAudit(createTelemetry(), [broken, working]);
    expect(() => {
      audit.record({ caller: 'a', tool: 'b', decision: 'allow' });
    }).not.toThrow();
    expect(audit.failures()).toBe(1);
    expect(working.events()).toHaveLength(1);
  });

  it('holds a bounded number in memory, dropping the oldest and counting them', () => {
    const sink = memoryAuditSink({ capacity: 2 });
    const audit = createAudit(createTelemetry(), [sink]);
    for (const tool of ['a', 'b', 'c']) audit.record({ caller: 'x', tool, decision: 'allow' });
    expect(sink.events().map((event) => event.tool)).toEqual(['b', 'c']);
    expect(sink.dropped()).toBe(1);
  });
});
