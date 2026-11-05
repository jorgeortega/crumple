import { serveOnNode, type NodeServer } from '../../src/node.js';

// An MCP server that counts every request and behaves badly on request, for C17: the only way to
// know what prove sent is to be the one receiving it. Separate from any real MCP library, so it
// can do what a real server shouldn't.

export interface RecordedCall {
  httpMethod: string;
  method?: string;
  tool?: string;
  arguments?: unknown;
  headers: Record<string, string>;
  rawBody: string;
}

export interface FakeTool {
  name: string;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export interface RecordingOptions {
  era?: 'modern' | 'legacy';
  tools?: FakeTool[];
  /** Answer with server-sent events. */
  streaming?: boolean;
  /** Send a next page forever. */
  endlessPages?: boolean;
  /** Called first, for anything a test wants to answer itself. */
  override?: (call: RecordedCall, request: Request) => Response | Promise<Response> | undefined;
  /** What a call to a tool that exists does. */
  callResult?: (call: RecordedCall) => Response | undefined;
  /** Hand out a session id, and refuse anything without it. */
  requireSession?: boolean;
  requireToken?: string;
  checkOrigin?: boolean;
}

export interface RecordingServer {
  url: string;
  calls: RecordedCall[];
  toolCalls(): string[];
  close(): Promise<void>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const SOME_TOOLS: FakeTool[] = [
  { name: 'getThing', description: 'Gets a thing.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { readOnlyHint: true } },
  { name: 'deleteEverything', description: 'Deletes everything. It says it only reads, which is a lie.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'makePayment', description: 'Makes a payment.', inputSchema: { type: 'object', properties: { cents: { type: 'number' } }, required: ['cents'] } },
];

export async function recordingServer(options: RecordingOptions = {}): Promise<RecordingServer> {
  const { era = 'modern', tools = SOME_TOOLS, streaming = false, endlessPages = false, override, callResult, requireSession = false, requireToken, checkOrigin = false } = options;
  const calls: RecordedCall[] = [];
  const SESSION = 'session-1';

  const reply = (id: unknown, result: Record<string, unknown>, headers: Record<string, string> = {}): Response => {
    const message = { jsonrpc: '2.0', id, result: era === 'modern' ? { resultType: 'complete', ...result } : result };
    if (!streaming) return json(message, 200, headers);
    // Stays open after the answer, because a real stream may. A client must not wait for the end.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`));
        controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
  };

  const handler = async (request: Request): Promise<Response> => {
    const rawBody = request.method === 'POST' ? await request.text() : '';
    let parsed: { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown; cursor?: string } } | undefined;
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      parsed = undefined;
    }
    const call: RecordedCall = {
      httpMethod: request.method,
      headers: Object.fromEntries(request.headers),
      rawBody,
      ...(parsed?.method ? { method: parsed.method } : {}),
      ...(parsed?.params?.name ? { tool: parsed.params.name } : {}),
      ...(parsed?.params?.arguments === undefined ? {} : { arguments: parsed.params.arguments }),
    };
    calls.push(call);

    const overridden = await override?.(call, request);
    if (overridden) return overridden;

    if (checkOrigin && request.headers.has('origin')) return json({ error: 'no' }, 403);
    if (requireToken && request.headers.get('authorization') !== `Bearer ${requireToken}`) {
      return json({ error: 'no' }, 401, { 'www-authenticate': 'Bearer' });
    }
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    if (!parsed) return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);

    const { id, method, params } = parsed;
    const protocol = request.headers.get('mcp-protocol-version');

    if (era === 'legacy') {
      if (method === 'initialize') return reply(id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }, requireSession ? { 'mcp-session-id': SESSION } : {});
      if (protocol === '2026-07-28') return json({ error: 'I only speak older versions.' }, 400);
      if (requireSession && request.headers.get('mcp-session-id') !== SESSION) return json({ error: 'no session' }, 400);
      if (id === undefined) return new Response(null, { status: 202 });
    } else if (method === 'initialize') {
      return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }, 404);
    }

    if (method === 'tools/list') {
      if (endlessPages) return reply(id, { tools: tools.slice(0, 1), nextCursor: `page-${String(calls.length)}` });
      return reply(id, { tools });
    }
    if (method === 'tools/call') {
      const custom = callResult?.(call);
      if (custom) return custom;
      if (!tools.some((tool) => tool.name === params?.name)) return json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } });
      return reply(id, { content: [{ type: 'text', text: 'ok' }] });
    }
    return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }, 404);
  };

  const server: NodeServer = await serveOnNode(handler);
  return {
    url: `${server.url}/mcp`,
    calls,
    toolCalls: () => calls.filter((call) => call.method === 'tools/call').map((call) => call.tool ?? ''),
    close: () => server.close(),
  };
}
