import { callResult, countChecks, createBudget, createHttpTransport, openSession, renderCheckRows, renderCounts, type CallResult, type ClaimOutcome, type StartTarget, type TargetSetup } from '../prove/index.js';
import { parseFlags, usage, type Io } from './io.js';
import { runSelf, startCrumple } from './prove.js';
import { wrongServer } from './wrong-server.js';

// The first 60 seconds. Everything on the screen is measured on this run, including the losing side
// of the comparison: if the plain retry loop stopped charging twice, this would say so and fail.

const PAYMENT = { body: { customerId: 'cus_1', amountCents: 5000 } };
const LOST_ONCE: TargetSetup = { fault: 'drop;times=1', retry: { attempts: 3, baseMs: 10, capMs: 20 } };
const ISSUES = 'https://github.com/jorgeortega/crumple/issues';

interface PaymentRun {
  told: string;
  charges: number;
  trace: string;
}

const NO_TRACE = '';

function toldAs(result: CallResult): string {
  if (result.kind !== 'result') return 'no answer';
  return result.isError ? 'an error' : 'succeeded';
}

/** One payment, with its response lost once, through whichever server this is. */
async function payOnce(start: StartTarget): Promise<PaymentRun> {
  const target = await start(LOST_ONCE);
  try {
    const opened = await openSession(createHttpTransport({ url: target.url, token: target.keys.write, timeoutMs: 10_000, budget: createBudget() }));
    if (!opened.ok) throw new Error(`Couldn't connect to the demo's own server: ${opened.reason}`);
    const result = callResult(await opened.session.callTool('createPayment', PAYMENT));
    return { told: toldAs(result), charges: target.upstream.effects().length, trace: target.trace?.() ?? NO_TRACE };
  } finally {
    await target.stop();
  }
}

function comparison(plain: PaymentRun, crumple: PaymentRun): string[] {
  const rows = [
    ['', 'Agent is told', 'Charges'],
    ['Plain retry loop', plain.told, String(plain.charges)],
    ['Crumple', crumple.told, String(crumple.charges)],
  ];
  return rows.map(([name = '', told = '', charges = '']) => `  ${name.padEnd(18)} ${told.padEnd(15)} ${charges}`.trimEnd());
}

function claimsLine(claims: readonly ClaimOutcome[]): string {
  const howMany = (state: ClaimOutcome['state']): number => claims.filter((claim) => claim.state === state).length;
  const [partly, unchecked] = [howMany('partly'), howMany('not_run')];
  const partial = partly === 0 ? '' : `, ${String(partly)} ${partly === 1 ? 'was' : 'were'} partly checked`;
  return `Of ${String(claims.length)} claims, ${String(howMany('pass'))} passed${partial} and ${String(unchecked)} ${unchecked === 1 ? 'wasn\'t' : 'weren\'t'} checked by this run.`;
}

export interface DemoServers {
  plain: StartTarget;
  crumple: StartTarget;
}

export async function runDemo(servers: DemoServers, io: Io): Promise<number> {
  io.stdout('crumple-mcp demo: we break an API on purpose, and count what happened.');
  io.stdout('No key, no account, and nothing leaves this machine.\n');
  io.stdout('A payment goes through, then its response is lost.\n');

  const plain = await payOnce(servers.plain);
  const crumple = await payOnce(servers.crumple);
  io.stdout(comparison(plain, crumple).join('\n'));
  io.stdout('\n  The plain retry loop is a server we wrote to make this mistake: it retries a write with');
  io.stdout('  no idempotency key, so the API can\'t tell it\'s the same payment. It isn\'t any real project.');

  const charged = (n: number): string => `${String(n)} ${n === 1 ? 'time' : 'times'}`;
  const problems: string[] = [];
  if (crumple.charges !== 1) problems.push(`Crumple charged ${charged(crumple.charges)}, and it should charge once.`);
  if (plain.charges < 2) problems.push(`The plain retry loop charged ${charged(plain.charges)}, so this comparison shows nothing.`);
  for (const problem of problems) io.stdout(`\n  ${problem}`);

  if (crumple.trace) {
    io.stdout('\nCrumple\'s own trace of that call:\n');
    io.stdout(crumple.trace.split('\n').map((line) => `  ${line}`).join('\n'));
  }

  io.stdout('\nAll the checks, against Crumple:\n');
  const report = await runSelf(servers.crumple, io);
  const counts = countChecks(report.checks);
  io.stdout(renderCheckRows(report.checks).map((line) => `  ${line}`).join('\n'));
  io.stdout(`\n  ${renderCounts(counts)}. ${(report.durationMs / 1000).toFixed(1)} s.`);
  io.stdout(`  ${claimsLine(report.claims ?? [])} prove --self --out <folder> writes which, and why.`);
  io.stdout('  This ran on one machine, with failures we caused. It says nothing about production load.');

  if (counts.failed > 0) {
    io.stdout(`\n  Some checks measure time, so a very busy machine can miss one. Run it again, and if it still`);
    io.stdout(`  fails, please open an issue: ${ISSUES}`);
  }

  io.stdout('\nTo go further:\n');
  io.stdout('  Put it in front of your API   npx crumple-mcp serve ./openapi.yaml');
  io.stdout('  Check a server you own        npx crumple-mcp prove https://you.example/mcp');

  return problems.length > 0 || counts.failed > 0 ? 1 : 0;
}

export async function demoCommand(args: string[], io: Io): Promise<number> {
  const { positionals } = parseFlags(args, {});
  if (positionals.length > 0) throw usage('demo takes no arguments. Run crumple-mcp demo.');
  return runDemo({ plain: wrongServer, crumple: startCrumple }, io);
}
