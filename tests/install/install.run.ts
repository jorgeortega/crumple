import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, rpc, textOf } from '../helpers/mcp.js';

// Checkpoint C: someone else could use it. A packed tarball, installed in an empty folder with no
// repository around it, run as a separate process with a real Ctrl-C. Everything else tests the
// source. This tests what a stranger gets, on the oldest Node we promise as well as the current one.

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FAKE_CREDENTIAL = 'Bearer fault-api-fake-credential';

interface Running {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  exited: Promise<number | null>;
}

let folder: string;
let bin: string;
let oldestNode: string;

function launch(node: string, args: string[], env: Record<string, string> = {}): Running {
  const child = spawn(node, [bin, ...args], { cwd: folder, env: { PATH: process.env.PATH ?? '', ...env } });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => { child.once('exit', resolve); });
  return { child, out: () => out, err: () => err, exited };
}

async function until(check: () => string | undefined, what: string, running: Running): Promise<string> {
  for (let i = 0; i < 200; i += 1) {
    const found = check();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Never saw ${what}. stdout: ${running.out()} stderr: ${running.err()}`);
}

async function stop(running: Running): Promise<number | null> {
  running.child.kill('SIGINT');
  return running.exited;
}

async function startFaultApi(node: string): Promise<{ running: Running; address: string }> {
  const running = launch(node, ['fault-api', '--port', '0']);
  const address = await until(() => /Address\s+(\S+)/.exec(running.out())?.[1], 'the address', running);
  return { running, address };
}

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'crumple-install-'));
  const { stdout } = await run('npm', ['pack', '--pack-destination', folder, '--json'], { cwd: ROOT });
  const [{ filename }] = JSON.parse(stdout.slice(stdout.indexOf('['))) as [{ filename: string }];
  writeFileSync(join(folder, 'package.json'), '{"name":"a-stranger","private":true}');
  await run('npm', ['install', '--no-audit', '--no-fund', join(folder, filename)], { cwd: folder });
  bin = join(folder, 'node_modules/crumple-mcp/dist/cli/bin.js');
  const located = await run('npx', ['-y', '-p', 'node@22.13.1', 'which', 'node'], { cwd: folder });
  oldestNode = located.stdout.trim().split('\n')[0] ?? '';
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('what ships', () => {
  it('holds no tests, specs or spikes', async () => {
    const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT });
    const [{ files }] = JSON.parse(stdout.slice(stdout.indexOf('['))) as [{ files: { path: string }[] }];
    const paths = files.map((file) => file.path);
    expect(paths).toContain('dist/cli/bin.js');
    expect(paths).toContain('LICENSE');
    expect(paths.filter((path) => /\.test\.|^tests\/|^spikes\/|^SPEC|^docs\/|^src\/|^tasks\//.test(path))).toEqual([]);
  });

  it('has a command someone can actually run by name', async () => {
    const { stdout } = await run(join(folder, 'node_modules/.bin/crumple-mcp'), ['--version'], { cwd: folder });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe.each([
  ['this Node', () => process.execPath],
  ['Node 22.13.1, the oldest we promise', () => oldestNode],
])('on %s', (_name, node) => {
  it('goes from an empty folder to a tool call, and stops cleanly', async () => {
    const fault = await startFaultApi(node());
    const server = launch(node(), ['serve', `${fault.address}/openapi.json`, '--upstream', fault.address, '--port', '0'], { CRUMPLE_UPSTREAM_CREDENTIAL: FAKE_CREDENTIAL });
    try {
      const key = await until(() => /crumple_[\w-]{43}/.exec(server.out())?.[0], 'the key', server);
      const endpoint = await until(() => /MCP endpoint\s+(\S+)/.exec(server.out())?.[1], 'the endpoint', server);

      const listed = await rpc(fetch, 'tools/list', {}, { token: key, url: endpoint });
      expect(listed.body.result?.tools?.map((tool) => tool.name)).toContain('getCustomer');

      const answer = await callTool(fetch, 'getCustomer', { id: 'cus_1' }, { token: key, url: endpoint });
      expect(JSON.parse(textOf(answer))).toMatchObject({ id: 'cus_1' });

      const refused = await callTool(fetch, 'deleteCustomer', { id: 'cus_1' }, { token: key, url: endpoint });
      expect(refused.body.error?.code).toBe(-32602);

      // A first run with no setup never touches SQLite, so it never shows its warning.
      expect(server.err()).not.toContain('ExperimentalWarning');
      expect(server.err()).not.toContain('fault-api-fake-credential');
    } finally {
      expect(await stop(server)).toBe(0);
      expect(await stop(fault.running)).toBe(0);
    }
  });

  it('keeps keys and audit events across a restart, with a database', async () => {
    const db = join(folder, `crumple-${node().length}.db`);
    const fault = await startFaultApi(node());
    const args = ['serve', `${fault.address}/openapi.json`, '--upstream', fault.address, '--port', '0', '--db', db];
    try {
      const first = launch(node(), args);
      const key = await until(() => /crumple_[\w-]{43}/.exec(first.out())?.[0], 'the key', first);
      const firstEndpoint = await until(() => /MCP endpoint\s+(\S+)/.exec(first.out())?.[1], 'the endpoint', first);
      await callTool(fetch, 'deleteCustomer', { id: 'cus_1' }, { token: key, url: firstEndpoint });
      expect(await stop(first)).toBe(0);

      const second = launch(node(), args);
      const secondEndpoint = await until(() => /MCP endpoint\s+(\S+)/.exec(second.out())?.[1], 'the endpoint', second);
      expect(second.out()).not.toContain('crumple_');
      expect((await callTool(fetch, 'getCustomer', { id: 'cus_1' }, { token: key, url: secondEndpoint })).status).toBe(200);
      expect(await stop(second)).toBe(0);

      const audit = launch(node(), ['audit', '--db', db, '--denied']);
      expect(await audit.exited).toBe(0);
      expect(audit.out()).toContain('deleteCustomer');
    } finally {
      await stop(fault.running);
    }
  });

  it('proves every claim it can from a packed tarball, with no test framework around', async () => {
    const proving = launch(node(), ['prove', '--self']);
    expect(await proving.exited).toBe(0);
    expect(proving.out()).toMatch(/12 passed, 0 failed, 0 not run/);
    expect(proving.err()).not.toContain('    at ');
  }, 60_000);

  it('says what to do when the file isn\'t there, with exit code 1 and no stack trace', async () => {
    const server = launch(node(), ['serve', './nothing.yaml']);
    expect(await server.exited).toBe(1);
    expect(server.err()).toContain('Check the path');
    expect(server.err()).not.toContain('    at ');
  });
});
