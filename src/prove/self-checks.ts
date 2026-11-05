import { MALICIOUS_TEXT } from '../fault-api/index.js';
import { callResult, createBudget, createHttpTransport, openSession, type Budget, type CallResult, type Session } from './client.js';
import { fail, pass, type Check, type CheckResult } from './checks.js';
import { DEFAULT_MAX_REQUESTS, proveServer, type ExternalResult } from './external.js';

// Crumple's claims, each with a failure caused on purpose. Each check starts its own server, so
// nothing is shared, and speaks MCP to it over a real socket like any other client would.
//
// prove can't import Crumple, by the capability map, so it asks for a Target. The real one is built
// in the CLI. A deliberately wrong one in the tests is how we know each of these can fail.

export interface TargetSetup {
  /** What fault-api should do: an x-fault value. */
  fault?: string;
  deadlineMs?: number;
  attemptTimeoutMs?: number;
  retry?: { attempts?: number; baseMs?: number; capMs?: number };
  breaker?: { windowSize?: number; minimumCalls?: number; failureRate?: number; openMs?: number };
  limits?: { perCaller?: number; perUpstream?: number; queuePerCaller?: number; queueUpstream?: number };
  /** List every tool as read-only, writes too, for C17: a hint must never give prove permission. */
  hintsLie?: boolean;
}

export interface UpstreamRequest {
  at: number;
  method: string;
  path: string;
  headers: Record<string, string>;
}

/** What only a server's owner can see. Against someone else's server there's none of this. */
export interface Target {
  url: string;
  keys: {
    /** Every read, and no write. */
    read: string;
    /** Every read, and createPayment. */
    write: string;
    /** getCustomer only. */
    other: string;
  };
  /** The upstream credential the server holds. */
  credential: string;
  upstream: {
    requests(): UpstreamRequest[];
    effects(): { kind: string; id: string }[];
  };
  /** Every span, audit event and log line so far, as text. */
  observed(): string;
  /** Who was refused what, from the audit log. */
  denied(): { tool: string; reason?: string }[];
  stop(): Promise<void>;
}

export type StartTarget = (setup: TargetSetup) => Promise<Target>;

const DEADLINE_MARGIN_MS = 500;
const CUSTOMER = { id: 'cus_1' };
const PAYMENT = { body: { customerId: 'cus_1', amountCents: 5000 } };
const NO_DELAY = { baseMs: 10, capMs: 20 };

async function withTarget<T>(start: StartTarget, setup: TargetSetup, run: (target: Target) => Promise<T>): Promise<T> {
  const target = await start(setup);
  try {
    return await run(target);
  } finally {
    await target.stop();
  }
}

/** The client's own limit, so a server with no deadline makes a check fail rather than wait for ever. */
async function connect(target: Target, key: string, timeoutMs = 10_000): Promise<Session> {
  const opened = await openSession(createHttpTransport({ url: target.url, token: key, timeoutMs, budget: createBudget() }));
  if (!opened.ok) throw new Error(`Couldn't connect: ${opened.reason}`);
  return opened.session;
}

const call = async (session: Session, name: string, args: Record<string, unknown>): Promise<CallResult> => callResult(await session.callTool(name, args));

interface StructuredError {
  code?: unknown;
  message?: unknown;
  retry?: unknown;
  idempotencyKey?: unknown;
}

/** A failure the agent can read, or undefined when there isn't one. */
function structured(result: CallResult): StructuredError | undefined {
  if (result.kind !== 'result' || !result.isError) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.text);
    return typeof parsed === 'object' && parsed !== null ? (parsed) : undefined;
  } catch {
    return undefined;
  }
}

const succeeded = (result: CallResult): boolean => result.kind === 'result' && !result.isError;
const refused = (result: CallResult): boolean => result.kind === 'protocol_error' || (result.kind === 'result' && result.isError);
const count = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;

