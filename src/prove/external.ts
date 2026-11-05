import { callResult, type Budget, type CallResult, type HttpTransport, type ListedTool, type OpenResult, type Session, type Transport, type WireReply, openSession } from '../mcp-client/client.js';
import { fail, notRun, pass, runChecks, type Check, type CheckOutcome, type CheckResult } from './checks.js';
import { definitionProblems, summariseTools } from './definitions.js';
import { safeName, type ToolSummary } from './report.js';

// What can be learned about someone's server from outside, gently.
//
// The rule that shapes all of this: a hint can stop prove, and it can never give it permission.
// readOnlyHint comes from the server being tested, and MCP's spec says not to trust it. So no real
// tool gets called unless the person running this typed its name. Bad arguments aren't safe either,
// because a server that doesn't validate may run the tool anyway.

export const DEFAULT_MAX_REQUESTS = 30;
export const MAX_MAX_REQUESTS = 500;
export const MAX_PARALLEL = 50;
export const MAX_PAGES = 10;
const STDIO_PROBE_MS = 3_000;

/** Listed on every report, because a clean report shouldn't suggest these were looked at. */
export const OUT_OF_REACH = [
  { claim: 'C3', text: 'Does the agent\'s token reach your API? prove can\'t see what arrives behind your server.' },
  { claim: 'C4', text: 'Does a stored credential leak? prove can\'t make your API repeat it, or read your logs.' },
  { claim: 'C5', text: 'Are writes applied twice? That needs a response to be lost on purpose, and a count of what your API really did.' },
  { claim: 'C6', text: 'Do deadlines hold? That needs your API to hang on purpose.' },
  { claim: 'C7', text: 'Which failures get retried? That needs your API to fail on purpose.' },
  { claim: 'C8', text: 'Does it stop hitting a failing API? That needs your API to keep failing on purpose.' },
  { claim: 'C9', text: 'Can one caller starve another? That needs a slow API and two callers. --parallel only shows a small burst from one.' },
];

export interface NamedCall {
  name: string;
  args: Record<string, unknown>;
  parallel?: number;
}

export interface ExternalOptions {
  transport: Transport;
  budget: Budget;
  /** Whether a token was given. The token itself stays in the transport. */
  hasToken: boolean;
  call?: NamedCall;
  random?: () => string;
}

export interface ExternalResult {
  checks: CheckOutcome[];
  protocol?: string;
  tools?: ToolSummary;
  notes: string[];
}

interface Context extends ExternalOptions {
  session: Session;
  tools: ListedTool[];
  named: ListedTool | undefined;
  random: () => string;
}

const OUT_OF_BUDGET = 'The request budget ran out first. Raise it with --max-requests.';
const CHECK_IDS = ['speaks-mcp', 'tool-definitions', 'refuses-no-token', 'refuses-bad-token', 'refuses-foreign-origin', 'unknown-tool', 'malformed-request', 'named-tool', 'bad-arguments', 'parallel'] as const;

const TITLES: Record<(typeof CHECK_IDS)[number], string> = {
  'speaks-mcp': 'Lists its tools over MCP',
  'tool-definitions': 'Tool names, descriptions and schemas',
  'refuses-no-token': 'A request with no token',
  'refuses-bad-token': 'A request with a made-up token',
  'refuses-foreign-origin': 'A request from a website it doesn\'t know',
  'unknown-tool': 'A call to a tool that can\'t exist',
  'malformed-request': 'A body that isn\'t JSON',
  'named-tool': 'The tool you named',
  'bad-arguments': 'The tool you named, with a required argument missing',
  parallel: 'The tool you named, several at once',
};

/** What a reply that never arrived means, in our words. Nothing a server said goes in here. */
function noAnswer(reply: Exclude<WireReply, { kind: 'answered' }>, doing: string): CheckResult {
  switch (reply.kind) {
    case 'budget': return notRun(OUT_OF_BUDGET);
    case 'redirected': return fail(`${doing}, it answered with a ${String(reply.status)} redirect, which wasn't followed.`);
    case 'timeout': return fail(`${doing}, no answer came in time.`);
    case 'too_large': return fail(`${doing}, the answer was too large, and reading stopped.`);
    case 'broken': return fail(`${doing}, the answer couldn't be read.`);
    case 'unreachable': return fail(`${doing}, the connection failed.`);
  }
}

