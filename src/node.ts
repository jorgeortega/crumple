import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline, Readable } from 'node:stream';

// Node's server isn't web-standard but the rest of Crumple is, so this is the one place
// that translates. On Workers there's nothing to translate.

export type FetchHandler = (request: Request) => Promise<Response>;

export interface NodeServer {
  url: string;
  close(): Promise<void>;
}

export interface ServeOptions {
  port?: number;
  host?: string;
}

function toRequest(req: IncomingMessage, base: string, signal: AbortSignal): Request {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i] ?? '', req.rawHeaders[i + 1] ?? '');
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', base), {
    method: req.method ?? 'GET',
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' as const } : {}),
  });
}

async function respond(handler: FetchHandler, base: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // A caller giving up has to reach the handler as an abort. Without this, a handler
  // waiting on something could never tell it was abandoned.
  const abort = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) abort.abort(new Error('The client disconnected.'));
  });

  let response: Response;
  try {
    response = await handler(toRequest(req, base, abort.signal));
  } catch {
    // Dropping the connection is the honest answer: the caller learns nothing, as it
    // would if the process died.
    res.destroy();
    return;
  }

  res.writeHead(response.status, Object.fromEntries(response.headers));
  // Node holds headers back until the first body write. A body that fails first would lose
  // them too, so a failure partway through would look like no response at all.
  res.flushHeaders();
  if (!response.body) {
    res.end();
    return;
  }
  // pipeline tears both ends down on failure, so a body that errors partway reaches the
  // caller as a lost connection, and a caller that leaves cancels the body. There's no
  // one left to tell, so the callback has nothing to do.
  pipeline(Readable.fromWeb(response.body), res, () => undefined);
}

// An IPv6 address needs brackets in a URL.
const urlHost = (host: string): string => (host.includes(':') ? `[${host}]` : host);

export async function serveOnNode(handler: FetchHandler, options: ServeOptions = {}): Promise<NodeServer> {
  const { port = 0, host = '127.0.0.1' } = options;

  const server = createServer((req, res) => {
    const { port: actual } = server.address() as AddressInfo;
    void respond(handler, `http://${urlHost(host)}:${actual}`, req, res);
  });

  // Without the 'error' listener, a port in use would crash the process with a raw stack trace.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port: actual } = server.address() as AddressInfo;

  return {
    url: `http://${urlHost(host)}:${actual}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
