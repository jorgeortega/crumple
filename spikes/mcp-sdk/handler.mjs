// Throwaway. The same handler runs on Node and in workerd, which is the question.
import { createMcpHandler, fromJsonSchema, McpServer, TRACEPARENT_META_KEY } from '@modelcontextprotocol/server';

// A plain JSON Schema, because Crumple's tools come from OpenAPI, not from zod.
const customerId = {
  type: 'object',
  properties: { id: { type: 'string', description: 'The customer id', pattern: '^cus_' } },
  required: ['id'],
  additionalProperties: false,
};

// Authentication happens before the SDK, which never reads headers itself.
function authenticate(request) {
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (token === 'spike-reader') return { token, clientId: 'reader', scopes: ['read'] };
  if (token === 'spike-admin') return { token, clientId: 'admin', scopes: ['read', 'write'] };
  return undefined;
}

export function buildHandler({ extraTools = 0 } = {}) {
  const handler = createMcpHandler(
    ({ authInfo, era }) => {
      const server = new McpServer({ name: 'crumple-spike', version: '0.0.0' });

      server.registerTool(
        'get_customer',
        {
          description: 'Read one customer by id.',
          inputSchema: fromJsonSchema(customerId),
          annotations: { readOnlyHint: true },
        },
        async (args, ctx) => ({
          content: [{
            type: 'text',
            text: JSON.stringify({
              id: args.id,
              era,
              caller: authInfo?.clientId,
              traceparent: ctx.mcpReq?._meta?.[TRACEPARENT_META_KEY] ?? null,
              ctxKeys: Object.keys(ctx),
            }),
          }],
        }),
      );

      // The tool list depends on who's asking: a reader never sees this one.
      if (authInfo?.scopes.includes('write')) {
        server.registerTool(
          'delete_customer',
          { description: 'Delete one customer.', inputSchema: fromJsonSchema(customerId), annotations: { destructiveHint: true } },
          async (args) => ({ content: [{ type: 'text', text: `deleted ${args.id}` }] }),
        );
      }

      // Used only to measure what building a server per request costs.
      for (let i = 0; i < extraTools; i += 1) {
        server.registerTool(
          `extra_${i}`,
          { description: `Extra tool ${i}.`, inputSchema: fromJsonSchema(customerId) },
          async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        );
      }
      return server;
    },
    // 'auto', the default, still answers with one JSON body unless a tool sends something
    // before its result. 'json' prints a warning on every start, which is noise in a CLI.
    { responseMode: 'auto' },
  );

  return async (request) => {
    const authInfo = authenticate(request);
    if (!authInfo) return new Response('unauthorized\n', { status: 401 });
    return handler.fetch(request, { authInfo });
  };
}
