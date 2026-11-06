import { createFaultApi, DEFAULT_CREDENTIAL, OPENAPI, type FaultApi } from '../src/fault-api/index.js';
import { convertOpenApi, createAudit, createMcpSurface, createTelemetry, hashKey, memoryKeyStore, plainCredential, type Grant, type MemoryAuditSink, type MemorySink, type McpSurface } from '../src/mcp-surface/index.js';

// The real Crumple, with fault-api in the same process. The upstream is a function call, so nothing
// here can reach the network, and there's no user-supplied address or document to point it elsewhere.

/** Printed on the page, on purpose. They reach fake data, and nothing can delete with either. */
export const READ_KEY = 'crumple_public-demo-read-key-fake-data-nothing-else';
export const CHARGE_KEY = 'crumple_public-demo-charge-key-fake-payments-only-1';

const DEMO_KEYS: readonly { id: string; label: string; key: string; grants: readonly Grant[] }[] = [
  { id: 'key_demo_read', label: 'public read key', key: READ_KEY, grants: [{ tool: '*' }] },
  { id: 'key_demo_charge', label: 'public charge key', key: CHARGE_KEY, grants: [{ tool: '*' }, { tool: 'createPayment', writes: true }] },
];

// Never reaches the network, because the fetch below is fault-api's own.
const UPSTREAM = 'https://fault-api.invalid';

export interface SurfaceSetup {
  /** What fault-api should do, for one button's run. Never set for /mcp. */
  fault?: string;
  deadlineMs?: number;
  retry?: { attempts?: number; baseMs?: number; capMs?: number };
  /** Only for a button's run, whose trace goes back to whoever pressed it. /mcp keeps nothing. */
  observe?: { spans: MemorySink; audited: MemoryAuditSink };
}

export interface DemoSurface {
  surface: Pick<McpSurface, 'fetch'>;
  api: Pick<FaultApi, 'requests' | 'effects'>;
}

/** A fresh one holds its own fake data, with nothing shared with any other. */
export async function createDemoSurface(setup: SurfaceSetup = {}): Promise<DemoSurface> {
  const api = createFaultApi();
  const telemetry = createTelemetry({ sinks: setup.observe ? [setup.observe.spans] : [] });

  const keys = memoryKeyStore();
  await Promise.all(DEMO_KEYS.map(async ({ id, label, key, grants }) => {
    await keys.add({ id, label, grants, hash: await hashKey(key), shown: key.slice(0, 12), createdAt: 0 });
  }));

  const surface = createMcpSurface({
    name: 'crumple-demo',
    tools: convertOpenApi(OPENAPI).tools,
    upstream: {
      baseUrl: UPSTREAM,
      fetch: (request) => api.fetch(request),
      getCredential: plainCredential('header', 'authorization', `Bearer ${DEFAULT_CREDENTIAL}`),
      ...(setup.fault === undefined ? {} : { headers: { 'x-fault': setup.fault } }),
      ...(setup.deadlineMs === undefined ? {} : { deadlineMs: setup.deadlineMs }),
      ...(setup.retry === undefined ? {} : { retry: setup.retry }),
    },
    access: { keys },
    telemetry,
    audit: createAudit(telemetry, setup.observe ? [setup.observe.audited] : []),
  });
  return { surface, api };
}
