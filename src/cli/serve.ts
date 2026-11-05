import {
  convertOpenApi,
  createAudit,
  createKey,
  createMcpSurface,
  createTelemetry,
  memoryKeyStore,
  otlpSink,
  type AuditSink,
  type Grant,
  type KeyStore,
  type OtlpSink,
  type SpanSink,
  type SurfaceTool,
} from '../mcp-surface/index.js';
import { serveOnNode, type NodeServer } from '../node.js';
import type { SqliteStore } from '../store/index.js';
import { parseConfig, type Config } from './config.js';
import { resolveCredential } from './credentials.js';
import { openDatabase } from './database.js';
import { CliError, explainListenError, failure, parseFlags, parsePort, readVersion, usage, type Io } from './io.js';
import { loadDocument } from './load.js';

// Puts the crumple zone in front of an API. Everything is wired here, and everything it does is
// in another module.

const DEFAULT_PORT = 3333;
const DEFAULT_HOST = '127.0.0.1';
const DENIALS = new Set(['no_grant', 'writes_not_allowed']);
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

const isLoopback = (host: string): boolean => host === 'localhost' || host === '::1' || /^127\./.test(host);

const clock = (at: number): string => new Date(at).toTimeString().slice(0, 8);

/** One line a call, from spans, which is why it can't hold an argument. */
export function logSink(io: Pick<Io, 'stderr'>): SpanSink {
  return {
    export(span) {
      const reason = span.attributes['crumple.decision.reason'];
      if (span.name === 'authenticate') {
        io.stderr(`${clock(span.endMs)}  sign-in refused  ${reason ?? ''}`);
        return;
      }
      if (span.kind !== 'server' || span.attributes['mcp.method.name'] !== 'tools/call') return;
      const error = span.attributes['error.type'];
      const outcome = error === undefined ? `ok  ${Math.round(span.endMs - span.startMs)} ms` : DENIALS.has(error) ? `denied  ${error}` : `failed  ${error}`;
      io.stderr(`${clock(span.endMs)}  ${span.name}  ${span.attributes['crumple.caller'] ?? ''}  ${outcome}`);
    },
  };
}

function writeGrants(names: string[], tools: readonly SurfaceTool[]): Grant[] {
  return names.map((name) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw usage(`--write ${name}: there's no tool with that name. The tools are: ${tools.map((candidate) => candidate.name).join(', ')}.`);
    if (!tool.writes) throw usage(`--write ${name}: that tool only reads, and the first key can already read.`);
    return { tool: name, writes: true };
  });
}

function upstreamFor(flag: string | undefined, fromDocument: string | undefined): URL {
  const value = flag ?? fromDocument;
  if (value === undefined) throw usage('Say where your API is, with --upstream https://api.example.com. The document has no absolute server to use.');
  try {
    return new URL(value);
  } catch {
    throw usage(`--upstream should be a full URL, such as https://api.example.com, not ${value}.`);
  }
}

