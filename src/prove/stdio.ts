import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { MAX_RESPONSE_BYTES, type Budget, type JsonRpcReply, type SendOptions, type Transport, type WireReply } from '../mcp-client/client.js';

// MCP over a local process: newline-delimited JSON on its stdin and stdout. Many servers run this
// way, and they could never be given a URL. Nothing goes through a shell: the words someone typed
// after -- are run as they are. There's no token, because the process belongs to the person running it.

export interface StdioOptions {
  command: string[];
  timeoutMs: number;
  budget: Budget;
  /** How long to give a server to exit before it's made to. */
  exitGraceMs?: number;
}

interface Waiting {
  resolve: (reply: WireReply) => void;
  started: number;
}

const STDIO_HEADERS = new Headers();

export function createStdioTransport(options: StdioOptions): Transport {
  const { command, timeoutMs, budget, exitGraceMs = 500 } = options;
  const [program = '', ...args] = command;

  // stderr isn't read: a server's own logging is its business, and could hold anything.
  const child: ChildProcessWithoutNullStreams = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map<unknown, Waiting>();
  let gone = false;
  let buffer = '';

  const settleAll = (kind: 'unreachable' | 'too_large'): void => {
    gone = true;
    for (const [id, { resolve, started }] of waiting) {
      waiting.delete(id);
      resolve({ kind, ms: performance.now() - started });
    }
  };

  const handleLine = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Some servers print to stdout by mistake. It isn't an answer, and the timeout covers the rest.
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const message = parsed as JsonRpcReply;
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    entry.resolve({ kind: 'answered', status: 200, headers: STDIO_HEADERS, message, ms: performance.now() - entry.started });
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_RESPONSE_BYTES) {
      buffer = '';
      settleAll('too_large');
      child.kill();
      return;
    }
    let end = buffer.indexOf('\n');
    while (end !== -1) {
      handleLine(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf('\n');
    }
  });
  child.stderr.resume();
  // A program that doesn't exist arrives here, not as a throw.
  child.on('error', () => { settleAll('unreachable'); });
  child.on('close', () => { settleAll('unreachable'); });
  // Writing to a process that has just gone away must not stop this one.
  child.stdin.on('error', () => undefined);

  return {
    kind: 'stdio',

    send(message, sendOptions: SendOptions = {}) {
      if (!budget.take()) return Promise.resolve({ kind: 'budget', ms: 0 });
      const started = performance.now();
      if (gone) return Promise.resolve({ kind: 'unreachable', ms: 0 });

      return new Promise<WireReply>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(message.id);
          resolve({ kind: 'timeout', ms: performance.now() - started });
        }, sendOptions.timeoutMs ?? timeoutMs);
        waiting.set(message.id, {
          started,
          resolve: (reply) => {
            clearTimeout(timer);
            resolve(reply);
          },
        });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },

    notify(message) {
      if (!gone && budget.take()) child.stdin.write(`${JSON.stringify(message)}\n`);
      return Promise.resolve();
    },

    close() {
      if (gone) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, exitGraceMs);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        child.stdin.end();
      });
    },
  };
}