const c1: Check<StartTarget> = {
  id: 'denied-by-default',
  title: 'No key, a wrong key and a key without the grant',
  claim: 'C1',
  run: (start) =>
    withTarget(start, {}, async (target): Promise<CheckResult> => {
      const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
      const anonymous = createHttpTransport({ url: target.url, timeoutMs: 5_000, budget: createBudget() });
      const protocol = { protocol: '2026-07-28' };
      const none = await anonymous.send(list, { ...protocol, token: null });
      const wrong = await anonymous.send(list, { ...protocol, token: 'crumple_this-key-is-made-up' });
      if (none.kind !== 'answered' || none.status !== 401) return fail('A request with no key wasn\'t refused with a 401.');
      if (wrong.kind !== 'answered' || wrong.status !== 401) return fail('A request with a made-up key wasn\'t refused with a 401.');

      const other = await connect(target, target.keys.other);
      const noGrant = await call(other, 'listCustomers', {});
      if (!refused(noGrant)) return fail('A key without the grant was allowed to call listCustomers.');

      const reached = target.upstream.requests().length;
      if (reached !== 0) return fail(`Calls were refused, and still ${count(reached, 'request')} reached the API.`, { upstream_requests: reached });

      // Without this, a server that was simply broken would pass.
      const read = await connect(target, target.keys.read);
      if (!succeeded(await call(read, 'listCustomers', {}))) return fail('A key with the grant couldn\'t make the same call, so this shows nothing.');
      return pass('All three refused, and the API received no requests. The same call with a good key went through.', { upstream_requests: reached });
    }),
};

const c2: Check<StartTarget> = {
  id: 'permission-holds',
  title: 'A record says to delete, and a read-only key tries it directly',
  claim: 'C2',
  run: (start) =>
    withTarget(start, { fault: 'inject' }, async (target) => {
      const read = await connect(target, target.keys.read);
      const record = await call(read, 'getCustomer', CUSTOMER);
      if (record.kind !== 'result' || !record.text.includes(MALICIOUS_TEXT)) return fail('The malicious text never came back, so this shows nothing.');

      const attempt = await call(read, 'deleteCustomer', CUSTOMER);
      const effects = target.upstream.effects();
      if (!refused(attempt) || effects.length > 0) return fail(`The delete went through, with ${count(effects.length, 'effect')} in the API.`, { effects: effects.length });
      if (!target.denied().some((event) => event.tool === 'deleteCustomer')) return fail('The delete was refused, but the audit log has no record of the attempt.');
      return pass('Refused, nothing deleted, and the audit log has the attempt.', { effects: 0 });
    }),
};

const c3: Check<StartTarget> = {
  id: 'token-stays-here',
  title: 'What reaches the API on a normal call',
  claim: 'C3',
  run: (start) =>
    withTarget(start, {}, async (target) => {
      const read = await connect(target, target.keys.read);
      await call(read, 'getCustomer', CUSTOMER);
      const requests = target.upstream.requests();
      if (requests.length === 0) return fail('Nothing reached the API, so this shows nothing.');
      if (JSON.stringify(requests).includes(target.keys.read)) return fail('The agent\'s key reached the API.');
      if (!requests.every((request) => request.headers.authorization === `Bearer ${target.credential}`)) return fail('The API didn\'t receive the stored credential, so this shows nothing.');
      return pass('The agent\'s key appears nowhere in what arrived, and the stored credential did arrive.', { upstream_requests: requests.length });
    }),
};

const c4: Check<StartTarget> = {
  id: 'credential-stays-hidden',
  title: 'The API repeats the credential back',
  claim: 'C4',
  run: (start) =>
    withTarget(start, { fault: 'echo-auth' }, async (target) => {
      const read = await connect(target, target.keys.read);
      const result = await call(read, 'getCustomer', CUSTOMER);
      if (result.kind !== 'result' || !result.text.includes('receivedAuthorization')) return fail('The API\'s echo never came back, so this shows nothing.');
      if (result.text.includes(target.credential)) return fail('The credential is in the tool\'s output.');
      if (target.observed().includes(target.credential)) return fail('The credential is in the spans, audit events or logs.');
      return pass('The API repeated it, and it\'s absent from the tool\'s output, spans, audit events and logs.');
    }),
};

