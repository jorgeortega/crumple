import type { Audit, Span, Telemetry } from '../telemetry/index.js';
import { hashKey, isKeyShaped, KEY_PREFIX, parseBearer, type KeyStore } from './keys.js';
import { decide, type Decision, type Principal, type ToolInfo } from './policy.js';

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

export type Authentication =
  | { ok: true; principal: Principal }
  /** 401 means "your credentials are bad". 503 means "we couldn't check", which is still a refusal. */
  | { ok: false; status: 401 | 503; challenge?: string };

export interface AccessControlOptions {
  keys?: KeyStore | undefined;
  telemetry: Telemetry;
  audit: Audit;
  now?: () => number;
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
}

export function createAccessControl(options: AccessControlOptions): AccessControl {
  const { keys, telemetry, audit, now = () => Date.now() } = options;

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
  async function checkKey(token: string): Promise<{ principal: Principal } | { reason: string }> {
    if (!keys || !isKeyShaped(token)) return { reason: 'invalid_key' };
    const record = await keys.findByHash(await hashKey(token));
    if (!record) return { reason: 'invalid_key' };
    if (record.revokedAt !== undefined) return { reason: 'revoked_key' };
    return { principal: { id: record.id, kind: 'key', grants: record.grants } };
  }

  return {
    async authenticate(authorization, context) {
      const span = startSpan('authenticate', context);

      const refuse = (status: 401 | 503, reason: string): Authentication => {
        span.end({ attributes: { 'crumple.decision': 'deny', 'crumple.decision.reason': reason }, errorType: reason });
        recordFailedSignIn(reason, span.context.traceId);
        return status === 401 ? { ok: false, status, challenge: 'Bearer' } : { ok: false, status };
      };

      const token = parseBearer(authorization);
      if (token === undefined) return refuse(401, 'no_credentials');

      let result: Awaited<ReturnType<typeof checkKey>>;
      try {
        // The token's shape picks the path, so there's never a "try one, then the other".
        result = token.startsWith(KEY_PREFIX) ? await checkKey(token) : { reason: 'invalid_key' };
      } catch {
        return refuse(503, 'unavailable');
      }
      if ('reason' in result) return refuse(401, result.reason);

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
  };
}
