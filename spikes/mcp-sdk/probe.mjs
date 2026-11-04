// Throwaway. Runs the same checks against one URL with the official TypeScript client.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = new URL(process.argv[2]);
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

function client(token) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  // Pinned: the client defaults to the 2025 handshake, which would prove nothing here.
  const c = new Client({ name: 'spike-probe', version: '0.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  return { c, transport };
}

const reader = client('spike-reader');
await reader.c.connect(reader.transport);
const negotiated = reader.c.getNegotiatedProtocolVersion();
check('connects and negotiates 2026-07-28', negotiated === '2026-07-28', String(negotiated));

const readerTools = await reader.c.listTools();
check('a reader sees only the read tool', readerTools.tools.map((t) => t.name).join() === 'get_customer', readerTools.tools.map((t) => t.name).join());

const inputSchema = readerTools.tools[0]?.inputSchema;
check('the JSON Schema arrives unchanged', inputSchema?.properties?.id?.pattern === '^cus_' && inputSchema?.additionalProperties === false, JSON.stringify(inputSchema));

const called = await reader.c.callTool({
  name: 'get_customer',
  arguments: { id: 'cus_1' },
  _meta: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
});
const payload = JSON.parse(called.content[0].text);
check('a tool call runs', payload.id === 'cus_1' && payload.caller === 'reader', called.content[0].text);
check('traceparent in _meta reaches the tool', payload.traceparent?.includes('0af7651916cd43dd8448eb211c80319c') === true, String(payload.traceparent));

const invalid = await reader.c.callTool({ name: 'get_customer', arguments: { id: 'not-a-customer-id' } }).catch((e) => ({ thrown: e.message }));
check('a bad argument is refused by the schema', invalid.thrown !== undefined || invalid.isError === true, JSON.stringify(invalid).slice(0, 160));

const hidden = await reader.c.callTool({ name: 'delete_customer', arguments: { id: 'cus_1' } }).catch((e) => ({ thrown: e.message }));
check('a reader can\'t call the write tool', hidden.thrown !== undefined || hidden.isError === true, JSON.stringify(hidden).slice(0, 160));

const admin = client('spike-admin');
await admin.c.connect(admin.transport);
const adminTools = await admin.c.listTools();
check('an admin sees both tools', adminTools.tools.length === 2, adminTools.tools.map((t) => t.name).join());

const nokey = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('no key is refused before the SDK', nokey.status === 401, String(nokey.status));

// An older client: a 2025-era initialize, with no per-request envelope.
const legacy = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer spike-reader' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } } }),
});
const legacyText = await legacy.text();
check('an older 2025 client is still served', legacyText.includes('2025-06-18'), legacyText.slice(0, 160));

// The same client with no options, which is what most people will write.
const plain = new Client({ name: 'spike-default', version: '0.0.0' });
await plain.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: 'Bearer spike-reader' } } }));
const plainTools = await plain.listTools();
check('a client with default options still works', plainTools.tools.length === 1, String(plain.getNegotiatedProtocolVersion()));
console.log(`default client negotiated: ${String(plain.getNegotiatedProtocolVersion())}`);
await plain.close();

let failed = 0;
for (const { name, ok, detail } of results) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed against ${url}`);
console.log(`pinned client negotiated: ${String(negotiated)}`);
await reader.c.close();
await admin.c.close();
process.exit(failed ? 1 : 0);
