import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The capability map says which module may use which. Here those rules are enforced
// from the map's own table, so the approved map can't drift away from the code.

const ROOT = fileURLToPath(new URL('..', import.meta.url));

type ModuleMap = Record<string, string[]>;
interface SourceFile {
  path: string;
  source: string;
}

function readMap(markdown: string): ModuleMap {
  const map: ModuleMap = {};
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const id = /^`([a-z-]+)`$/.exec(cells[1] ?? '')?.[1];
    if (!id || cells.length < 5) continue;
    // A note in brackets, such as "speaks to servers over MCP only", isn't a dependency.
    const dependsOn = (cells[3] ?? '').replace(/\(.*\)/, '');
    map[id] = [...dependsOn.matchAll(/`([a-z-]+)`/g)].map((match) => match[1] ?? '');
  }
  return map;
}

// The map gives cli "the wiring for the other commands" in words. This makes it exact.
const WIRING: ModuleMap = { cli: ['prove', 'evals', 'agent-runner'] };

// Only the layers that run in Crumple's own request path. prove and agent-runner speak
// MCP on purpose, so they may use a client library.
const NO_PROTOCOL_LIBRARY = ['fault-api', 'telemetry', 'executor', 'access-control'];

// These also run on Cloudflare Workers, so they use web-standard APIs only.
const WEB_STANDARD_ONLY = [...NO_PROTOCOL_LIBRARY, 'mcp-surface'];

function moduleOf(path: string): string | undefined {
  // An import names the compiled file, so an import of it arrives here as node.js.
  if (path === 'src/node.ts' || path === 'src/node.js') return 'cli';
  if (path.startsWith('workers/')) return 'hosted-demo';
  return /^src\/([^/]+)\//.exec(path)?.[1];
}

function importsOf(source: string): string[] {
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '');
}

function findViolations(files: SourceFile[], map: ModuleMap): string[] {
  const found: string[] = [];
  for (const { path, source } of files) {
    // Tests may reach across modules: an executor test needs fault-api to fail on command.
    if (path.endsWith('.test.ts')) continue;

    const from = moduleOf(path);
    const allowed = from === undefined ? undefined : map[from];
    if (from === undefined || allowed === undefined) {
      found.push(`${path} isn't in a module on the capability map`);
      continue;
    }

    for (const specifier of importsOf(source)) {
      if (specifier.startsWith('.')) {
        const target = moduleOf(posix.join(posix.dirname(path), specifier));
        const permitted = target === from || allowed.includes(target ?? '') || WIRING[from]?.includes(target ?? '');
        if (!permitted) found.push(`${path}: ${from} may not import ${target ?? specifier}`);
      } else if (specifier.startsWith('@modelcontextprotocol/') && NO_PROTOCOL_LIBRARY.includes(from)) {
        found.push(`${path}: ${from} must know nothing about MCP (${specifier})`);
      } else if (isBuiltin(specifier) && WEB_STANDARD_ONLY.includes(from)) {
        found.push(`${path}: ${from} runs on Workers and can't use ${specifier}`);
      }
    }
  }
  return found;
}

function hasCycle(map: ModuleMap): boolean {
  const visit = (id: string, path: string[]): boolean =>
    path.includes(id) || (map[id] ?? []).some((next) => visit(next, [...path, id]));
  return Object.keys(map).some((id) => visit(id, []));
}

function sourceFiles(folder: string): SourceFile[] {
  const absolute = join(ROOT, folder);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .map((file) => ({
      path: relative(ROOT, file).split('\\').join('/'),
      source: readFileSync(file, 'utf8'),
    }));
}

const MAP = readMap(readFileSync(join(ROOT, 'CAPABILITY-MAP.md'), 'utf8'));

describe('the capability map', () => {
  it('lists all twelve modules with their dependencies', () => {
    expect(Object.keys(MAP)).toHaveLength(12);
    expect(MAP['store']).toEqual(['access-control', 'telemetry']);
    expect(MAP['executor']).toEqual(['telemetry']);
    expect(MAP['fault-api']).toEqual([]);
    expect(MAP['prove']).toEqual(['fault-api', 'mcp-client']);
    expect(MAP['agent-runner']).toEqual(['telemetry', 'mcp-client']);
    expect(MAP['mcp-client']).toEqual([]);
    expect(MAP['mcp-surface']).toEqual(['executor', 'access-control', 'telemetry']);
  });

  it('has no cycles', () => {
    expect(hasCycle(MAP)).toBe(false);
    expect(hasCycle({ a: ['b'], b: ['a'] })).toBe(true);
  });
});

describe('findViolations', () => {
  const check = (path: string, source: string) => findViolations([{ path, source }], MAP);

  it.each([
    ['the executor importing the protocol layer', 'src/executor/call.ts', "import { x } from '../mcp-surface/server.js';"],
    ['the executor importing an MCP library', 'src/executor/call.ts', "import { x } from '@modelcontextprotocol/server';"],
    ['access control importing the executor', 'src/access-control/policy.ts', "import type { x } from '../executor/call.js';"],
    ['the agent reaching into the server', 'src/agent-runner/loop.ts', "const m = await import('../mcp-surface/server.js');"],
    ['prove reaching into the server', 'src/prove/run.ts', "import { x } from '../mcp-surface/server.js';"],
    ['the agent reaching into prove', 'src/agent-runner/loop.ts', "import { x } from '../prove/report.js';"],
    ['prove reaching into the agent', 'src/prove/run.ts', "import { x } from '../agent-runner/loop.js';"],
    ['the public demo reaching a paid model', 'workers/index.ts', "import { x } from '../src/agent-runner/claude.js';"],
    ['telemetry using a Node-only API', 'src/telemetry/spans.ts', "import { x } from 'node:fs';"],
    ['the protocol layer using a Node-only API', 'src/mcp-surface/server.ts', "import { x } from 'crypto';"],
    ['a folder the map doesn\'t know', 'src/helpers/util.ts', 'export const a = 1;'],
  ])('refuses %s', (_label, path, source) => {
    expect(check(path, source)).toHaveLength(1);
  });

  it.each([
    ['the executor using telemetry', 'src/executor/call.ts', "import { x } from '../telemetry/spans.js';"],
    ['a module importing itself', 'src/executor/call.ts', "import { x } from './errors.js';"],
    ['the protocol layer using its library', 'src/mcp-surface/server.ts', "import { x } from '@modelcontextprotocol/server';"],
    ['prove using an MCP client', 'src/prove/run.ts', "import { x } from '@modelcontextprotocol/client';"],
    ['the agent using the shared client', 'src/agent-runner/loop.ts', "import { x } from '../mcp-client/client.js';"],
    ['the CLI using Node', 'src/cli/main.ts', "import { x } from 'node:fs';"],
    ['the CLI wiring the commands', 'src/cli/main.ts', "import { x } from '../prove/run.js';"],
    ['the Node adapter using the protocol layer', 'src/node.ts', "import { x } from './mcp-surface/server.js';"],
    ['the demo using the protocol layer', 'workers/index.ts', "import { x } from '../src/mcp-surface/server.js';"],
    ['a test crossing modules', 'src/executor/call.test.ts', "import { x } from '../fault-api/app.js';"],
  ])('allows %s', (_label, path, source) => {
    expect(check(path, source)).toEqual([]);
  });
});

describe('the code in this repo', () => {
  it('follows the map', () => {
    const files = [...sourceFiles('src'), ...sourceFiles('workers')];
    expect(findViolations(files, MAP)).toEqual([]);
  });
});
