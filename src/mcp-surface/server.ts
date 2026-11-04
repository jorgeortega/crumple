import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  validateHostHeader,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { createAccessControl, type JwtConfig, type KeyStore, type Principal } from '../access-control/index.js';
import { createExecutor, type ExecutorOptions } from '../executor/index.js';
import { parseTraceparent, type Attributes, type Audit, type Span, type Telemetry } from '../telemetry/index.js';
import type { SurfaceTool } from './convert.js';
import { invalidArguments, toToolResult, type ToolResult } from './results.js';

// The part an agent talks to. There's one handler for tools/list and one for tools/call, written
// here rather than registering each tool with the SDK. The usual way answers "not found" for a
// hidden tool before any of our code runs, so an attempted delete would leave no record, and
// that attempt is exactly what C2 is about. Here every call goes through access.authorize().

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_NAME_IN_ERROR = 128;
const RETRY_AFTER_S = '5';

export interface AccessOptions {
  keys?: KeyStore;
  jwt?: JwtConfig;
  /** How issuer keys are fetched. */
  fetch?: typeof fetch;
}

export interface McpSurfaceOptions {
  tools: readonly SurfaceTool[];
  upstream: Omit<ExecutorOptions, 'telemetry'>;
  access?: AccessOptions;
  telemetry: Telemetry;
  audit: Audit;
  name?: string;
  version?: string;
  path?: string;
  /** Exact origins, such as https://app.example.com. Empty refuses every browser. */
  allowedOrigins?: readonly string[];
  /** Hostnames for a local server, to stop DNS rebinding. Off when left out. */
  allowedHosts?: string[];
  now?: () => number;
}

export interface McpSurface {
  fetch(request: Request): Promise<Response>;
  /** Tools the validator couldn't compile, left out at start rather than failing on a call. */
  warnings: readonly string[];
}

interface SignedIn {
  principal: Principal;
  authMs: number;
}

