import type { ReadableStreamDefaultReader } from 'node:stream/web';

// A small MCP client, written by hand on purpose, shared by prove and agent-runner. The official one
// hides what prove is checking, such as a 401 or a 403, and has no way to send something deliberately
// wrong. It would also be a third runtime dependency.
//
// Whatever is on the other end isn't trusted: it can hang, send forever or redirect to take the
// token elsewhere. So every read is capped and timed, and a redirect is reported, never followed.

export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSION = '2025-11-25';
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const USER_AGENT = 'crumple-mcp-prove';

export interface JsonRpcReply {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown };
}

export type WireReply =
  | { kind: 'answered'; status: number; headers: Headers; message?: JsonRpcReply; ms: number }
  | { kind: 'redirected'; status: number; ms: number }
  | { kind: 'timeout' | 'unreachable' | 'too_large' | 'broken'; ms: number }
  | { kind: 'budget'; ms: 0 };

/** Every request counts, and when it runs out nothing else is sent. */
export interface Budget {
  readonly max: number;
  used(): number;
  take(): boolean;
}

export function createBudget(max: number = Number.POSITIVE_INFINITY): Budget {
  let used = 0;
  return {
    max,
    used: () => used,
    take() {
      if (used >= max) return false;
      used += 1;
      return true;
    },
  };
}

export interface SendOptions {
  protocol?: string;
  sessionId?: string;
  /** Leave out for the session's token, or null to send none, or a string to send that instead. */
  token?: string | null;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** How messages get there. HTTP here, and stdio beside it. */
export interface Transport {
  readonly kind: 'http' | 'stdio';
  send(message: Record<string, unknown>, options?: SendOptions): Promise<WireReply>;
  /** For a message with no answer to wait for. */
  notify(message: Record<string, unknown>, options?: SendOptions): Promise<void>;
  close(options?: SendOptions): Promise<void>;
}

export interface HttpTransport extends Transport {
  readonly kind: 'http';
  /** Sends these exact bytes, for a check on what happens with a body that isn't JSON. */
  sendRaw(body: string, options?: SendOptions): Promise<WireReply>;
}

export interface HttpTransportOptions {
  url: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs: number;
  budget: Budget;
  /** Says who's calling, so a server's logs can tell prove from the agent. */
  userAgent?: string;
}

const encodeName = (name: string): string =>
  // A name isn't always safe to put in a header, and MCP says how to carry one that isn't.
  /^[\x21-\x7e]+$/.test(name) && !(name.startsWith('=?base64?') && name.endsWith('?='))
    ? name
    : `=?base64?${Buffer.from(name).toString('base64')}?=`;

const isReply = (value: unknown): value is JsonRpcReply => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJson(text: string): JsonRpcReply | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isReply(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The answer to this request, from however much of a stream has arrived. */
function findInEvents(text: string, id: unknown): JsonRpcReply | undefined {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data) continue;
    const message = parseJson(data);
    if (message && message.id === id && ('result' in message || 'error' in message)) return message;
  }
  return undefined;
}

