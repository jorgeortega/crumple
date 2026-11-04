import type { RetryPolicy } from '../executor/index.js';

// What the policy and the executor need to know about an operation, worked out from the
// OpenAPI document. Pure, and separate on purpose: a PUT marked safe to retry is still a write.

const READS = new Set(['GET', 'HEAD']);
const IDEMPOTENCY_HEADER = 'idempotency-key';
const JSON_TYPE = /^application\/([\w.+-]*\+)?json\s*(;|$)/i;

/** The policy reads this. It trusts the API's methods, so a GET that deletes looks like a read. */
export const isWrite = (method: string): boolean => !READS.has(method.toUpperCase());

export const isIdempotencyParam = (param: { in: string; name: string }): boolean =>
  param.in === 'header' && param.name.toLowerCase() === IDEMPOTENCY_HEADER;

/** SPEC-executor.md's table. A write with no way to detect a repeat gets one attempt, always. */
export function retryPolicy(method: string, operation: { markedSafe: boolean; params: readonly { in: string; name: string }[] }): RetryPolicy {
  if (!isWrite(method) || operation.markedSafe) return 'safe';
  return operation.params.some(isIdempotencyParam) ? 'with_key' : 'never';
}

export const isJsonType = (contentType: string): boolean => JSON_TYPE.test(contentType);

/** An HTML page where JSON was promised means something went wrong in between. */
export const expectsJson = (successTypes: readonly string[]): boolean => successTypes.some(isJsonType);
