import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBudget, openSession } from './client.js';
import { proveServer, type NamedCall } from './external.js';
import { createStdioTransport } from './stdio.js';

const fixture = (name: string): string => fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url));
const SDK_SERVER = [process.execPath, fixture('stdio-server.mjs')];
const LEGACY_SERVER = [process.execPath, fixture('stdio-legacy.mjs')];

async function prove(command: string[], call?: NamedCall, timeoutMs = 5_000) {
  const budget = createBudget(30);
  const result = await proveServer({ transport: createStdioTransport({ command, timeoutMs, budget }), budget, hasToken: false, ...(call ? { call } : {}) });
  const check = (id: string) => result.checks.find((outcome) => outcome.id === id);
  return { result, check, budget };
}

describe('a real server over stdio', () => {
  it('lists tools from the official SDK, and calls only what was named', async () => {
    const { result, check, budget } = await prove(SDK_SERVER, { name: 'echo', args: { text: 'hello' } });
    expect(result.protocol).toBeDefined();
    expect(result.tools?.count).toBe(2);
    expect(check('speaks-mcp')?.state).toBe('pass');
    expect(check('named-tool')?.state).toBe('pass');
    expect(budget.used()).toBeLessThan(30);
  }, 15_000);

  it('shows the HTTP-only checks as not run', async () => {
    const { check, result } = await prove(SDK_SERVER);
    for (const id of ['refuses-no-token', 'refuses-bad-token', 'refuses-foreign-origin', 'malformed-request']) {
      expect(check(id)).toMatchObject({ state: 'not_run', detail: expect.stringContaining('HTTP') as string });
    }
    // There's no credential to speak of on a process someone started themselves.
    expect(result.notes.join()).not.toContain('no credential');
  }, 15_000);
});

describe('an awkward server over stdio', () => {
  it('copes with silence before initialize, and with text on stdout that isn\'t JSON', async () => {
    const budget = createBudget(30);
    const opened = await openSession(createStdioTransport({ command: LEGACY_SERVER, timeoutMs: 2_000, budget }), { probeTimeoutMs: 100 });
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.session.protocol).toBe('2025-11-25');
    expect((await opened.session.listTools(1)).tools.map((tool) => tool.name)).toEqual(['echo']);
    await opened.session.close();
  }, 10_000);

  it('reports a program that doesn\'t exist', async () => {
    const { check } = await prove(['/no/such/program-crumple']);
    expect(check('speaks-mcp')).toMatchObject({ state: 'fail', detail: expect.stringContaining('connection failed') as string });
  });

  it('reports a server that exits straight away', async () => {
    const { check } = await prove([...LEGACY_SERVER, 'exit']);
    expect(check('speaks-mcp')?.state).toBe('fail');
  });

  it('stops a server that floods its output', async () => {
    const { check } = await prove([...LEGACY_SERVER, 'flood']);
    expect(check('speaks-mcp')).toMatchObject({ state: 'fail', detail: expect.stringContaining('too large') as string });
  });

  it('gives up on a server that hangs, and still stops it', async () => {
    const { check } = await prove([...LEGACY_SERVER, 'hang'], undefined, 200);
    expect(check('unknown-tool')).toMatchObject({ state: 'fail', detail: expect.stringContaining('no answer came in time') as string });
  }, 15_000);

  it('makes a server exit that ignores being asked to', async () => {
    const budget = createBudget();
    const transport = createStdioTransport({ command: [process.execPath, '-e', 'process.stdin.resume(); process.stdin.on("end", () => setInterval(() => undefined, 1000))'], timeoutMs: 100, budget, exitGraceMs: 50 });
    await transport.close();
  });

  it('respects the budget, and stops sending once the process has gone', async () => {
    const budget = createBudget(0);
    const transport = createStdioTransport({ command: LEGACY_SERVER, timeoutMs: 100, budget });
    expect(await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toEqual({ kind: 'budget', ms: 0 });
    await transport.notify({ jsonrpc: '2.0', method: 'x' });
    expect(budget.used()).toBe(0);
    await transport.close();

    const roomy = createBudget();
    const closed = createStdioTransport({ command: LEGACY_SERVER, timeoutMs: 100, budget: roomy });
    await closed.close();
    expect((await closed.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).kind).toBe('unreachable');
    await closed.notify({ jsonrpc: '2.0', method: 'x' });
    await closed.close();
  });
});