const c5: Check<StartTarget> = {
  id: 'one-effect',
  title: 'A payment applies, then its response is lost',
  claim: 'C5',
  async run(start) {
    const recovered = await withTarget(start, { fault: 'drop;times=1', retry: { attempts: 3, ...NO_DELAY } }, async (target): Promise<CheckResult> => {
      const write = await connect(target, target.keys.write);
      const result = await call(write, 'createPayment', PAYMENT);
      const effects = target.upstream.effects().length;
      const requests = target.upstream.requests().length;
      if (effects === 0) return fail('No payment was ever applied, so this shows nothing.');
      if (effects !== 1) return fail(`One response was lost, and there are ${count(effects, 'effect')} in the API.`, { effects });
      if (requests < 2) return fail('It was never retried, so this shows nothing.');
      if (!succeeded(result)) return fail('The retry didn\'t recover a payment that had gone through.');
      return pass('', { attempts: requests, effects });
    });
    if (recovered.state !== 'pass') return recovered;

    return withTarget(start, { fault: 'drop;times=3', retry: { attempts: 3, ...NO_DELAY } }, async (target): Promise<CheckResult> => {
      const write = await connect(target, target.keys.write);
      const lost = structured(await call(write, 'createPayment', PAYMENT));
      const afterAll = target.upstream.effects().length;
      if (afterAll === 0) return fail('No payment was ever applied, so this shows nothing.');
      if (afterAll !== 1) return fail(`Every response was lost, and there are ${count(afterAll, 'effect')} in the API.`, { effects: afterAll });
      if (lost?.retry !== 'same_key' || typeof lost.idempotencyKey !== 'string') return fail('Every response was lost, and the error didn\'t give a key to retry with.');

      const again = await call(write, 'createPayment', { ...PAYMENT, idempotencyKey: lost.idempotencyKey });
      const effects = target.upstream.effects().length;
      if (!succeeded(again) || effects !== 1) return fail(`Retrying with the key left ${count(effects, 'effect')} in the API.`, { effects });
      return pass('One effect when a retry recovered it, and one when every response was lost and the caller retried with the key it was given.', { effects });
    });
  },
};

async function deadlineHolds(start: StartTarget, fault: string): Promise<CheckResult> {
  const deadlineMs = 800;
  // An attempt's own timeout is far longer, so what has to stop this is the deadline itself.
  return withTarget(start, { fault, deadlineMs, attemptTimeoutMs: 30_000, retry: { attempts: 2, ...NO_DELAY } }, async (target) => {
    // Over the limit, but not by much: a server with no deadline fails here instead of hanging the run.
    const read = await connect(target, target.keys.read, deadlineMs + DEADLINE_MARGIN_MS + 500);
    const started = performance.now();
    const result = await call(read, 'getCustomer', CUSTOMER);
    const ms = Math.round(performance.now() - started);
    const error = structured(result);
    if (result.kind === 'no_answer') return fail(`With ${fault}, no answer came within ${String(ms)} ms.`, { ms, deadline_ms: deadlineMs });
    if (!error) return fail(`With ${fault}, the caller didn't get a structured error.`, { ms });
    if (ms > deadlineMs + DEADLINE_MARGIN_MS) return fail(`With ${fault}, the answer took ${String(ms)} ms, past the ${String(deadlineMs)} ms deadline and its ${String(DEADLINE_MARGIN_MS)} ms margin.`, { ms, deadline_ms: deadlineMs });
    return pass(`${fault} ${String(ms)} ms`, { ms, deadline_ms: deadlineMs });
  });
}

const c6: Check<StartTarget> = {
  id: 'deadline-holds',
  title: 'The API hangs, before and partway through its answer',
  claim: 'C6',
  async run(start) {
    const hang = await deadlineHolds(start, 'hang');
    if (hang.state !== 'pass') return hang;
    const stall = await deadlineHolds(start, 'stall-body');
    if (stall.state !== 'pass') return stall;
    return pass(`A structured error within the 800 ms deadline plus a 500 ms margin. Measured: ${hang.detail}, ${stall.detail}.`, {
      hang_ms: hang.measured?.ms ?? 0,
      stall_body_ms: stall.measured?.ms ?? 0,
      deadline_ms: 800,
    });
  },
};

