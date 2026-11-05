import { arch, cpus, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import { createFaultApi, DEFAULT_CREDENTIAL, OPENAPI } from '../fault-api/index.js';
import { convertOpenApi, createAudit, createKey, createMcpSurface, createTelemetry, memoryAuditSink, memoryKeyStore, memorySink, plainCredential } from '../mcp-surface/index.js';
import { serveOnNode } from '../node.js';
import { countChecks, renderBadge, renderJson, renderMarkdown, renderTerminal, rollUpClaims, runChecks, SELF_CHECKS, type Environment, type ProveReport, type StartTarget, type Target, type TargetSetup } from '../prove/index.js';
import { parseFlags, readVersion, usage, type Io } from './io.js';
import { logSink } from './serve.js';

// prove can't import Crumple, by the capability map, so this is where the two meet: a real Crumple
// in front of a real fault-api, on real ports, built fresh for each check.

const GRANTS = {
  read: [{ tool: '*' }],
  write: [{ tool: '*' }, { tool: 'createPayment', writes: true }],
  other: [{ tool: 'getCustomer' }],
};

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
    tools: convertOpenApi(OPENAPI).tools,
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
  const checks = await runChecks(SELF_CHECKS, start);
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

export async function proveCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseFlags(args, {
    self: { type: 'boolean', default: false },
    out: { type: 'string' },
    name: { type: 'string', default: 'prove' },
  });

  if (!values.self) throw usage('Say what to check: prove --self for Crumple itself.');
  if (!/^[A-Za-z0-9_-]+$/.test(values.name)) throw usage('--name should be letters, digits, dashes and underscores, because it becomes file names.');

  const report = await runSelf(startCrumple, io);
  io.stdout(renderTerminal(report));
  if (values.out !== undefined) await writeReport(report, values.out, values.name, io);
  return countChecks(report.checks).failed > 0 ? 1 : 0;
}
