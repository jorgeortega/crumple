// What the executor needs to know about one operation, as plain data. mcp-surface fills
// this in from OpenAPI, so the executor never sees OpenAPI or MCP.

/**
 * - `safe`: repeating it can't change anything, so it can be retried.
 * - `with_key`: it takes an Idempotency-Key, so it can be retried with the same key.
 * - `never`: a write with no way to detect a repeat. One attempt, always.
 */
export type RetryPolicy = 'safe' | 'with_key' | 'never';

export interface OperationParam {
  /** The name in the API: the path placeholder, query key or header. */
  name: string;
  /** The name in the tool's arguments. */
  arg: string;
  in: 'path' | 'query' | 'header';
  style?: string;
  explode?: boolean;
}

export interface Operation {
  name: string;
  method: string;
  /** The template, such as /customers/{id}. This is what traces record, never the real URL. */
  path: string;
  params: OperationParam[];
  body?: { arg: string; contentType: string };
  retry: RetryPolicy;
  /** The API promises JSON, so an HTML page means something went wrong in between. */
  expectsJson?: boolean;
}

export type Credential =
  | { kind: 'none' }
  | { kind: 'header' | 'query'; name: string; value: string };