const c7: Check<StartTarget> = {
  id: 'right-retries',
  title: 'A 400, a 503, and a 503 with Retry-After',
  claim: 'C7',
  async run(start) {
    const attempts = 3;
    const retry = { attempts, ...NO_DELAY };

    const rejected = await withTarget(start, { fault: 'status=400', retry }, async (target) => {
      await call(await connect(target, target.keys.read), 'getCustomer', CUSTOMER);
      return target.upstream.requests().length;
    });
    if (rejected !== 1) return fail(`A 400 got ${count(rejected, 'attempt')}, and it should get one.`, { attempts_after_400: rejected });

    const unavailable = await withTarget(start, { fault: 'status=503', retry }, async (target) => {
      await call(await connect(target, target.keys.read), 'getCustomer', CUSTOMER);
      return target.upstream.requests().length;
    });
    if (unavailable !== attempts) return fail(`A 503 got ${count(unavailable, 'attempt')}, and ${String(attempts)} were configured.`, { attempts_after_503: unavailable });

    return withTarget(start, { fault: 'status=503;retry-after=1;times=1', retry, deadlineMs: 5_000 }, async (target) => {
      const result = await call(await connect(target, target.keys.read), 'getCustomer', CUSTOMER);
      const [first, second] = target.upstream.requests();
      const waitedMs = first && second ? second.at - first.at : 0;
      if (!second) return fail('A 503 with Retry-After was never retried.');
      if (waitedMs < 1000) return fail(`Retry-After asked for 1 s, and it waited ${String(waitedMs)} ms.`, { waited_ms: waitedMs });
      if (!succeeded(result)) return fail('The API recovered, and the call still failed.');
      return pass(`A 400 got 1 attempt, a 503 got ${String(attempts)}, and Retry-After: 1 was honoured, waiting ${String(waitedMs)} ms.`, {
        attempts_after_400: rejected,
        attempts_after_503: unavailable,
        waited_ms: waitedMs,
      });
    });
  },
};

const c8: Check<StartTarget> = {
  id: 'breaker-opens',
  title: 'The API keeps failing, then recovers',
  claim: 'C8',
  run(start) {
    const failures = 3;
    const openMs = 400;
    return withTarget(start, {
      fault: `status=503;times=${String(failures)}`,
      retry: { attempts: 1 },
      breaker: { windowSize: 4, minimumCalls: failures, failureRate: 0.5, openMs },
    }, async (target) => {
      const read = await connect(target, target.keys.read);
      for (let i = 0; i < failures; i += 1) await call(read, 'getCustomer', CUSTOMER);
      const reachedBefore = target.upstream.requests().length;

      const whileOpen = await call(read, 'getCustomer', CUSTOMER);
      const reachedAfter = target.upstream.requests().length;
      if (reachedAfter !== reachedBefore) return fail('After sustained failure, the next call still reached the API.', { upstream_requests: reachedAfter });
      if (structured(whileOpen)?.code !== 'circuit_open') return fail('The next call failed fast, without saying the circuit was open.');

      await new Promise((resolve) => setTimeout(resolve, openMs + 100));
      const recovered = await call(read, 'getCustomer', CUSTOMER);
      if (!succeeded(recovered)) return fail('The API recovered, and calls didn\'t start working again by themselves.');
      return pass(`After ${count(failures, 'failure')}, a call failed fast with no request reaching the API, and calls worked again by themselves after ${String(openMs)} ms.`, { upstream_requests_while_open: reachedAfter - reachedBefore });
    });
  },
};

const c9: Check<StartTarget> = {
  id: 'noisy-caller',
  title: 'One caller floods a slow API, while another keeps working',
  claim: 'C9',
  run: (start) =>
    withTarget(start, {
      fault: 'delay=200',
      deadlineMs: 5_000,
      limits: { perCaller: 2, queuePerCaller: 1, perUpstream: 6, queueUpstream: 1 },
    }, async (target) => {
      const noisy = await connect(target, target.keys.read);
      const quiet = await connect(target, target.keys.other);
      const floodSize = 20;
      const flood = Array.from({ length: floodSize }, () => call(noisy, 'listCustomers', {}));

      const quietResults: CallResult[] = [];
      for (let i = 0; i < 3; i += 1) quietResults.push(await call(quiet, 'getCustomer', CUSTOMER));
      const floodResults = await Promise.all(flood);

      const refusedCalls = floodResults.filter((result) => structured(result)?.code === 'overloaded').length;
      const answered = floodResults.filter(succeeded).length;
      const quietOk = quietResults.filter(succeeded).length;
      const measured = { flood: floodSize, flood_succeeded: answered, flood_refused: refusedCalls, other_succeeded: quietOk, other_slowest_ms: Math.round(Math.max(...quietResults.map((result) => result.ms))) };

      if (quietOk !== quietResults.length) return fail(`During the flood, the other caller got ${String(quietOk)} of ${String(quietResults.length)} calls through.`, measured);
      if (refusedCalls === 0) return fail('Nothing was refused, so the excess was let through or queued without limit.', measured);
      if (answered + refusedCalls !== floodSize) return fail('Some of the flood got neither an answer nor a clear refusal.', measured);
      return pass(`Of ${String(floodSize)} flooding calls, ${String(answered)} went through and ${String(refusedCalls)} were refused with overloaded. The other caller got all ${String(quietOk)} through.`, measured);
    }),
};

