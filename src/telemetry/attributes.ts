// The only things a span can hold. Traces are where secrets most often escape, because
// logging feels harmless, so this is an allowlist: a denylist fails open, and the next
// secret nobody thought of would go straight through.
//
// Names follow OpenTelemetry's conventions, which are still marked Development and can
// change, so every name lives here and a rename is one edit.
// https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md
//
// Tool arguments and results aren't here, and there's no option to add them. A debugging
// flag that leaks customer data is exactly how these incidents happen.

export const ATTRIBUTES = {
  // The protocol
  'mcp.method.name': 'string',
  'mcp.protocol.version': 'string',
  'gen_ai.tool.name': 'string',
  'gen_ai.operation.name': 'string',
  'jsonrpc.request.id': 'string',

  // How it failed: a short code from our own list, never an upstream's error text, which
  // can repeat anything, including the credential.
  'error.type': 'string',

  // The upstream request. url.template holds /customers/{id}, never /customers/cus_1,
  // because a path can name a customer.
  'http.request.method': 'string',
  'http.response.status_code': 'number',
  'http.request.resend_count': 'number',
  'url.template': 'string',
  'server.address': 'string',

  // The model call
  'gen_ai.provider.name': 'string',
  'gen_ai.request.model': 'string',
  'gen_ai.usage.input_tokens': 'number',
  'gen_ai.usage.output_tokens': 'number',
  'gen_ai.usage.cache_read.input_tokens': 'number',
  'gen_ai.usage.cache_write.input_tokens': 'number',

  // Ours. crumple.caller is a key's id, never the key.
  'crumple.caller': 'string',
  'crumple.decision': 'string',
  'crumple.decision.reason': 'string',
  'crumple.auth_ms': 'number',
  'crumple.deadline_ms': 'number',
  'crumple.breaker.state': 'string',
  'crumple.retry.delay_ms': 'number',
  'crumple.queue_ms': 'number',
  'crumple.cost_usd': 'number',
} as const;

export type AttributeName = keyof typeof ATTRIBUTES;

export type Attributes = {
  [Name in AttributeName]?: (typeof ATTRIBUTES)[Name] extends 'number' ? number : string;
};