export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const { url, token, timeoutMs, budget, userAgent = USER_AGENT, fetch: doFetch = (input, init) => fetch(input, init) } = options;

  async function post(body: string, id: unknown, method: string | undefined, name: string | undefined, sendOptions: SendOptions, httpMethod = 'POST'): Promise<WireReply> {
    if (!budget.take()) return { kind: 'budget', ms: 0 };

    const { protocol, sessionId, headers = {}, timeoutMs: thisTimeout = timeoutMs } = sendOptions;
    const bearer = sendOptions.token === undefined ? token : sendOptions.token;
    const started = performance.now();
    const elapsed = (): number => performance.now() - started;

    const abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); }, thisTimeout);

    try {
      const response = await doFetch(url, {
        method: httpMethod,
        // Following one would carry the token to wherever the server chose.
        redirect: 'manual',
        signal: abort.signal,
        headers: {
          'user-agent': userAgent,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(protocol ? { 'mcp-protocol-version': protocol } : {}),
          ...(protocol === MODERN_VERSION && method ? { 'mcp-method': method } : {}),
          ...(protocol === MODERN_VERSION && name ? { 'mcp-name': encodeName(name) } : {}),
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...headers,
        },
        ...(httpMethod === 'POST' ? { body } : {}),
      });

      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        return { kind: 'redirected', status: response.status, ms: elapsed() };
      }

      const streaming = response.headers.get('content-type')?.includes('text/event-stream') ?? false;
      const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
      const decoder = new TextDecoder();
      let text = '';
      let bytes = 0;

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => undefined);
          return { kind: 'too_large', ms: elapsed() };
        }
        text += decoder.decode(value, { stream: true });
        // A stream may stay open after its answer, and waiting for the end would look like a hang.
        const found = streaming ? findInEvents(text, id) : undefined;
        if (found) {
          void reader.cancel().catch(() => undefined);
          return { kind: 'answered', status: response.status, headers: response.headers, message: found, ms: elapsed() };
        }
      }

      if (streaming) return response.ok ? { kind: 'broken', ms: elapsed() } : { kind: 'answered', status: response.status, headers: response.headers, ms: elapsed() };
      if (text === '') return { kind: 'answered', status: response.status, headers: response.headers, ms: elapsed() };
      const message = parseJson(text);
      // A proxy's HTML error page is still an answer with a status. A 200 that isn't JSON is broken.
      if (!message && response.ok) return { kind: 'broken', ms: elapsed() };
      return { kind: 'answered', status: response.status, headers: response.headers, ...(message ? { message } : {}), ms: elapsed() };
    } catch {
      return abort.signal.aborted ? { kind: 'timeout', ms: elapsed() } : { kind: 'unreachable', ms: elapsed() };
    } finally {
      clearTimeout(timer);
    }
  }

  const nameOf = (message: Record<string, unknown>): string | undefined => {
    const name = (message.params as { name?: unknown } | undefined)?.name;
    return typeof name === 'string' ? name : undefined;
  };

  return {
    kind: 'http',
    send: (message, sendOptions = {}) => post(JSON.stringify(message), message.id, message.method as string | undefined, nameOf(message), sendOptions),
    sendRaw: (body, sendOptions = {}) => post(body, undefined, undefined, undefined, sendOptions),
    async notify(message, sendOptions = {}) {
      await post(JSON.stringify(message), undefined, undefined, undefined, sendOptions);
    },
    async close(sendOptions = {}) {
      // MCP before 2026-07-28 asks a client to end its session. There's nothing to do otherwise.
      if (sendOptions.sessionId) await post('', undefined, undefined, undefined, sendOptions, 'DELETE');
    },
  };
}

export interface ListedTool {
  name: string;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: unknown };
  [key: string]: unknown;
}

export interface ToolList {
  tools: ListedTool[];
  /** True when pages ran out before the list did: the page limit or the budget. */
  incomplete: boolean;
}

export interface Session {
  readonly protocol: string;
  readonly transport: Transport;
  /** The options that belong on a raw message, such as the session id. */
  readonly sendOptions: SendOptions;
  request(method: string, params?: Record<string, unknown>, options?: SendOptions): Promise<WireReply>;
  listTools(maxPages: number): Promise<ToolList>;
  /** meta goes in the call's _meta, which is how a trace crosses from an agent to a server. */
  callTool(name: string, args: Record<string, unknown>, options?: SendOptions, meta?: Record<string, unknown>): Promise<WireReply>;
  close(): Promise<void>;
}

export type OpenResult =
  | { ok: true; session: Session }
  | { ok: false; reason: 'auth_required'; status: number; challenge: boolean }
  | { ok: false; reason: 'not_mcp' | 'budget' | 'timeout' | 'unreachable' | 'too_large' | 'broken' | 'redirected'; status?: number };

/**
 * Tries 2026-07-28 first, because it needs no handshake, and falls back to initialize the way the
 * spec describes. The fallback is what most servers will need for a while.
 */
