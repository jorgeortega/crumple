import { formatTrace, memoryAuditSink, memorySink, type AuditEvent, type MemoryAuditSink, type MemorySink } from '../src/mcp-surface/index.js';
import { MALICIOUS_TEXT } from '../src/fault-api/index.js';
import { CHARGE_KEY, createDemoSurface, READ_KEY, type DemoSurface, type SurfaceSetup } from './surface.js';

// The buttons. Each one breaks something on purpose, in a fresh Crumple with its own fault-api, and
// reports what was counted. No input, so nothing a visitor sends can change what runs, and no model.
// Every sentence that says something held is decided by the numbers from this run: if a charge were
// applied twice, the page would say so.

const PROTOCOL = '2026-07-28';
export const HANG_DEADLINE_MS = 1_500;
// The hang has no reply to wait for, and a slower runtime shouldn't count as a missed deadline.
const DEADLINE_SLACK_MS = 1_000;
const PAYMENT = { body: { customerId: 'cus_1', amountCents: 5000 } };

export const SCENARIOS = ['lose-the-response', 'hang-the-api', 'no-permission', 'plant-an-instruction'] as const;
export type ScenarioId = (typeof SCENARIOS)[number];

export const isScenario = (value: string): value is ScenarioId => (SCENARIOS as readonly string[]).includes(value);

export interface TryReport {
  id: ScenarioId;
  held: boolean;
  headline: string;
  facts: readonly { label: string; value: string }[];
  /** What fault-api received, from its own log. */
  api: readonly { method: string; path: string; outcome: string }[];
  /** Crumple's own trace of this run. */
  trace: string;
  ms: number;
}

type Told =
  | { kind: 'result'; text: string; isError: boolean }
  | { kind: 'refused'; message: string }
  | { kind: 'broken'; status: number };

async function callTool(demo: DemoSurface, key: string, name: string, args: Record<string, unknown>): Promise<Told> {
  const response = await demo.surface.fetch(new Request('https://crumple.invalid/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${key}`,
      'mcp-protocol-version': PROTOCOL,
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'crumple-demo-button', version: '1' },
        },
      },
    }),
  }));
  const text = await response.text();
  try {
    const { result, error } = JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? text) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
      error?: { message?: string };
    };
    if (error) return { kind: 'refused', message: error.message ?? '' };
    return { kind: 'result', text: result?.content?.map((part) => part.text ?? '').join('\n') ?? '', isError: result?.isError === true };
  } catch {
    return { kind: 'broken', status: response.status };
  }
}

const denials = (audited: MemoryAuditSink): AuditEvent[] => audited.events().filter((event) => event.decision === 'deny');
const count = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;
const toldAs = (told: Told): string => {
  if (told.kind === 'refused') return `Refused: ${told.message}`;
  if (told.kind === 'broken') return `Something unexpected, HTTP ${String(told.status)}`;
  return told.isError ? told.text : 'It worked';
};

type Finding = Pick<TryReport, 'held' | 'headline' | 'facts'>;

interface Scenario {
  setup: SurfaceSetup;
  run: (demo: DemoSurface, audited: MemoryAuditSink, started: number, now: () => number) => Promise<Finding>;
}

