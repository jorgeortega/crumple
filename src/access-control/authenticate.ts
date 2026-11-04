import type { Audit, Span, Telemetry } from '../telemetry/index.js';
import { createKeySource } from './jwks.js';
import { verifyJwt, type JwtClaims, type JwtResult } from './jwt.js';
import { hashKey, isKeyShaped, KEY_PREFIX, parseBearer, sha256Hex, type KeyStore } from './keys.js';
import { decide, findWildcardWrite, type Decision, type Grant, type Principal, type ToolInfo } from './policy.js';

// Who is calling, and may they do this? This module decides, and mcp-surface acts on the
// answer. Every decision leaves a span and an audit event, with no arguments in either.

/**
 * The memory audit log keeps the newest events, so a stranger with bad keys could otherwise
 * evict real ones. This slows that down rather than stopping it: a steady flood would still
 * fill the memory log in hours, which is one reason to save events through the store.
 */
export const FAILED_SIGN_INS_PER_MINUTE = 60;

const MINUTE_MS = 60_000;
const ANONYMOUS = 'anonymous';
const NOT_A_TOOL = '-';
const UNKNOWN_TOOL = 'unknown';
const CALLER_HASH_LENGTH = 16;

type Checked = { principal: Principal } | { reason: string; invalidToken?: boolean };

export type Authentication =
  | { ok: true; principal: Principal }
  /** 401 means "your credentials are bad". 503 means "we couldn't check", which is still a refusal. */
  | { ok: false; status: 401 | 503; challenge?: string };

/** Exactly what this server trusts. The token gets no say in any of it. */
export interface JwtConfig {
  issuer: string;
  /** MCP requires checking this: a token issued for another service is refused. */
  audience: string;
  jwksUri: string;
  /** This server's address, for Protected Resource Metadata. */
  resource: string;
  /** What each scope allows. A scope nobody mapped grants nothing. */
  scopes: Record<string, readonly Grant[]>;
  /** RFC 9068's typ check. Off by default: MCP doesn't require that profile. */
  requireAccessTokenType?: boolean;
}

export interface AccessControlOptions {
  keys?: KeyStore | undefined;
  jwt?: JwtConfig;
  telemetry: Telemetry;
  audit: Audit;
  fetch?: typeof fetch;
  now?: () => number;
}

/** RFC 9728's document, and where to serve it. */
export interface ResourceMetadata {
  url: string;
  document: {
    resource: string;
    authorization_servers: string[];
    scopes_supported: string[];
    bearer_methods_supported: string[];
  };
}

export interface SpanContext {
  parentSpan?: Span;
}

export interface AccessControl {
  authenticate(authorization: string | null | undefined, context?: SpanContext): Promise<Authentication>;
  /** The tools this caller may see. A courtesy to the model: `authorize` is the security. */
  visible<Tool extends ToolInfo>(principal: Principal, tools: readonly Tool[]): Tool[];
  /** Pass `undefined` for a tool that doesn't exist, and `requested` for the name asked for. */
  authorize(principal: Principal, tool: ToolInfo | undefined, context?: SpanContext & { requested?: string }): Decision;
  /** Failed sign-ins past the cap: counted, but not written to the audit log. */
  suppressedSignIns(): number;
  /** Only with an issuer configured. MCP requires it, and mcp-surface serves it. */
  resourceMetadata(): ResourceMetadata | undefined;
  /** Which scopes would allow this tool, for a 403's `scope` parameter. */
  scopesFor(tool: ToolInfo): string[];
}

/** How a JWT caller appears in traces: a hash, because a `sub` is often an email address. */
export async function callerId(issuer: string, subject: string): Promise<string> {
  return `jwt_${(await sha256Hex(`${issuer}\n${subject}`)).slice(0, CALLER_HASH_LENGTH)}`;
}

function checkedScopes(jwt: JwtConfig): Map<string, readonly Grant[]> {
  // A Map, so a token with the scope `__proto__` finds nothing rather than Object's prototype.
  const scopes = new Map(Object.entries(jwt.scopes));
  for (const [scope, grants] of scopes) {
    if (findWildcardWrite(grants)) {
      throw new Error(`Scope ${scope} grants * with writes. A grant of * only covers reads, so grant each write tool by name.`);
    }
  }
  return scopes;
}

function metadataFor(jwt: JwtConfig): ResourceMetadata {
  const resource = new URL(jwt.resource);
  // RFC 9728: the well-known part goes between the host and the path.
  const path = resource.pathname === '/' ? '' : resource.pathname;
  return {
    url: `${resource.origin}/.well-known/oauth-protected-resource${path}`,
    document: {
      resource: jwt.resource,
      authorization_servers: [jwt.issuer],
      scopes_supported: Object.keys(jwt.scopes),
      bearer_methods_supported: ['header'],
    },
  };
}

// Most issuers use `scope`, a space-separated string. Some use `scp`, as a string or a list.
function scopesIn(claims: JwtClaims): string[] {
  const { scope, scp } = claims;
  const words = (value: unknown): string[] => (typeof value === 'string' ? value.split(' ').filter(Boolean) : []);
  const listed = Array.isArray(scp) ? scp.flatMap(words) : words(scp);
  return [...new Set([...words(scope), ...listed])];
}