export async function openSession(transport: Transport, options: { probeTimeoutMs?: number; clientName?: string } = {}): Promise<OpenResult> {
  const clientInfo = { name: options.clientName ?? USER_AGENT, version: '1' };
  let nextId = 1;
  const takeId = (): number => {
    const id = nextId;
    nextId += 1;
    return id;
  };

  const modernMeta = {
    'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
    'io.modelcontextprotocol/clientInfo': clientInfo,
    'io.modelcontextprotocol/clientCapabilities': {},
  };

  const message = (protocol: string, method: string, params: Record<string, unknown> = {}): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id: takeId(),
    method,
    params: protocol === MODERN_VERSION ? { ...params, _meta: { ...modernMeta, ...(params._meta as Record<string, unknown> | undefined) } } : params,
  });

  function session(protocol: string, sessionId: string | undefined, firstPage: WireReply | undefined): Session {
    const sendOptions: SendOptions = { protocol, ...(sessionId ? { sessionId } : {}) };
    const request = (method: string, params: Record<string, unknown> = {}, options: SendOptions = {}): Promise<WireReply> =>
      transport.send(message(protocol, method, params), { ...sendOptions, ...options });
    let cached = firstPage;

    return {
      protocol,
      transport,
      sendOptions,
      request,
      callTool: (name, args, options = {}, meta) => request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, options),
      close: () => transport.close(sendOptions),
      async listTools(maxPages) {
        const tools: ListedTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < maxPages; page += 1) {
          const reply = page === 0 && cached ? cached : await request('tools/list', cursor === undefined ? {} : { cursor });
          cached = undefined;
          if (reply.kind !== 'answered' || !reply.message?.result) return { tools, incomplete: true };
          const { tools: listed, nextCursor } = reply.message.result as { tools?: unknown; nextCursor?: unknown };
          if (Array.isArray(listed)) {
            tools.push(...listed.filter((tool): tool is ListedTool => isReply(tool) && typeof (tool as { name?: unknown }).name === 'string'));
          }
          if (typeof nextCursor !== 'string' || nextCursor === '') return { tools, incomplete: false };
          cursor = nextCursor;
        }
        return { tools, incomplete: true };
      },
    };
  }

  const refusal = (reply: WireReply): OpenResult | undefined => {
    if (reply.kind === 'answered') {
      if (reply.status === 401 || reply.status === 403) {
        return { ok: false, reason: 'auth_required', status: reply.status, challenge: reply.headers.has('www-authenticate') };
      }
      return undefined;
    }
    return { ok: false, reason: reply.kind, ...(reply.kind === 'redirected' ? { status: reply.status } : {}) };
  };

  const probe = await transport.send(message(MODERN_VERSION, 'tools/list'), { protocol: MODERN_VERSION, ...(options.probeTimeoutMs === undefined ? {} : { timeoutMs: options.probeTimeoutMs }) });
  const stopped = refusal(probe);
  // A server that chokes on the newer form may still manage the older one.
  if (stopped && !stopped.ok && stopped.reason !== 'broken' && stopped.reason !== 'timeout') return stopped;

  // resultType is what proves it spoke 2026-07-28. A lenient older server can answer this too.
  if (probe.kind === 'answered' && probe.status === 200 && probe.message?.result?.resultType !== undefined) {
    return { ok: true, session: session(MODERN_VERSION, undefined, probe) };
  }

  const init = await transport.send(
    message(LEGACY_VERSION, 'initialize', { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo }),
    {},
  );
  const initStopped = refusal(init);
  if (initStopped) return initStopped;
  if (init.kind !== 'answered' || init.status !== 200 || typeof init.message?.result?.protocolVersion !== 'string') {
    return { ok: false, reason: 'not_mcp', ...(init.kind === 'answered' ? { status: init.status } : {}) };
  }

  const protocol = init.message.result.protocolVersion;
  const sessionId = init.headers.get('mcp-session-id') ?? undefined;
  await transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' }, { protocol, ...(sessionId ? { sessionId } : {}) });
  return { ok: true, session: session(protocol, sessionId, undefined) };
}

/** What a tool call came to, in the terms a check cares about. */
export type CallResult =
  | { kind: 'result'; text: string; isError: boolean; ms: number }
  /** message comes from the server, so it can go to a model, and it never goes in a report. */
  | { kind: 'protocol_error'; code: unknown; message: unknown; ms: number }
  | { kind: 'http_error'; status: number; ms: number }
  | { kind: 'no_answer'; why: Exclude<WireReply['kind'], 'answered'>; ms: number };

export function callResult(reply: WireReply): CallResult {
  if (reply.kind !== 'answered') return { kind: 'no_answer', why: reply.kind, ms: reply.ms };
  const { message, status, ms } = reply;
  if (message?.error) return { kind: 'protocol_error', code: message.error.code, message: message.error.message, ms };
  if (status < 200 || status >= 300 || !message?.result) return { kind: 'http_error', status, ms };
  const content = Array.isArray(message.result.content) ? (message.result.content as { text?: unknown }[]) : [];
  return {
    kind: 'result',
    text: content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n'),
    isError: message.result.isError === true,
    ms,
  };
}
