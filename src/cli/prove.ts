import { arch, cpus, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import { createFaultApi, DEFAULT_CREDENTIAL, OPENAPI } from '../fault-api/index.js';
import { convertOpenApi, createAudit, createKey, createMcpSurface, createTelemetry, memoryAuditSink, memoryKeyStore, memorySink, plainCredential } from '../mcp-surface/index.js';
import { serveOnNode } from '../node.js';
import { countChecks, createBudget, createHttpTransport, createStdioTransport, DEFAULT_MAX_REQUESTS, MAX_MAX_REQUESTS, MAX_PARALLEL, OUT_OF_REACH, proveServer, proverChecks, renderBadge, renderJson, renderMarkdown, renderTerminal, rollUpClaims, runChecks, SELF_CHECKS, type Environment, type NamedCall, type ProveReport, type StartTarget, type Target, type TargetSetup } from '../prove/index.js';
import { parseFlags, readVersion, usage, type Io } from './io.js';
import { logSink } from './serve.js';

// prove can't import Crumple, by the capability map, so this is where the two meet: a real Crumple
// in front of a real fault-api, on real ports, built fresh for each check.

const GRANTS = {
  read: [{ tool: '*' }],
  write: [{ tool: '*' }, { tool: 'createPayment', writes: true }],
  other: [{ tool: 'getCustomer' }],
};

const allClaimingToBeReadOnly = () =>
  convertOpenApi(OPENAPI).tools.map((tool) => ({ ...tool, annotations: { ...tool.annotations, readOnlyHint: true } }));

export const startCrumple: StartTarget = async (setup: TargetSetup): Promise<Target> => {
  const api = createFaultApi();
  const upstream = await serveOnNode((request) => api.fetch(request));

  const spans = memorySink();
  const audited = memoryAuditSink();
  const lines: string[] = [];
  const telemetry = createTelemetry({ sinks: [spans, logSink({ stderr: (line) => { lines.push(line); } })] });

  const keys = memoryKeyStore();
  const makeKey = async (label: keyof typeof GRANTS): Promise<string> => (await createKey(keys, { label, grants: GRANTS[label] })).key;
  const [read, write, other] = await Promise.all([makeKey('read'), makeKey('write'), makeKey('other')]);

  const surface = createMcpSurface({
    tools: setup.hintsLie ? allClaimingToBeReadOnly() : convertOpenApi(OPENAPI).tools,
    upstream: {
      baseUrl: upstream.url,
      getCredential: plainCredential('header', 'authorization', `Bearer ${DEFAULT_CREDENTIAL}`),
      ...(setup.fault ? { headers: { 'x-fault': setup.fault } } : {}),
      ...(setup.deadlineMs === undefined ? {} : { deadlineMs: setup.deadlineMs }),
      ...(setup.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: setup.attemptTimeoutMs }),
      ...(setup.retry ? { retry: setup.retry } : {}),
      ...(setup.breaker ? { breaker: setup.breaker } : {}),
      ...(setup.limits ? { limits: setup.limits } : {}),
    },
    access: { keys },
    telemetry,
    audit: createAudit(telemetry, [audited]),
  });
  const server = await serveOnNode((request) => surface.fetch(request));

  return {
    url: `${server.url}/mcp`,
    keys: { read, write, other },
    credential: DEFAULT_CREDENTIAL,
    upstream: {
      requests: () => api.requests(),
      effects: () => api.effects(),
    },
    observed: () => JSON.stringify([spans.spans(), audited.events(), lines]),
    denied: () => audited.events().filter((event) => event.decision === 'deny').map(({ tool, reason }) => ({ tool, ...(reason === undefined ? {} : { reason }) })),
    async stop() {
      await server.close();
      await upstream.close();
    },
  };
};

function environment(io: Io): Environment {
  const commit = io.env.CRUMPLE_PROVE_COMMIT;
  return {
    version: readVersion(),
    ...(commit ? { commit, dirty: io.env.CRUMPLE_PROVE_DIRTY === '1' } : {}),
    // Never the machine's name, because this ends up in a public repo.
    os: `${platform()} ${arch()}`,
    cpu: cpus()[0]?.model ?? 'unknown CPU',
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    node: process.versions.node,
  };
}

async function writeReport(report: ProveReport, folder: string, name: string, io: Io): Promise<void> {
  await io.writeFile(join(folder, `${name}.md`), renderMarkdown(report));
  await io.writeFile(join(folder, `${name}.json`), renderJson(report));
  await io.writeFile(join(folder, `${name}.svg`), renderBadge(countChecks(report.checks)));
  io.stdout(`  Report: ${join(folder, `${name}.md`)}, with .json and .svg beside it.`);
}

export async function runSelf(start: StartTarget, io: Io): Promise<ProveReport> {
  const startedAt = new Date(io.now()).toISOString();
  const began = performance.now();
  const checks = await runChecks([...SELF_CHECKS, ...proverChecks()], start);
  return {
    kind: 'self',
    target: 'self',
    startedAt,
    durationMs: Math.round(performance.now() - began),
    environment: environment(io),
    checks,
    claims: rollUpClaims(checks),
  };
}

