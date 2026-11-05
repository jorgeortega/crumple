import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Io } from '../../src/cli/io.js';
import { run } from '../../src/cli/main.js';

// Runs a command in this process, so a test sees exactly what a person would, without spawning.

export interface Harness {
  io: Io;
  out: () => string;
  err: () => string;
  all: () => string;
  /** Resolves when a long-running command has started and is waiting to be stopped. */
  ready: Promise<void>;
  stop: () => void;
}

export function harness(options: { env?: Record<string, string>; files?: Record<string, string>; fetch?: typeof fetch } = {}): Harness {
  let out = '';
  let err = '';
  let markReady: () => void = () => undefined;
  let stop: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  const files = options.files ?? {};

  return {
    io: {
      stdout: (text) => { out += `${text}\n`; },
      stderr: (text) => { err += `${text}\n`; },
      env: options.env ?? {},
      readFile: (path) => {
        const memory = files[path];
        if (memory !== undefined) return Promise.resolve(memory);
        return readFile(path, 'utf8');
      },
      writeFile: async (path, text) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text);
      },
      fileExists: (path) => existsSync(path),
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      now: () => Date.now(),
      waitForStop: () => {
        markReady();
        return stopped;
      },
    },
    out: () => out,
    err: () => err,
    all: () => out + err,
    ready,
    stop: () => { stop(); },
  };
}

/** Runs a command that finishes by itself. */
export async function runOnce(argv: string[], options: Parameters<typeof harness>[0] = {}): Promise<{ code: number; out: string; err: string }> {
  const h = harness(options);
  const code = await run(argv, h.io);
  return { code, out: h.out(), err: h.err() };
}

export interface Started extends Harness {
  finished: Promise<number>;
  endpoint: string;
  key: string | undefined;
}

/** Starts a long-running command, and waits for it either to be ready or to fail. */
export async function start(argv: string[], options: Parameters<typeof harness>[0] = {}): Promise<Started> {
  const h = harness(options);
  const finished = run(argv, h.io);
  await Promise.race([h.ready, finished]);
  const endpoint = /MCP endpoint\s+(\S+)/.exec(h.out())?.[1] ?? '';
  const key = /crumple_[\w-]{43}/.exec(h.out())?.[0];
  return { ...h, finished, endpoint, key };
}

const folders: string[] = [];

export function tempDb(): string {
  const folder = mkdtempSync(join(tmpdir(), 'crumple-cli-'));
  folders.push(folder);
  return join(folder, 'crumple.db');
}

export function cleanTempDbs(): void {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
}