const httpOnly = (context: Context): HttpTransport | undefined => (context.transport.kind === 'http' ? (context.transport as HttpTransport) : undefined);
const NOT_HTTP = 'This only applies to a server reached over HTTP.';

function tokenCheck(context: Context, doing: string, token: string | null, words: string): Promise<CheckResult> {
  return (async () => {
    const reply = await context.session.request('tools/list', {}, { token });
    if (reply.kind !== 'answered') return noAnswer(reply, doing);
    if (reply.status === 401) return pass(`Refused with a 401${reply.headers.has('www-authenticate') ? ', saying how to sign in' : ''}.`);
    return fail(`${words} it answered ${String(reply.status)}, and it should be a 401.`);
  })();
}

const checks: Record<(typeof CHECK_IDS)[number], (context: Context) => Promise<CheckResult>> = {
  'speaks-mcp': ({ session, tools }) => Promise.resolve(pass(`Protocol ${session.protocol}, with ${tools.length === 1 ? '1 tool' : `${String(tools.length)} tools`}.`, { tools: tools.length })),

  'tool-definitions': ({ tools }) => {
    if (tools.length === 0) return Promise.resolve(notRun('It lists no tools.'));
    const problems = definitionProblems(tools);
    return Promise.resolve(problems.length === 0 ? pass('Names are valid and unique, and each tool has a description and an object schema.') : fail(problems.join(' ')));
  },

  'refuses-no-token': (context) => {
    if (!httpOnly(context)) return Promise.resolve(notRun(NOT_HTTP));
    if (!context.hasToken) return Promise.resolve(notRun('No token was given, so there\'s nothing to compare with. Set CRUMPLE_PROVE_TOKEN if this server should need one.'));
    return tokenCheck(context, 'With no token', null, 'With no token,');
  },

  'refuses-bad-token': (context) => {
    if (!httpOnly(context)) return Promise.resolve(notRun(NOT_HTTP));
    if (!context.hasToken) return Promise.resolve(notRun('No token was given, so there\'s nothing to compare with. Set CRUMPLE_PROVE_TOKEN if this server should need one.'));
    return tokenCheck(context, 'With a made-up token', `crumple-prove-${context.random()}`, 'With a made-up token,');
  },

  async 'refuses-foreign-origin'(context) {
    if (!httpOnly(context)) return notRun(NOT_HTTP);
    const reply = await context.session.request('tools/list', {}, { headers: { origin: 'https://prove.invalid' } });
    if (reply.kind !== 'answered') return noAnswer(reply, 'From an unknown website');
    return reply.status === 403
      ? pass('Refused with a 403.')
      : fail(`It answered ${String(reply.status)}, and MCP's spec requires a 403, to stop a website reaching a server through someone's browser.`);
  },

  async 'unknown-tool'({ session, random }) {
    // Random on each run, so it can't be the name of something real.
    const reply = await session.callTool(`crumple_prove_no_such_tool_${random()}`, {});
    const result = callResult(reply);
    if (reply.kind !== 'answered') return noAnswer(reply, 'Calling a made-up tool');
    if (result.kind === 'protocol_error' || (result.kind === 'result' && result.isError)) return pass('It said so clearly.');
    if (result.kind === 'result') return fail('A tool that can\'t exist answered as if it did.');
    return reply.status >= 500 ? fail(`A tool that can't exist caused a ${String(reply.status)}.`) : pass(`Refused with a ${String(reply.status)}.`);
  },

  async 'malformed-request'(context) {
    const http = httpOnly(context);
    if (!http) return notRun(NOT_HTTP);
    const reply = await http.sendRaw('{this is not json', context.session.sendOptions);
    if (reply.kind !== 'answered') return noAnswer(reply, 'With a body that isn\'t JSON');
    if (reply.status >= 500) return fail(`A body that isn't JSON caused a ${String(reply.status)}.`);
    return reply.status >= 400 || reply.message?.error ? pass('Refused clearly.') : fail(`A body that isn't JSON got a ${String(reply.status)}, with no error.`);
  },

  async 'named-tool'({ call, named, session }) {
    if (!call) return notRun('No tool was named, so no tool was called. Name one with --call and --args.');
    const unusable = whyNotCallable(call, named);
    if (unusable) return notRun(unusable);
    const reply = await session.callTool(call.name, call.args);
    if (reply.kind !== 'answered') return noAnswer(reply, `Calling ${safeName(call.name)}`);
    const result = callResult(reply);
    const ms = Math.round(reply.ms);
    if (result.kind === 'result') return pass(result.isError ? `It answered with a tool error, in ${String(ms)} ms.` : `It answered in ${String(ms)} ms.`, { ms });
    return fail(result.kind === 'protocol_error' ? `It answered with a protocol error, in ${String(ms)} ms. Check --args.` : `It answered ${String(reply.status)}, in ${String(ms)} ms.`, { ms });
  },

  async 'bad-arguments'({ call, named, session }) {
    if (!call) return notRun('No tool was named.');
    const unusable = whyNotCallable(call, named);
    if (unusable) return notRun(unusable);
    const required = (named?.inputSchema as { required?: unknown } | undefined)?.required;
    const first = Array.isArray(required) ? required.find((item): item is string => typeof item === 'string') : undefined;
    if (first === undefined) return notRun(`${safeName(call.name)} has no required argument.`);

    const args = Object.fromEntries(Object.entries(call.args).filter(([key]) => key !== first));
    const reply = await session.callTool(call.name, args);
    if (reply.kind !== 'answered') return noAnswer(reply, 'With a required argument missing');
    const result = callResult(reply);
    if (result.kind === 'protocol_error' || (result.kind === 'result' && result.isError)) return pass('It refused them, and MCP says servers must validate inputs.');
    if (result.kind === 'result') return fail('With a required argument missing, it ran anyway. MCP says servers must validate inputs.');
    return reply.status >= 500 ? fail(`A missing argument caused a ${String(reply.status)}.`) : pass(`Refused with a ${String(reply.status)}.`);
  },

  async parallel({ call, named, session, budget }) {
    if (call?.parallel === undefined) return notRun('--parallel wasn\'t asked for.');
    const unusable = whyNotCallable(call, named);
    if (unusable) return notRun(unusable);
    // The hint can only stop this. Without it, a burst could be a burst of writes.
    if (named?.annotations?.readOnlyHint !== true) return notRun(`Refused: ${safeName(call.name)} doesn't say readOnlyHint is true, so it was only called once.`);

    const left = budget.max - budget.used();
    if (call.parallel > left) return notRun(`It needs ${String(call.parallel)} requests, and ${String(left)} are left. Raise it with --max-requests.`);

    const results = await Promise.all(Array.from({ length: call.parallel }, () => session.callTool(call.name, call.args).then(callResult)));
    return judgeParallel(results);
  },
};