const TOKEN_ENV = 'CRUMPLE_PROVE_TOKEN';
const DEFAULT_TIMEOUT_MS = 10_000;

const isLoopback = (hostname: string): boolean => hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname);

function wholeNumber(value: string | undefined, flag: string, fallback: number | undefined, max: number): number | undefined {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw usage(`${flag} should be a whole number from 1 to ${String(max)}, not ${value}.`);
  return number;
}

function parseCall(name: string | undefined, args: string | undefined, parallel: number | undefined): NamedCall | undefined {
  if (name === undefined) {
    if (args !== undefined) throw usage('--args goes with --call, which names the tool they\'re for.');
    if (parallel !== undefined) throw usage('--parallel goes with --call, which names the one tool that may be called.');
    return undefined;
  }
  let parsed: unknown = {};
  if (args !== undefined) {
    try {
      parsed = JSON.parse(args);
    } catch {
      throw usage('--args should be a JSON object, such as \'{"id":"1"}\'.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw usage('--args should be a JSON object, such as \'{"id":"1"}\'.');
  }
  return { name, args: parsed as Record<string, unknown>, ...(parallel === undefined ? {} : { parallel }) };
}

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usage(`That isn't a URL: use the full address, such as https://you.example/mcp. For a local process, put its command after --.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw usage('Only http and https addresses work here. For a local process, put its command after --.');
  return url;
}

async function runExternal(target: string, command: string[] | undefined, call: NamedCall | undefined, maxRequests: number, timeoutMs: number, io: Io): Promise<ProveReport> {
  const token = io.env[TOKEN_ENV] || undefined;
  const budget = createBudget(maxRequests);
  const startedAt = new Date(io.now()).toISOString();
  const began = performance.now();

  let transport;
  if (command) {
    transport = createStdioTransport({ command, timeoutMs, budget });
  } else {
    const url = parseUrl(target);
    // Anyone in between could read it. There's no reason to send one this way.
    if (token && url.protocol === 'http:' && !isLoopback(url.hostname)) throw usage(`${TOKEN_ENV} is set, and this address is plain http, where anyone in between could read it. Use https.`);
    transport = createHttpTransport({ url: url.href, timeoutMs, budget, fetch: io.fetch, ...(token ? { token } : {}) });
  }

  io.stdout(`Run this only on servers you own or may test. It sends at most ${String(maxRequests)} requests, and calls no tool you didn't name.\n`);
  const result = await proveServer({ transport, budget, hasToken: token !== undefined, ...(call ? { call } : {}) });
  return {
    kind: 'server',
    target,
    startedAt,
    durationMs: Math.round(performance.now() - began),
    environment: environment(io),
    checks: result.checks,
    requests: { used: budget.used(), max: maxRequests },
    notes: result.notes,
    outOfReach: OUT_OF_REACH,
    ...(result.protocol ? { protocol: result.protocol } : {}),
    ...(result.tools ? { tools: result.tools } : {}),
  };
}

export async function proveCommand(args: string[], io: Io): Promise<number> {
  // Everything after -- is a command to run, and none of it is for us.
  const separator = args.indexOf('--');
  const command = separator === -1 ? undefined : args.slice(separator + 1);
  const { values, positionals } = parseFlags(separator === -1 ? args : args.slice(0, separator), {
    self: { type: 'boolean', default: false },
    out: { type: 'string' },
    name: { type: 'string', default: 'prove' },
    call: { type: 'string' },
    args: { type: 'string' },
    parallel: { type: 'string' },
    'max-requests': { type: 'string' },
    'timeout-ms': { type: 'string' },
  });

  if (!/^[A-Za-z0-9_-]+$/.test(values.name)) throw usage('--name should be letters, digits, dashes and underscores, because it becomes file names.');
  const [target] = positionals;
  const chosen = [values.self, target !== undefined, command !== undefined].filter(Boolean).length;
  if (chosen === 0) throw usage('Say what to check: prove --self for Crumple, prove https://you.example/mcp for a server, or prove -- node server.js for a local one.');
  if (chosen > 1) throw usage('Choose one thing to check: --self, an address, or a command after --.');
  if (command?.length === 0) throw usage('Put the command to run after --, such as prove -- node server.js.');

  let report: ProveReport;
  if (values.self) {
    report = await runSelf(startCrumple, io);
  } else {
    const parallel = wholeNumber(values.parallel, '--parallel', undefined, MAX_PARALLEL);
    const maxRequests = wholeNumber(values['max-requests'], '--max-requests', DEFAULT_MAX_REQUESTS, MAX_MAX_REQUESTS) ?? DEFAULT_MAX_REQUESTS;
    const timeoutMs = wholeNumber(values['timeout-ms'], '--timeout-ms', DEFAULT_TIMEOUT_MS, 120_000) ?? DEFAULT_TIMEOUT_MS;
    report = await runExternal(target ?? 'a local process', command, parseCall(values.call, values.args, parallel), maxRequests, timeoutMs, io);
  }

  io.stdout(renderTerminal(report));
  if (values.out !== undefined) await writeReport(report, values.out, values.name, io);
  return countChecks(report.checks).failed > 0 ? 1 : 0;
}
