import { createData, failure, route, type Data, type Effect, type Reply } from './data.js';
import { OPENAPI } from './openapi.js';

// Obviously fake, and fine to publish. It stands for the customer's real API key, which
// Crumple seals and adds to the upstream request: C3 and C4 need something to test.
export const DEFAULT_CREDENTIAL = 'fault-api-fake-credential';

const DEFAULT_SCOPE = 'default';
const SCOPE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BODY_BYTES = 64 * 1024;

export interface FaultApiOptions {
  /** The upstream credential to require. */
  credential?: string;
  /** Turn on /_fault/*: the log, effects and reset. Off by default, for public use. */
  control?: boolean;
  now?: () => number;
  maxScopes?: number;
  maxRecords?: number;
  maxLogEntries?: number;
}

export interface RequestRecord {
  at: number;
  method: string;
  path: string;
  headers: Record<string, string>;
}

export interface FaultApi {
  fetch(request: Request): Promise<Response>;
  requests(scope?: string): RequestRecord[];
  effects(scope?: string): Effect[];
  reset(scope?: string): void;
  openapi: typeof OPENAPI;
}

interface StoredReply {
  fingerprint: string;
  reply: Reply;
}

interface Scope {
  data: Data;
  log: RequestRecord[];
  // Only stores successes, so it can't outgrow maxRecords. A failed request can try again.
  idempotency: Map<string, StoredReply>;
}

function json(reply: Reply, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// Reads no more than the cap, so a huge upload can't fill memory before it's refused.
async function readCapped(request: Request): Promise<string | undefined> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value: Uint8Array };
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}

export function createFaultApi(options: FaultApiOptions = {}): FaultApi {
  const {
    credential = DEFAULT_CREDENTIAL,
    control = false,
    now = () => Date.now(),
    maxScopes = 100,
    maxRecords = 1000,
    maxLogEntries = 1000,
  } = options;

  const scopes = new Map<string, Scope>();

  function scopeFor(name: string): Scope {
    let scope = scopes.get(name);
    if (scope) {
      // Moves it to the end, so the first key is always the least recently used.
      scopes.delete(name);
    } else {
      scope = { data: createData({ maxRecords, maxLogEntries }), log: [], idempotency: new Map() };
    }
    scopes.set(name, scope);
    for (const oldest of scopes.keys()) {
      if (scopes.size <= maxScopes) break;
      scopes.delete(oldest);
    }
    return scope;
  }

  const requests = (name = DEFAULT_SCOPE) => (scopes.get(name)?.log ?? []).map((record) => ({ ...record }));
  const effects = (name = DEFAULT_SCOPE) => (scopes.get(name)?.data.effects ?? []).map((effect) => ({ ...effect }));

  function reset(name?: string): void {
    if (name === undefined) scopes.clear();
    else scopes.delete(name);
  }

  function serveControl(request: Request, path: string, query: URLSearchParams): Response {
    const scope = query.get('scope') ?? undefined;
    if (request.method === 'GET' && path === '/_fault/requests') {
      return json({ status: 200, body: { items: requests(scope) } });
    }
    if (request.method === 'GET' && path === '/_fault/effects') {
      return json({ status: 200, body: { items: effects(scope) } });
    }
    if (request.method === 'POST' && path === '/_fault/reset') {
      reset(scope);
      return json({ status: 200, body: { reset: true } });
    }
    return json(failure(404, 'unknown_path', `There is nothing at ${path}.`));
  }

  async function serve(request: Request, scope: Scope, path: string, query: URLSearchParams): Promise<Response> {
    const text = await readCapped(request);
    if (text === undefined) {
      return json(failure(413, 'body_too_large', `A request body can be at most ${MAX_BODY_BYTES} bytes.`));
    }

    const key = request.method === 'POST' ? request.headers.get('idempotency-key') : null;
    if (key === null) return json(route(scope.data, request.method, path, query, text));

    const fingerprint = `${path}\n${text}`;
    const stored = scope.idempotency.get(key);
    if (stored) {
      if (stored.fingerprint !== fingerprint) {
        return json(failure(409, 'idempotency_key_reused', 'This Idempotency-Key was used with a different request.'));
      }
      return json(stored.reply, { 'idempotent-replayed': 'true' });
    }

    const reply = route(scope.data, request.method, path, query, text);
    if (reply.status < 300) scope.idempotency.set(key, { fingerprint, reply });
    return json(reply);
  }

  async function handle(request: Request): Promise<Response> {
    const { pathname: path, searchParams: query } = new URL(request.url);

    if (path === '/openapi.json' && request.method === 'GET') return json({ status: 200, body: OPENAPI as never });
    if (path.startsWith('/_fault/')) {
      return control ? serveControl(request, path, query) : json(failure(404, 'unknown_path', `There is nothing at ${path}.`));
    }

    const scopeName = request.headers.get('x-fault-scope') ?? DEFAULT_SCOPE;
    if (!SCOPE_PATTERN.test(scopeName)) {
      return json(failure(400, 'invalid_scope', 'x-fault-scope may hold up to 64 letters, digits, dots, dashes and underscores.'));
    }

    const scope = scopeFor(scopeName);
    // Logged before anything else, so a refused request still shows what arrived. That's
    // how C3 proves the agent's token never reached the upstream API.
    scope.log.push({ at: now(), method: request.method, path, headers: Object.fromEntries(request.headers) });
    if (scope.log.length > maxLogEntries) scope.log.shift();

    if (request.headers.get('authorization') !== `Bearer ${credential}`) {
      return json(failure(401, 'unauthorized', 'The upstream credential is missing or wrong.'));
    }
    return serve(request, scope, path, query);
  }

  return { fetch: handle, requests, effects, reset, openapi: OPENAPI };
}
