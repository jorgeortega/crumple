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