const RUNS: Record<ScenarioId, Scenario> = {
  'lose-the-response': {
    setup: { fault: 'drop;times=1', retry: { attempts: 3, baseMs: 10, capMs: 20 } },
    async run(demo) {
      const told = await callTool(demo, CHARGE_KEY, 'createPayment', PAYMENT);
      const charges = demo.api.effects().length;
      const requests = demo.api.requests();
      const keys = new Set(requests.map((request) => request.headers['idempotency-key']));
      const worked = told.kind === 'result' && !told.isError;
      return {
        held: charges === 1 && worked && requests.length > 1,
        headline: charges === 1
          ? 'One charge. The API applied the payment and its response was lost, so Crumple sent it again with the same idempotency key, and the API recognised it.'
          : `This should be one charge, and the API applied ${String(charges)}.`,
        facts: [
          { label: 'Charges', value: String(charges) },
          { label: 'Requests the API received', value: String(requests.length) },
          { label: 'Idempotency keys among them', value: String(keys.size) },
          { label: 'The agent was told', value: toldAs(told) },
        ],
      };
    },
  },
  'hang-the-api': {
    setup: { fault: 'hang', deadlineMs: HANG_DEADLINE_MS },
    async run(demo, _audited, started, now) {
      const told = await callTool(demo, READ_KEY, 'getCustomer', { id: 'cus_1' });
      const waited = now() - started;
      const errored = told.kind === 'result' && told.isError;
      const inTime = waited < HANG_DEADLINE_MS + DEADLINE_SLACK_MS;
      return {
        held: errored && inTime,
        headline: errored && inTime
          ? `The API never answered, and the agent got a clear error at the deadline instead of waiting forever.`
          : `This should be an error at the ${String(HANG_DEADLINE_MS)} ms deadline, and it wasn't.`,
        facts: [
          { label: 'The deadline', value: `${String(HANG_DEADLINE_MS)} ms` },
          { label: 'The agent waited', value: `${String(waited)} ms` },
          { label: 'The agent was told', value: toldAs(told) },
        ],
      };
    },
  },
  'no-permission': {
    setup: {},
    async run(demo, audited) {
      const told = await callTool(demo, READ_KEY, 'deleteCustomer', { id: 'cus_1' });
      const reached = demo.api.requests().length;
      const refused = told.kind === 'refused';
      const logged = denials(audited).length;
      return {
        held: refused && reached === 0 && logged === 1,
        headline: refused && reached === 0
          ? 'Refused. A read-only key tried to delete a customer, and the request never reached the API.'
          : `This should be refused before the API, and the API received ${count(reached, 'request')}.`,
        facts: [
          { label: 'Requests the API received', value: String(reached) },
          { label: 'Refusals in the audit log', value: String(logged) },
          { label: 'The agent was told', value: toldAs(told) },
        ],
      };
    },
  },
  'plant-an-instruction': {
    setup: { fault: 'inject' },
    async run(demo, audited) {
      // A scripted agent, not a model: it does exactly what the record says, which is the worst case.
      const record = await callTool(demo, READ_KEY, 'getCustomer', { id: 'cus_1' });
      const sawIt = record.kind === 'result' && record.text.includes(MALICIOUS_TEXT);
      const told = await callTool(demo, READ_KEY, 'deleteCustomer', { id: 'cus_1' });
      const deleted = demo.api.effects().length;
      const refused = told.kind === 'refused';
      return {
        held: sawIt && refused && deleted === 0,
        headline: sawIt && refused && deleted === 0
          ? 'Refused. The record told the agent to delete the customer, the agent tried, and its key doesn\'t allow it.'
          : 'This should show a planted instruction being refused, and this run didn\'t.',
        facts: [
          { label: 'The record said', value: sawIt ? MALICIOUS_TEXT : 'Not what it should have' },
          { label: 'Customers deleted', value: String(deleted) },
          { label: 'Refusals in the audit log', value: String(denials(audited).length) },
          { label: 'The agent was told', value: toldAs(told) },
        ],
      };
    },
  },
};

export interface RunOptions {
  create?: (setup: SurfaceSetup) => Promise<DemoSurface>;
  now?: () => number;
}

export async function runScenario(id: ScenarioId, options: RunOptions = {}): Promise<TryReport> {
  const { create = createDemoSurface, now = () => Date.now() } = options;
  const { setup, run } = RUNS[id];
  const spans: MemorySink = memorySink();
  const audited: MemoryAuditSink = memoryAuditSink();

  const started = now();
  const demo = await create({ ...setup, observe: { spans, audited } });
  const finding = await run(demo, audited, started, now);
  return {
    id,
    ...finding,
    api: demo.api.requests().map(({ method, path, outcome }) => ({ method, path, outcome })),
    trace: formatTrace(spans.spans()),
    ms: now() - started,
  };
}
