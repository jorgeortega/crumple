// Throwaway. Rough cost of building a server per request, in process, no network.
// Numbers are from one laptop and only meant to find out if this is a problem at all.
const started = performance.now();
const { buildHandler } = await import('./handler.mjs');
console.log(`loading the SDK: ${(performance.now() - started).toFixed(0)} ms`);

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'cost', version: '0' },
};

function request(id, method, name, params) {
  const headers = {
    authorization: 'Bearer spike-reader',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
  };
  if (name) headers['mcp-name'] = name;
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }),
  });
}

const quantile = (sorted, q) => sorted[Math.floor(sorted.length * q)].toFixed(2);

for (const extraTools of [0, 50, 200, 1000]) {
  const handle = buildHandler({ extraTools });
  const times = [];
  for (let i = 0; i < 300; i += 1) {
    const t = performance.now();
    const response = await handle(request(i, 'tools/call', 'get_customer', { name: 'get_customer', arguments: { id: 'cus_1' } }));
    const body = await response.json();
    if (body.error || body.result?.isError) throw new Error(JSON.stringify(body));
    if (i >= 50) times.push(performance.now() - t); // skip warm-up
  }
  times.sort((a, b) => a - b);
  console.log(`${String(extraTools + 1).padStart(5)} tools: p50 ${quantile(times, 0.5)} ms, p99 ${quantile(times, 0.99)} ms per tools/call`);
}
process.exit(0);
