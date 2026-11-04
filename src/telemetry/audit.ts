import type { Telemetry } from './span.js';

// "Who did what", kept apart from traces: a span ring is allowed to forget, and an audit
// record shouldn't be. No arguments, for the same reason traces have none. In memory these
// last only as long as the process, so the CLI saves them through the storage interface.

export interface AuditEvent {
  at: number;
  caller: string;
  tool: string;
  decision: 'allow' | 'deny';
  reason?: string;
  traceId?: string;
}

export interface AuditSink {
  write(event: AuditEvent): void;
}

export interface Audit {
  record(event: Omit<AuditEvent, 'at'>): void;
  failures(): number;
}

export function createAudit(telemetry: Telemetry, sinks: AuditSink[]): Audit {
  let failures = 0;

  return {
    record({ caller, tool, decision, reason, traceId }) {
      // Built field by field, so nothing else on the object can come along for the ride.
      const event: AuditEvent = {
        at: telemetry.now(),
        caller: telemetry.clean(caller),
        tool: telemetry.clean(tool),
        decision,
        ...(reason === undefined ? {} : { reason: telemetry.clean(reason) }),
        ...(traceId === undefined ? {} : { traceId: telemetry.clean(traceId) }),
      };
      for (const sink of sinks) {
        try {
          sink.write(event);
        } catch {
          failures += 1;
        }
      }
    },
    failures: () => failures,
  };
}

export interface MemoryAuditSink extends AuditSink {
  events(): AuditEvent[];
  dropped(): number;
}

export function memoryAuditSink(options: { capacity?: number } = {}): MemoryAuditSink {
  const { capacity = 10_000 } = options;
  const events: AuditEvent[] = [];
  let dropped = 0;

  return {
    write(event) {
      events.push(event);
      if (events.length > capacity) {
        events.shift();
        dropped += 1;
      }
    },
    events: () => [...events],
    dropped: () => dropped,
  };
}
