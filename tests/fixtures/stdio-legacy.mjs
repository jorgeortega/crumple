// An older stdio server that does the awkward things: it says nothing to a request before
// initialize, and it prints a line that isn't JSON to stdout. MODE changes how it misbehaves.
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'normal';
let ready = false;

/** @param {unknown} message */
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

if (mode === 'exit') process.exit(1);
if (mode === 'flood') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024));
}

process.stdout.write('this server logs to stdout by mistake\n');

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') {
    ready = true;
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'legacy', version: '1' } } });
  } else if (!ready || mode === 'hang') {
    // Nothing at all, which is what makes the probe need a timeout.
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'echo', description: 'Says it back.', inputSchema: { type: 'object' } }] } });
  } else if (method === 'tools/call') {
    if (params.name === 'echo') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } });
    else send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } });
  }
}
