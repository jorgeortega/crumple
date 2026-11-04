import type { Outcome } from '../executor/index.js';

// What the agent gets back. MCP tells clients they SHOULD pass tool results to the model, so
// isError is how "what to do next" (C10) reaches it. A result is untrusted text whichever way it
// arrives, and no wrapping changes that, which is why permissions don't depend on the model (C2).

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: true;
}

const text = (value: string): ToolResult['content'] => [{ type: 'text', text: value }];

export function toToolResult(outcome: Outcome): ToolResult {
  if (!outcome.ok) return { content: text(JSON.stringify(outcome.error)), isError: true };
  // An empty result would leave a model guessing whether anything happened.
  return { content: text(outcome.body === '' ? `Done. The API answered ${String(outcome.status)} with no content.` : outcome.body) };
}

/** Bad arguments: nothing was sent upstream, and the message is what lets the model fix the call. */
export function invalidArguments(message: string): ToolResult {
  return { content: text(JSON.stringify({ code: 'invalid_arguments', message, retry: 'no' })), isError: true };
}