export function createAccessControl(options: AccessControlOptions): AccessControl {
  const { keys, jwt, telemetry, audit, now = () => Date.now() } = options;

  const scopes = jwt ? checkedScopes(jwt) : new Map<string, readonly Grant[]>();
  const metadata = jwt && metadataFor(jwt);
  const keySource = jwt && createKeySource({ jwksUri: jwt.jwksUri, now, ...(options.fetch ? { fetch: options.fetch } : {}) });

  const challenge = (invalidToken: boolean): string => {
    const parts = [...(invalidToken ? ['error="invalid_token"'] : []), ...(metadata ? [`resource_metadata="${metadata.url}"`] : [])];
    return parts.length === 0 ? 'Bearer' : `Bearer ${parts.join(', ')}`;
  };

  let windowStart = Number.NEGATIVE_INFINITY;
  let windowCount = 0;
  let suppressed = 0;

  function startSpan(name: string, context: SpanContext | undefined): Span {
    return context?.parentSpan ? context.parentSpan.child(name) : telemetry.startSpan(name);
  }

  function recordFailedSignIn(reason: string, traceId: string): void {
    const at = now();
    if (at - windowStart >= MINUTE_MS) {
      windowStart = at;
      windowCount = 0;
    }
    windowCount += 1;
    if (windowCount > FAILED_SIGN_INS_PER_MINUTE) {
      suppressed += 1;
      return;
    }
    audit.record({ caller: ANONYMOUS, tool: NOT_A_TOOL, decision: 'deny', reason, traceId });
  }

  // What the store says about a key. A caller only ever gets one answer for these, and the
  // audit log gets the real reason, so an operator can spot a revoked key still in use.
  async function checkKey(token: string): Promise<Checked> {
    if (!keys || !isKeyShaped(token)) return { reason: 'invalid_key' };
    const record = await keys.findByHash(await hashKey(token));
    if (!record) return { reason: 'invalid_key' };
    if (record.revokedAt !== undefined) return { reason: 'revoked_key' };
    return { principal: { id: record.id, kind: 'key', grants: record.grants } };
  }

  async function checkJwt(token: string, config: JwtConfig, source: NonNullable<typeof keySource>): Promise<Checked> {
    const expected = {
      issuer: config.issuer,
      audience: config.audience,
      now: now(),
      ...(config.requireAccessTokenType ? { requireAccessTokenType: true } : {}),
    };
    const held = await source.get();
    // "We couldn't check" isn't "this token is bad". The caller below turns this into a 503.
    if (!held) throw new Error('No issuer keys');

    let result: JwtResult = await verifyJwt(token, held, expected);
    if (!result.ok && result.reason === 'no_key') {
      // An unknown key id usually means the issuer rotated its keys.
      result = await verifyJwt(token, (await source.refresh()) ?? held, expected);
    }
    if (!result.ok) return { reason: result.reason, invalidToken: true };

    const grants = scopesIn(result.claims).flatMap((scope) => scopes.get(scope) ?? []);
    return { principal: { id: await callerId(config.issuer, result.claims.sub), kind: 'jwt', grants } };
  }

  return {
    async authenticate(authorization, context) {
      const span = startSpan('authenticate', context);

      const refuse = (status: 401 | 503, reason: string, invalidToken = false): Authentication => {
        span.end({ attributes: { 'crumple.decision': 'deny', 'crumple.decision.reason': reason }, errorType: reason });
        recordFailedSignIn(reason, span.context.traceId);
        return status === 401 ? { ok: false, status, challenge: challenge(invalidToken) } : { ok: false, status };
      };

      const token = parseBearer(authorization);
      if (token === undefined) return refuse(401, 'no_credentials');

      let result: Checked;
      try {
        // The token's shape picks the path, so there's never a "try one, then the other".
        if (token.startsWith(KEY_PREFIX) || !jwt || !keySource) result = await checkKey(token);
        else result = await checkJwt(token, jwt, keySource);
      } catch {
        return refuse(503, 'unavailable');
      }
      if ('reason' in result) return refuse(401, result.reason, result.invalidToken);

      span.end({ attributes: { 'crumple.caller': result.principal.id, 'crumple.decision': 'allow' } });
      return { ok: true, principal: result.principal };
    },

    visible: (principal, tools) => tools.filter((tool) => decide(principal, tool).allow),

    authorize(principal, tool, context) {
      const name = tool?.name ?? context?.requested ?? UNKNOWN_TOOL;
      const span = startSpan('authorize', context);
      const decision = decide(principal, tool);
      const attributes = { 'crumple.caller': principal.id, 'gen_ai.tool.name': name };

      if (decision.allow) {
        span.end({ attributes: { ...attributes, 'crumple.decision': 'allow' } });
        audit.record({ caller: principal.id, tool: name, decision: 'allow', traceId: span.context.traceId });
      } else {
        span.end({ attributes: { ...attributes, 'crumple.decision': 'deny', 'crumple.decision.reason': decision.reason }, errorType: decision.reason });
        audit.record({ caller: principal.id, tool: name, decision: 'deny', reason: decision.reason, traceId: span.context.traceId });
      }
      return decision;
    },

    suppressedSignIns: () => suppressed,

    resourceMetadata: () => metadata,

    scopesFor: (tool) =>
      [...scopes].filter(([, grants]) => decide({ id: '', kind: 'jwt', grants }, tool).allow).map(([scope]) => scope),
  };
}
