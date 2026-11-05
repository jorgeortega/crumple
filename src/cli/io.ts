import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';

// Everything a command touches in the outside world comes through here, so a command can be
// tested without spawning a process. Commands return an exit code rather than calling exit.

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  readFile(path: string): Promise<string>;
  /** Makes the folder if it needs to. */
  writeFile(path: string, text: string): Promise<void>;
  fileExists(path: string): boolean;
  fetch: typeof fetch;
  now(): number;
  /** Resolves when it's time to stop. */
  waitForStop(): Promise<void>;
}

export function processIo(): Io {
  return {
    stdout: (text) => { process.stdout.write(`${text}\n`); },
    stderr: (text) => { process.stderr.write(`${text}\n`); },
    env: process.env,
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    },
    fileExists: existsSync,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    waitForStop: () =>
      new Promise((resolve) => {
        const stop = (): void => {
          // A second Ctrl-C means now.
          process.once('SIGINT', () => process.exit(130));
          resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      }),
  };
}

/** Every message says what went wrong and what to do next, so nothing else is shown to a person. */
export class CliError extends Error {
  constructor(message: string, readonly exitCode: 1 | 2) {
    super(message);
  }
}

/** Wrong usage: exit code 2. */
export const usage = (message: string): CliError => new CliError(message, 2);
/** Something failed at run time: exit code 1. */
export const failure = (message: string): CliError => new CliError(message, 1);

/**
 * Strict, so an unknown flag is an error. A misspelt --wirte quietly doing nothing would be a bad
 * surprise in a security tool.
 */
export function parseFlags<Options extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: Options) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw usage(`${(error as Error).message.split('.')[0] ?? 'Those options aren\'t right'}. Run crumple-mcp --help to see the options.`);
  }
}

export function readVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw usage(`--port should be a number from 0 to 65535, not ${value}.`);
  return port;
}

/** A port in use is the most likely way for a start to fail, so it gets a clear message. */
export function explainListenError(error: unknown, port: number): CliError {
  const { code, message } = error as { code?: string; message?: string };
  if (code === 'EADDRINUSE') return failure(`Port ${port} is already in use. Pick another with --port.`);
  return failure(`Couldn't start the server: ${message ?? 'unknown error'}.`);
}