const RETRY_ADVICE = new Set(['no', 'later', 'same_key', 'check_first']);

const c10: Check<StartTarget> = {
  id: 'errors-say-what-next',
  title: 'Each kind of failure, read as an agent would',
  claim: 'C10',
  async run(start) {
    const faults = ['status=400', 'status=503', 'status=429', 'not-json', 'hang'];
    const codes: string[] = [];
    for (const fault of faults) {
      const problem = await withTarget(start, { fault, retry: { attempts: 1 }, deadlineMs: 300 }, async (target) => {
        const error = structured(await call(await connect(target, target.keys.read, 1_500), 'getCustomer', CUSTOMER));
        if (typeof error?.code !== 'string' || typeof error.message !== 'string' || typeof error.retry !== 'string' || !RETRY_ADVICE.has(error.retry)) return `With ${fault}, the error doesn't say whether retrying can help.`;
        codes.push(`${error.code} (${error.retry})`);
        return undefined;
      });
      if (problem) return fail(problem);
    }
    return pass(`Each error has a code, a message and advice on retrying: ${codes.join(', ')}.`);
  },
};

export const SELF_CHECKS: readonly Check<StartTarget>[] = [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10];

/** How to run the outside checks. Only a test passes anything else, to show these can fail. */
export type Prover = (url: string, key: string, budget: Budget) => Promise<ExternalResult>;

const realProver: Prover = (url, key, budget) =>
  proveServer({ transport: createHttpTransport({ url, token: key, timeoutMs: 5_000, budget }), budget, hasToken: true });

export function proverChecks(prover: Prover = realProver): readonly Check<StartTarget>[] {
  return [
    {
      id: 'prove-is-safe',
      title: 'prove on a server whose tools all claim to be read-only, writes included',
      claim: 'C17',
      run: (start) =>
        withTarget(start, { hintsLie: true }, async (target) => {
          const budget = createBudget(DEFAULT_MAX_REQUESTS);
          const { tools } = await prover(target.url, target.keys.write, budget);
          const reached = target.upstream.requests().length;
          const measured = { requests: budget.used(), budget: DEFAULT_MAX_REQUESTS, upstream_requests: reached };
          if (!tools?.count) return fail('It found no tools, so this shows nothing.', measured);
          if (reached > 0) return fail(`It reached the API ${count(reached, 'time')}, so it called a real tool nobody named.`, measured);
          if (budget.used() > DEFAULT_MAX_REQUESTS) return fail('It went over its request budget.', measured);
          return pass(`${String(tools.count)} tools claimed to be read-only, and none was called: the API received nothing. ${String(budget.used())} of ${String(DEFAULT_MAX_REQUESTS)} requests used.`, measured);
        }),
    },
    {
      id: 'tool-cost-shown',
      title: 'What the tool definitions cost',
      claim: 'C18',
      run: (start) =>
        withTarget(start, {}, async (target) => {
          const { tools } = await prover(target.url, target.keys.write, createBudget(DEFAULT_MAX_REQUESTS));
          if (!tools?.totalTokens || tools.perTool.length !== tools.count) return fail('It gave no estimate for each tool.');
          return pass(`About ${String(tools.totalTokens)} tokens per turn across ${String(tools.count)} tools, as an estimate.`, { estimated_tokens: tools.totalTokens, tools: tools.count });
        }),
    },
  ];
}