/** No token goes to the SDK, so a later SDK feature can't forward what it never had (C3). */
export function signedInInfo(principal: Principal, authMs: number): AuthInfo {
  const extra: Record<string, unknown> = { principal, authMs };
  return { token: '', clientId: principal.id, scopes: [], extra };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const refusedMessage = (name: string): string =>
  `Unknown tool: ${name.slice(0, MAX_NAME_IN_ERROR)}. It may not exist, or this caller may not be allowed to use it.`;

export function createMcpSurface(options: McpSurfaceOptions): McpSurface {
  const { upstream, telemetry, audit, path = '/mcp', allowedOrigins = [], allowedHosts, name = 'crumple', version = '0.0.0', now = () => Date.now() } = options;

  const access = createAccessControl({
    keys: options.access?.keys,
    ...(options.access?.jwt ? { jwt: options.access.jwt } : {}),
    ...(options.access?.fetch ? { fetch: options.access.fetch } : {}),
    telemetry,
    audit,
    now,
  });
  const executor = createExecutor({ ...upstream, telemetry });

  // Compiled once at start, because a schema the validator can't read should say so now, and
  // not on some later call. Rejected tools leave the list.
  const warnings: string[] = [];
  const tools = new Map<string, { tool: SurfaceTool; validator: ReturnType<typeof fromJsonSchema> }>();
  for (const tool of options.tools) {
    try {
      tools.set(tool.name, { tool, validator: fromJsonSchema(tool.inputSchema) });
    } catch {
      warnings.push(`${tool.name}: its input schema couldn't be compiled, so it was left out.`);
    }
  }
  const available = [...tools.values()].map(({ tool }) => tool);

  const listed = (tool: SurfaceTool) => ({
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description,
    inputSchema: tool.inputSchema as { type: 'object' },
    annotations: tool.annotations,
  });

  function serverSpan(spanName: string, method: string, signedIn: SignedIn, meta: unknown, request: Request | undefined, requestId: unknown, more: Attributes = {}): Span {
    const parent = parseTraceparent((meta as { traceparent?: unknown } | undefined)?.traceparent);
    const protocol = request?.headers.get('mcp-protocol-version');
    return telemetry.startSpan(spanName, {
      kind: 'server',
      ...(parent ? { parent } : {}),
      attributes: {
        'mcp.method.name': method,
        'crumple.caller': signedIn.principal.id,
        'crumple.auth_ms': signedIn.authMs,
        'jsonrpc.request.id': String(requestId),
        ...(protocol ? { 'mcp.protocol.version': protocol } : {}),
        ...more,
      },
    });
  }

  const handler = createMcpHandler(
    ({ authInfo, requestInfo }) => {
      const signedIn = authInfo?.extra as unknown as SignedIn;
      const mcp = new McpServer({ name, version });
      mcp.server.registerCapabilities({ tools: {} });

      mcp.server.setRequestHandler('tools/list', (request, ctx) => {
        const span = serverSpan('tools/list', 'tools/list', signedIn, request.params?._meta, requestInfo, ctx.mcpReq.id);
        const visible = access.visible(signedIn.principal, available);
        span.end();
        return Promise.resolve({ tools: visible.map(listed) });
      });

      mcp.server.setRequestHandler('tools/call', async (request, ctx): Promise<ToolResult> => {
        const requested = request.params.name;
        const known = tools.get(requested);
        // A tool that doesn't exist gets no name on the span. The caller chose that text.
        const span = serverSpan(
          known ? `tools/call ${known.tool.name}` : 'tools/call',
          'tools/call',
          signedIn,
          request.params._meta,
          requestInfo,
          ctx.mcpReq.id,
          known ? { 'gen_ai.tool.name': known.tool.name, 'gen_ai.operation.name': 'execute_tool' } : {},
        );

        try {
          // Always runs, and always leaves an audit event.
          const decision = access.authorize(signedIn.principal, known?.tool, { parentSpan: span, requested });
          if (!known || !decision.allow) {
            span.end({ errorType: decision.allow ? 'no_grant' : decision.reason });
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, refusedMessage(requested));
          }

          // Only now, so a refused caller learns nothing about the schema.
          const args = request.params.arguments ?? {};
          const checked = await known.validator['~standard'].validate(args);
          if (checked.issues) {
            span.end({ errorType: 'tool_error' });
            return invalidArguments(checked.issues.map((issue) => issue.message).join('; '));
          }

          const outcome = await executor.call(known.tool.operation, args, { caller: signedIn.principal.id, parentSpan: span, signal: ctx.mcpReq.signal });
          span.end(outcome.ok ? {} : { errorType: 'tool_error' });
          return toToolResult(outcome);
        } catch (error) {
          if (error instanceof ProtocolError) throw error;
          // Whatever this was, its text could hold anything, so it doesn't leave.
          span.end({ errorType: 'internal_error' });
          throw new ProtocolError(ProtocolErrorCode.InternalError, 'Something went wrong in Crumple. The call may not have been made.');
        }
      });

      return mcp;
    },
    // 'stateless' serves older clients from this same factory. The official TypeScript client
    // negotiates 2025-11-25 unless told otherwise, so a 2026-only server would turn it away.
    { legacy: 'stateless', maxRequestBodySize: MAX_BODY_BYTES },
  );

  const metadata = access.resourceMetadata();
  const metadataPath = metadata && new URL(metadata.url).pathname;

  return {
    warnings,

    async fetch(request) {
      if (allowedHosts && !validateHostHeader(request.headers.get('host'), allowedHosts).ok) {
        return json(403, { error: 'This host isn\'t allowed.' });
      }

      const { pathname } = new URL(request.url);
      // Public on purpose: it's how a client finds out where to sign in.
      if (metadata && pathname === metadataPath && request.method === 'GET') return json(200, metadata.document);
      if (pathname !== path) return json(404, { error: `Not found. The MCP endpoint is ${path}.` });

      // MCP says MUST, to stop DNS rebinding. CLI clients send no Origin, so they're unaffected.
      const origin = request.headers.get('origin');
      if (origin !== null && !allowedOrigins.includes(origin)) return json(403, { error: 'This origin isn\'t allowed.' });

      // Before the body is read, so a stranger costs a header check and nothing else.
      const started = now();
      const who = await access.authenticate(request.headers.get('authorization'));
      if (!who.ok) {
        return who.status === 401
          ? json(401, { error: 'A valid API key or token is required.' }, { 'www-authenticate': who.challenge ?? 'Bearer' })
          : json(503, { error: 'Crumple couldn\'t check your credentials just now. Try again shortly.' }, { 'retry-after': RETRY_AFTER_S });
      }

      return handler.fetch(request, { authInfo: signedInInfo(who.principal, now() - started) });
    },
  };
}