function whyNotCallable(call: NamedCall, named: ListedTool | undefined): string | undefined {
  if (!named) return `${safeName(call.name)} isn't in the list of tools, so it wasn't called.`;
  // MCP asks clients to copy these into headers. This client doesn't, so the server would refuse it.
  if (JSON.stringify(named.inputSchema ?? {}).includes('x-mcp-header')) return `${safeName(call.name)} uses x-mcp-header, which prove doesn't support yet, so it wasn't called.`;
  return undefined;
}

const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0);
};

function judgeParallel(results: readonly CallResult[]): CheckResult {
  // A clear refusal is exactly what a server under pressure should do, so it isn't a failure.
  const refused = results.filter((result) => result.kind === 'http_error' && result.status === 429).length;
  const answered = results.filter((result) => result.kind === 'result' || result.kind === 'protocol_error');
  const toolErrors = results.filter((result) => result.kind === 'result' && result.isError).length;
  const failed = results.length - refused - answered.length;
  const times = answered.map((result) => result.ms).sort((a, b) => a - b);
  const measured = { calls: results.length, answered: answered.length, tool_errors: toolErrors, refused, failed, p50_ms: percentile(times, 0.5), p95_ms: percentile(times, 0.95) };
  const counts = `${String(results.length)} at once: ${String(answered.length)} answered (p50 ${String(measured.p50_ms)} ms, p95 ${String(measured.p95_ms)} ms), ${String(toolErrors)} of them tool errors, ${String(refused)} refused, ${String(failed)} failed.`;
  return failed > 0 ? fail(`${counts} A 5xx, a hang or a broken answer counts as failed.`, measured) : pass(counts, measured);
}

