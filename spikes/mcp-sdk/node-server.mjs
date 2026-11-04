// Throwaway. Node has no web-standard server, so a few lines translate node:http to
// Request and Response. It avoids a third SDK package (@modelcontextprotocol/node).
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { buildHandler } from './handler.mjs';

const port = Number(process.argv[2] ?? 8801);
const handle = buildHandler({ extraTools: Number(process.env.EXTRA_TOOLS ?? 0) });

createServer(async (req, res) => {
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Readable.toWeb(req);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
    body,
    duplex: 'half',
  });
  const response = await handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) Readable.fromWeb(response.body).pipe(res);
  else res.end();
}).listen(port, '127.0.0.1', () => console.log(`node spike on http://127.0.0.1:${port}/mcp`));
