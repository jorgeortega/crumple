import { createFaultApi, DEFAULT_CREDENTIAL } from '../fault-api/index.js';
import { serveOnNode } from '../node.js';
import type { StartTarget, Target, TargetSetup } from '../prove/index.js';

// An MCP server that does everything wrong, on purpose, in front of the real fault-api. A check that
// can't fail proves nothing, so every check in prove has to fail against this.
//
// It ships in the package for one reason: demo shows its double charge next to Crumple, measured on
// each run. It's only ever started on 127.0.0.1, in front of fault-api, and isn't exported.
//
// It's written by us to be bad, and it isn't a stand-in for any real project. Each habit below is a
// mistake a first version could easily make:
//
//   - It checks no key, so anyone can do anything.
//   - It passes the caller's key along to the API.
//   - It logs and returns whatever the API sends, secrets included.
//   - It retries every failure, writes too, with no idempotency key.
//   - It has no deadline, no circuit breaker and no limits.
//   - Its errors are plain text, so an agent can't tell what to do next.

const ATTEMPTS = 3;

interface Tool { method: string; path: (args: Record<string, unknown>) => string; writes: boolean }

const TOOLS: Record<string, Tool> = {
  listCustomers: { method: 'GET', path: () => '/customers', writes: false },
  getCustomer: { method: 'GET', path: (args) => `/customers/${String(args.id)}`, writes: false },
  deleteCustomer: { method: 'DELETE', path: (args) => `/customers/${String(args.id)}`, writes: true },
  createPayment: { method: 'POST', path: () => '/payments', writes: true },
};

export const wrongServer: StartTarget = async (setup: TargetSetup): Promise<Target> => {
  const api = createFaultApi();
  const upstream = await serveOnNode((request) => api.fetch(request));
  const log: string[] = [];

  const callApi = async (tool: Tool, args: Record<string, unknown>, callerKey: string): Promise<string> => {
    let lastError = 'Error: the API failed.';
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(`${upstream.url}${tool.path(args)}`, {
          method: tool.method,
          headers: {
            authorization: `Bearer ${DEFAULT_CREDENTIAL}`,
            'content-type': 'application/json',
            'x-forwarded-authorization': callerKey,
            ...(setup.fault ? { 'x-fault': setup.fault } : {}),
          },
          ...(tool.method === 'POST' ? { body: JSON.stringify(args.body) } : {}),
        });
        const text = await response.text();
        log.push(text);
        if (response.ok) return text;
        lastError = 'Error: the API failed.';
      } catch {
        lastError = 'Error: the API failed.';
      }
    }
    throw new Error(lastError);
  };

  const mcp = await serveOnNode(async (request) => {
    const body = (await request.json()) as { id: unknown; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const reply = (result: Record<string, unknown>): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', ...result } }), { headers: { 'content-type': 'application/json' } });

    if (body.method === 'tools/list') {
      return reply({ tools: Object.keys(TOOLS).map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) });
    }

    const tool = TOOLS[body.params?.name ?? ''];
    if (!tool) return reply({ content: [{ type: 'text', text: 'Error: no such tool' }], isError: true });
    try {
      const text = await callApi(tool, body.params?.arguments ?? {}, request.headers.get('authorization') ?? '');
      return reply({ content: [{ type: 'text', text }] });
    } catch (error) {
      return reply({ content: [{ type: 'text', text: (error as Error).message }], isError: true });
    }
  });

  return {
    url: `${mcp.url}/mcp`,
    keys: { read: 'wrong-read-key', write: 'wrong-write-key', other: 'wrong-other-key', all: 'wrong-all-key' },
    credential: DEFAULT_CREDENTIAL,
    upstream: {
      url: upstream.url,
      requests: () => api.requests(),
      effects: () => api.effects(),
    },
    observed: () => log.join('\n'),
    denied: () => [],
    async stop() {
      await mcp.close();
      await upstream.close();
    },
  };
};
