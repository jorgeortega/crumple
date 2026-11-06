import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A real `wrangler dev`: Cloudflare's workerd on this machine, reached over a real socket. It deploys
// nothing and needs no Cloudflare account. Telemetry is off, so running the tests tells nobody.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler');
const STARTUP_MS = 90_000;

const ENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };

export interface RunningWorker {
  url: string;
  logs(): string;
  /** Reads the local D1 database directly, to see what the Worker really wrote. */
  d1(sql: string): Promise<unknown[]>;
  stop(): Promise<void>;
}

export interface WorkerOptions {
  config?: string;
  port: number;
  /** Set here rather than in the config, so a test can't change what would be deployed. */
  vars?: Record<string, string>;
  /** D1 tables to create before starting. */
  migrate?: boolean;
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(WRANGLER, args, { cwd: ROOT, env: ENV });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.once('exit', (code) => { if (code === 0) resolve(out); else reject(new Error(`wrangler ${args.join(' ')} failed:\n${out}`)); });
  });
}

export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const { config = 'workers/wrangler.toml', port, vars = {}, migrate = false } = options;
  const state = mkdtempSync(join(tmpdir(), 'crumple-workers-'));
  if (migrate) await run(['d1', 'migrations', 'apply', 'DB', '--local', '--config', config, '--persist-to', state]);

  const args = ['dev', '--config', config, '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state, '--inspector-port', String(port + 1000), '--show-interactive-dev-session=false'];
  for (const [name, value] of Object.entries(vars)) args.push('--var', `${name}:${value}`);

  const child: ChildProcess = spawn(WRANGLER, args, { cwd: ROOT, env: ENV });
  let logs = '';
  child.stdout?.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve(); }); });

  const stop = async (): Promise<void> => {
    child.kill('SIGTERM');
    await exited;
    rmSync(state, { recursive: true, force: true });
  };

  const d1 = async (sql: string): Promise<unknown[]> => {
    const out = await run(['d1', 'execute', 'DB', '--local', '--json', '--config', config, '--persist-to', state, '--command', sql]);
    return (JSON.parse(out) as { results: unknown[] }[])[0]?.results ?? [];
  };

  const url = `http://127.0.0.1:${String(port)}`;
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${logs}`);
    if (logs.includes('Ready on')) {
      try {
        await fetch(url);
        return { url, logs: () => logs, stop, d1 };
      } catch {
        // Announced, and not quite listening yet.
      }
    }
    if (Date.now() - started > STARTUP_MS) {
      await stop();
      throw new Error(`wrangler dev never got ready:\n${logs}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