function list(check: (typeof CHECK_IDS)[number], run: (context: Context) => Promise<CheckResult>): Check<Context> {
  return { id: check, title: TITLES[check], run };
}

function skipped(reason: string, except: Partial<Record<(typeof CHECK_IDS)[number], CheckResult>> = {}): CheckOutcome[] {
  return CHECK_IDS.map((id) => ({ id, title: TITLES[id], ...(except[id] ?? notRun(reason)) }));
}

function whenItWontOpen(opened: Extract<OpenResult, { ok: false }>, hasToken: boolean): CheckOutcome[] {
  const because = 'It couldn\'t be reached over MCP, so nothing else was tried.';
  switch (opened.reason) {
    case 'auth_required': {
      const refused = `It answered ${String(opened.status)}.`;
      if (hasToken) return skipped('The token was refused, so nothing else could be tried.', { 'speaks-mcp': fail(`${refused} The token you gave was refused.`) });
      return skipped('It needs a token. Set CRUMPLE_PROVE_TOKEN to check the rest.', {
        'speaks-mcp': notRun(`${refused} It needs a token. Set CRUMPLE_PROVE_TOKEN to check the rest.`),
        ...(opened.status === 401 ? { 'refuses-no-token': pass(`Refused with a 401${opened.challenge ? ', saying how to sign in' : ''}.`) } : {}),
      });
    }
    case 'budget': return skipped(OUT_OF_BUDGET);
    case 'redirected': return skipped(because, { 'speaks-mcp': fail(`It answered with a ${String(opened.status)} redirect, which wasn't followed. Use the final address.`) });
    case 'timeout': return skipped(because, { 'speaks-mcp': fail('No answer came in time.') });
    case 'unreachable': return skipped(because, { 'speaks-mcp': fail('The connection failed. Check the address, and that it\'s running.') });
    case 'too_large': return skipped(because, { 'speaks-mcp': fail('The answer was too large, and reading stopped.') });
    case 'broken': return skipped(because, { 'speaks-mcp': fail('The answer couldn\'t be read.') });
    case 'not_mcp': return skipped(because, { 'speaks-mcp': fail(`It doesn't answer as an MCP server${opened.status === undefined ? '' : ` (${String(opened.status)})`}. Check the address, which usually ends in /mcp. The old HTTP+SSE transport isn't supported.`) });
  }
}

export async function proveServer(options: ExternalOptions): Promise<ExternalResult> {
  const { transport, hasToken, call, random = () => crypto.randomUUID().replaceAll('-', '') } = options;

  // An older stdio server may say nothing at all to a request before initialize. It's still running,
  // so this only needs to be long enough to get an answer from one that would give one.
  const opened = await openSession(transport, transport.kind === 'stdio' ? { probeTimeoutMs: STDIO_PROBE_MS } : {});
  if (!opened.ok) return { checks: whenItWontOpen(opened, hasToken), notes: [] };

  const { session } = opened;
  try {
    const { tools, incomplete } = await session.listTools(MAX_PAGES);
    const context: Context = { ...options, random, session, tools, named: call ? tools.find((tool) => tool.name === call.name) : undefined };

    const notes: string[] = [];
    if (incomplete) notes.push('The list of tools didn\'t finish, within the page limit or the budget, so totals are a lower bound.');
    if (!hasToken && transport.kind === 'http') notes.push('This answered with no credential. That\'s fine if it\'s meant to be public.');

    const outcomes = await runChecks(CHECK_IDS.map((id) => list(id, checks[id])), context);
    return { checks: outcomes, protocol: session.protocol, tools: summariseTools(tools, incomplete), notes };
  } finally {
    await session.close();
  }
}
