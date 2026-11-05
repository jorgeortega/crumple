import { afterEach, describe, expect, it } from 'vitest';
import { serveOnNode, type NodeServer } from './node.js';

const open: NodeServer[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

const hello = () => Promise.resolve(new Response('hello'));

describe('serveOnNode', () => {
  // It used to have no 'error' listener, so this crashed the process with a raw stack trace.
  it('rejects when the port is in use, rather than crashing', async () => {
    const first = await serveOnNode(hello);
    open.push(first);
    const { port } = new URL(first.url);
    await expect(serveOnNode(hello, { port: Number(port) })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('still serves after a failed attempt elsewhere', async () => {
    const first = await serveOnNode(hello);
    open.push(first);
    await expect(serveOnNode(hello, { port: Number(new URL(first.url).port) })).rejects.toBeDefined();
    expect(await (await fetch(first.url)).text()).toBe('hello');
  });

  it('puts brackets round an IPv6 address', async () => {
    const server = await serveOnNode(hello, { host: '::1' });
    open.push(server);
    expect(server.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    expect(await (await fetch(server.url)).text()).toBe('hello');
  });
});

describe('a caller who leaves', () => {
  it('doesn\'t take the process down when the answer comes after they\'ve gone', async () => {
    const unhandled: unknown[] = [];
    const notice = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', notice);

    let arrived: () => void = () => undefined;
    let finish: () => void = () => undefined;
    const seen = new Promise<void>((resolve) => { arrived = resolve; });
    const answer = new Promise<void>((resolve) => { finish = resolve; });
    const server = await serveOnNode(async (request) => {
      if (new URL(request.url).pathname === '/ok') return new Response('still here');
      arrived();
      await answer;
      return new Response('too late');
    });

    try {
      const abort = new AbortController();
      const leaving = fetch(`${server.url}/slow`, { signal: abort.signal }).catch(() => 'left');
      await seen;
      abort.abort();
      await leaving;
      // Long enough for the server to notice the connection closed.
      await new Promise((resolve) => setTimeout(resolve, 50));
      finish();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(unhandled).toEqual([]);
      expect(await (await fetch(`${server.url}/ok`)).text()).toBe('still here');
    } finally {
      process.off('unhandledRejection', notice);
      await server.close();
    }
  });
});
