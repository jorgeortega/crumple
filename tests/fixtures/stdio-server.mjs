// A local MCP server over stdio, built on the official SDK, so prove -- node ... meets a real one.
import { McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new McpServer({ name: 'stdio-fixture', version: '1.0.0' });
server.server.registerCapabilities({ tools: {} });
server.server.setRequestHandler('tools/list', () => Promise.resolve({
  tools: [
    { name: 'echo', description: 'Says it back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
    { name: 'wipe', description: 'Something nobody named, so it should never be called.', inputSchema: { type: 'object' } },
  ],
}));
server.server.setRequestHandler('tools/call', (request) => {
  if (request.params.name !== 'echo') throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown tool');
  return Promise.resolve({ content: [{ type: 'text', text: String(request.params.arguments?.text ?? '') }] });
});

await server.connect(new StdioServerTransport());
