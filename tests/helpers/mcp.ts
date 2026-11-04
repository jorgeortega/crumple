// Plain JSON-RPC against a fetch handler, so a test sees exactly what crosses the wire. Written by
// hand on purpose: the official clients hide the details these tests are checking.

export const MODERN = '2026-07-28';
export const LEGACY = '2025-11-25';
export const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

export type Fetcher = (request: Request) => Promise<Response>;

export interface RpcResult {
  status: number;
  body: {
    result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string; inputSchema: unknown; annotations?: unknown }[]; cacheScope?: string; ttlMs?: number };
    error?: { code: number; message: string };
  };
}

let nextId = 1;

async function parse(response: Response): Promise<RpcResult> {
  const text = await response.text();
  // A legacy answer can arrive as one server-sent event.
  const data = /^data: (.*)$/m.exec(text)?.[1] ?? text;
  return { status: response.status, body: data ? (JSON.parse(data) as RpcResult['body']) : {} };
}

export interface RpcOptions {
  token?: string | undefined;
  url?: string;
  traceparent?: string;
  headers?: Record<string, string>;
}

/** A request on MCP 2026-07-28, with its per-request envelope and routing headers. */
export async function rpc(fetcher: Fetcher, method: string, params: Record<string, unknown> = {}, options: RpcOptions = {}): Promise<RpcResult> {
  const { token, url = 'http://crumple.test/mcp', traceparent, headers = {} } = options;
  const name = typeof params.name === 'string' ? params.name : undefined;
  const meta = {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
    ...(traceparent ? { traceparent } : {}),
  };
  const id = nextId;
  nextId += 1;
  const response = await fetcher(new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...(name ? { 'mcp-name': name } : {}),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }),
  }));
  return parse(response);
}

/** A request on the 2025 protocol, with no envelope and none of the routing headers. */
export async function legacyRpc(fetcher: Fetcher, method: string, params: Record<string, unknown>, token: string, url = 'http://crumple.test/mcp'): Promise<RpcResult> {
  const id = nextId;
  nextId += 1;
  const response = await fetcher(new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(method === 'initialize' ? {} : { 'mcp-protocol-version': LEGACY }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }));
  return parse(response);
}

export const callTool = (fetcher: Fetcher, name: string, args: Record<string, unknown>, options: RpcOptions = {}): Promise<RpcResult> =>
  rpc(fetcher, 'tools/call', { name, arguments: args }, options);

export const textOf = (result: RpcResult): string => result.body.result?.content?.[0]?.text ?? '';
