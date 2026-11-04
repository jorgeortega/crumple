import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFaultApi, DEFAULT_CREDENTIAL, OPENAPI } from '../../src/fault-api/index.js';
import { convertOpenApi, createAudit, createKey, createMcpSurface, createTelemetry, memoryAuditSink, memoryKeyStore, plainCredential } from '../../src/mcp-surface/index.js';
import { serveOnNode, type NodeServer } from '../../src/node.js';

// C14. Named .run.ts so `npm test` leaves it alone, because it needs uv and a download. It fails
// rather than skips when uv is missing, so a green result always means it really ran.

const PYTHON_MCP = '2.3.0';
const CLIENT = fileURLToPath(new URL('./client.py', import.meta.url));

interface Seen {
  protocol: string;
  tools: string[];
  schema_required: string[];
  good: { is_error: boolean; text: string };
  bad_argument: { is_error: boolean; text: string };
  payment: { is_error: boolean; text: string };
  refused: { raised: boolean; type?: string; code?: number; message?: string };
}

function runPython(url: string, key: string): Promise<Seen> {
  return new Promise((resolve, reject) => {
    // Asynchronous, because the server this talks to runs in this same process.
    const child = spawn('uv', ['run', '--no-project', '--python', '3.11', '--with', `mcp==${PYTHON_MCP}`, 'python', CLIENT, url, key]);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('error', (error) => { reject(new Error(`Couldn't run uv, which this test needs: ${error.message}`)); });
    child.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(out) as Seen);
      else reject(new Error(`The Python client exited with ${String(code)}:\n${err}`));
    });
  });
}

describe('the official Python SDK', () => {
  const api = createFaultApi();
  const records = memoryAuditSink();
  const servers: NodeServer[] = [];
  let seen: Seen;

  beforeAll(async () => {
    const upstream = await serveOnNode((request) => api.fetch(request));
    servers.push(upstream);
    const telemetry = createTelemetry();
    const keys = memoryKeyStore();
    const { key } = await createKey(keys, { label: 'python', grants: [{ tool: '*' }, { tool: 'createPayment', writes: true }] });
    const surface = createMcpSurface({
      tools: convertOpenApi(OPENAPI).tools,
      upstream: { baseUrl: upstream.url, getCredential: plainCredential('header', 'authorization', `Bearer ${DEFAULT_CREDENTIAL}`) },
      access: { keys },
      telemetry,
      audit: createAudit(telemetry, [records]),
    });
    const server = await serveOnNode((request) => surface.fetch(request));
    servers.push(server);
    seen = await runPython(new URL('/mcp', server.url).href, key);
  }, 180_000);

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  // Checked, because the spike's first run passed while silently on the older protocol.
  it('negotiates 2026-07-28', () => {
    expect(seen.protocol).toBe('2026-07-28');
  });

  it('lists only what this caller may use, with the schema intact', () => {
    expect(seen.tools).toEqual(['createPayment', 'getCustomer', 'getPayment', 'listCustomers']);
    expect(seen.schema_required).toEqual(['id']);
  });

  it('calls a tool', () => {
    expect(seen.good.is_error).toBe(false);
    expect(JSON.parse(seen.good.text)).toMatchObject({ id: 'cus_1' });
  });

  it('gets a bad argument back as a result the model can read', () => {
    expect(seen.bad_argument.is_error).toBe(true);
    expect(JSON.parse(seen.bad_argument.text)).toMatchObject({ code: 'invalid_arguments', retry: 'no' });
  });

  it('makes a write it\'s allowed, exactly once', () => {
    expect(seen.payment.is_error).toBe(false);
    expect(api.effects()).toHaveLength(1);
  });

  it('is refused the delete, as an error, with nothing sent', () => {
    expect(seen.refused).toMatchObject({ raised: true });
    expect(seen.refused.message).toContain('may not be allowed');
    expect(api.requests().filter((request) => request.method === 'DELETE')).toEqual([]);
    expect(records.events().at(-1)).toMatchObject({ tool: 'deleteCustomer', decision: 'deny', reason: 'writes_not_allowed' });
  });

  it('sends the agent\'s key nowhere upstream', () => {
    for (const request of api.requests()) expect(request.headers.authorization).toBe(`Bearer ${DEFAULT_CREDENTIAL}`);
  });
});