export async function serveCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    upstream: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    db: { type: 'string' },
    write: { type: 'string', multiple: true },
    include: { type: 'string', multiple: true },
    exclude: { type: 'string', multiple: true },
    'credential-header': { type: 'string' },
    'credential-query': { type: 'string' },
    'allowed-origin': { type: 'string', multiple: true },
    'allowed-host': { type: 'string', multiple: true },
    otlp: { type: 'string' },
    config: { type: 'string' },
    quiet: { type: 'boolean', default: false },
  });

  const [source] = positionals;
  if (source === undefined) throw usage('Say which API to serve: serve ./openapi.yaml --upstream https://api.example.com.');
  const port = parsePort(values.port, DEFAULT_PORT);
  const host = values.host ?? DEFAULT_HOST;
  const writes = values.write ?? [];

  let config: Config = {};
  if (values.config !== undefined) {
    const text = await io.readFile(values.config).catch(() => {
      throw failure(`Couldn't read the config at ${values.config ?? ''}. Check the path.`);
    });
    config = parseConfig(text, values.config);
  }

  let conversion;
  try {
    conversion = convertOpenApi(await loadDocument(source, io), {
      ...(values.include ? { include: values.include } : {}),
      ...(values.exclude ? { exclude: values.exclude } : {}),
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw failure(`${source}: ${(error as Error).message}`);
  }
  for (const warning of conversion.warnings) io.stderr(`Warning: ${warning}`);
  if (conversion.tools.length === 0) throw failure(`${source} gave no tools to serve. Check the warnings above, and any --include or --exclude.`);

  const upstream = upstreamFor(values.upstream, conversion.baseUrl);
  const firstKeyWrites = writeGrants(writes, conversion.tools);

  let store: SqliteStore | undefined;
  let otlp: OtlpSink | undefined;
  let server: NodeServer | undefined;

  try {
    if (values.db !== undefined) store = await openDatabase(values.db, io);

    const credential = await resolveCredential({ header: values['credential-header'], query: values['credential-query'] }, store, io);
    if (credential.present && upstream.protocol === 'http:' && !isLoopback(upstream.hostname)) {
      io.stderr(`Warning: your credential will go to ${upstream.host} over plain HTTP, where anyone in between can read it.`);
    }

    if (values.otlp !== undefined) otlp = otlpSink({ endpoint: values.otlp, serviceName: 'crumple-mcp', version: readVersion() });
    const telemetry = createTelemetry({ sinks: [...(values.quiet ? [] : [logSink(io)]), ...(otlp ? [otlp] : [])] });

    // In memory there's no way to read audit events back, so none are kept. --db is how to keep them.
    const auditSinks: AuditSink[] = store ? [store.audit] : [];
    const keys: KeyStore = store?.keys ?? memoryKeyStore();

    let surface;
    try {
      surface = createMcpSurface({
        tools: conversion.tools,
        upstream: {
          baseUrl: upstream.href,
          getCredential: credential.getCredential,
          ...(config.deadlineMs === undefined ? {} : { deadlineMs: config.deadlineMs }),
          ...(config.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: config.attemptTimeoutMs }),
          ...(config.retry ? { retry: config.retry } : {}),
          ...(config.limits ? { limits: config.limits } : {}),
        ...(config.upstreamHeaders ? { headers: config.upstreamHeaders } : {}),
        },
        access: { keys, ...(config.jwt ? { jwt: config.jwt, fetch: io.fetch } : {}) },
        telemetry,
        audit: createAudit(telemetry, auditSinks),
        name: 'crumple-mcp',
        version: readVersion(),
        allowedOrigins: values['allowed-origin'] ?? [],
        // On loopback this finishes MCP's DNS rebinding rule. Elsewhere the right names aren't ours to guess.
        ...(isLoopback(host) || values['allowed-host']
          ? { allowedHosts: [...(isLoopback(host) ? LOCAL_HOSTNAMES : []), ...(values['allowed-host'] ?? [])] }
          : {}),
      });
    } catch (error) {
      // Such as a scope that grants * with writes, whose message already says what to do.
      throw failure((error as Error).message);
    }
    for (const warning of surface.warnings) io.stderr(`Warning: ${warning}`);

    // A database keeps the keys it has. With an issuer configured, tokens are how people sign in.
    const firstRun = (await keys.list()).length === 0;
    const makeKey = firstRun && !config.jwt;
    if (!makeKey && firstKeyWrites.length > 0) {
      io.stderr('Warning: --write only applies when the first key is made. To give another key a write, use keys create --write <tool>.');
    }

    try {
      server = await serveOnNode((request) => surface.fetch(request), { port, host });
    } catch (error) {
      throw explainListenError(error, port);
    }
    const endpoint = new URL('/mcp', server.url).href;

    io.stdout([
      `Crumple is serving ${conversion.tools.length === 1 ? '1 tool' : `${conversion.tools.length} tools`} from ${source}`,
      `  MCP endpoint   ${endpoint}`,
      `  Upstream       ${upstream.href}, ${credential.describe}`,
    ].join('\n'));
    if (!isLoopback(host)) {
      io.stderr('Warning: this is listening beyond this machine, and traffic and keys are unencrypted. Put a proxy with TLS in front. --allowed-host adds a Host check.');
    }

    if (makeKey) {
      const grants: Grant[] = [{ tool: '*' }, ...firstKeyWrites];
      const { key } = await createKey(keys, { label: 'first key', grants }, () => io.now());
      io.stdout([
        '',
        'Your API key, shown once:',
        `  ${key}`,
        '',
        firstKeyWrites.length === 0
          ? 'It can read, and it can\'t write. To allow a write tool, add --write <tool>.'
          : `It can read, and it can write with: ${writes.join(', ')}.`,
        store ? `It's saved in ${values.db ?? ''}, so later starts won't print a new one.` : 'It lasts until this process stops. To keep it, add --db ./crumple.db.',
        '',
        'Connect Claude Code:',
        `  claude mcp add --transport http crumple ${endpoint} --header "Authorization: Bearer ${key}"`,
      ].join('\n'));
    }

    await io.waitForStop();
    return 0;
  } finally {
    await server?.close();
    await otlp?.flush?.();
    store?.close();
  }
}
