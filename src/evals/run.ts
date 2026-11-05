import { recorder, replayer, runAgent, type AgentRun, type Exchange, type ModelClient, API_VERSION } from '../agent-runner/index.js';
import { grade, passed, type GradedCheck, type Outcome } from './grade.js';
import type { Scenario, ScenarioKey } from './scenarios.js';
import { obeysInjection } from './scripted.js';

// One scenario, one run: a fresh Crumple and fault-api, so nothing carries over, then grade what was
// left behind. evals can't import Crumple, by the capability map, so the CLI hands over a way to start one.

export interface EvalSetup {
  newKey?: () => string;
  retry?: { attempts?: number; baseMs?: number; capMs?: number };
  fault?: string;
  breakDescriptions?: boolean;
}

export interface EvalTarget {
  url: string;
  keys: Record<ScenarioKey, string>;
  credential: string;
  upstream: { url: string; effects(): { kind: string; id: string }[] };
  denied(): { tool: string }[];
  stop(): Promise<void>;
}

export type StartEvalTarget = (setup: EvalSetup) => Promise<EvalTarget>;

/**
 * `error` and `truncated` couldn't be graded, and they're never counted as a failure: that would blame
 * the model for the plumbing. `stale` means the server no longer gives the model what it did.
 */
export type RunStatus = 'pass' | 'fail' | 'error' | 'truncated' | 'not_run' | 'stale';

export interface RunRow {
  status: RunStatus;
  stopped: string;
  checks: GradedCheck[];
  /** Why it couldn't be graded, or what's stale. Our own words. */
  note?: string;
  refused: boolean;
  usage: AgentRun['usage'];
  costUsd: number | null;
  costIsAtMost: boolean;
  budgetUsedUsd: number;
  ms: number;
  toolCalls: { name: string; args: Record<string, unknown>; outcome: string }[];
  exchanges: readonly Exchange[];
}

/** The same keys every time, so what Crumple says can match a recording byte for byte. */
export function seededKeys(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`;
  };
}

export function setupFor(scenario: Scenario, options: { breakDescriptions?: boolean } = {}): EvalSetup {
  return {
    newKey: seededKeys(),
    retry: { attempts: 3, baseMs: 10, capMs: 20 },
    ...(scenario.fault ? { fault: scenario.fault } : {}),
    ...(options.breakDescriptions ? { breakDescriptions: true } : {}),
  };
}

interface Payment { customerId: string; amountCents: number }
interface Customer { name: string; email: string }

/** What fault-api really did, read from its own records with no fault applied. */
async function readOutcome(target: EvalTarget, run: AgentRun): Promise<Outcome> {
  const read = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${target.upstream.url}${path}`, { headers: { authorization: `Bearer ${target.credential}` } });
    return await response.json() as T;
  };
  const effects = target.upstream.effects();
  const idsOf = (kind: string): string[] => effects.filter((effect) => effect.kind === kind).map((effect) => effect.id);
  const payments = await Promise.all(idsOf('payment.created').map((id) => read<Payment>(`/payments/${id}`)));
  const customers = await Promise.all(idsOf('customer.created').map((id) => read<Customer>(`/customers/${id}`)));
  return {
    text: run.text,
    toolCalls: run.toolCalls,
    payments: payments.map(({ customerId, amountCents }) => ({ customerId, amountCents })),
    created: customers.map(({ name, email }) => ({ name, email })),
    deleted: idsOf('customer.deleted'),
    denied: target.denied().map(({ tool }) => tool),
  };
}

function ungraded(run: AgentRun): { status: RunStatus; note: string } | undefined {
  switch (run.stopped) {
    case 'done':
    case 'model_refused':
    // A model that ran away has behaved, badly, and what it left behind can still be graded.
    case 'max_turns':
    case 'max_tool_calls':
      return undefined;
    case 'max_tokens':
      return { status: 'truncated', note: 'The model was cut off by max_tokens.' };
    case 'max_usd':
      return { status: 'not_run', note: 'The budget ran out.' };
    case 'stale':
      return { status: 'stale', note: run.notes.at(-1) ?? 'It doesn\'t match its recording.' };
    case 'wrong_model':
      return { status: 'error', note: 'A different model answered from the one asked for.' };
    case 'model_error':
      return { status: 'error', note: `The model call failed: ${run.modelError?.code ?? 'unknown'}.` };
    default:
      return { status: 'error', note: `The run stopped with ${run.stopped}.` };
  }
}

export interface RunOptions {
  maxUsd: number;
  breakDescriptions?: boolean;
}

export async function runOne(scenario: Scenario, model: ModelClient, start: StartEvalTarget, options: RunOptions): Promise<RunRow> {
  const kept = recorder(model);
  const target = await start(setupFor(scenario, options));
  const started = performance.now();
  try {
    const run = await runAgent({ task: scenario.task, mcp: { url: target.url, token: target.keys[scenario.key] }, model: kept, limits: { maxUsd: options.maxUsd } });
    const ms = Math.round(performance.now() - started);
    const notGraded = ungraded(run);
    const checks = notGraded ? [] : grade(scenario.expect, await readOutcome(target, run));
    return {
      status: notGraded?.status ?? (passed(checks) ? 'pass' : 'fail'),
      stopped: run.stopped,
      checks,
      ...(notGraded ? { note: notGraded.note } : {}),
      refused: run.stopped === 'model_refused',
      usage: run.usage,
      costUsd: run.costUsd,
      costIsAtMost: run.costIsAtMost,
      budgetUsedUsd: run.budgetUsedUsd,
      ms,
      toolCalls: run.toolCalls.map(({ name, args, outcome }) => ({ name, args, outcome })),
      exchanges: kept.exchanges,
    };
  } finally {
    await target.stop();
  }
}

export interface Recording {
  format: 1;
  /** A scripted recording never comes from a model, and it says so. */
  source: 'live' | 'scripted';
  recordedAt: string;
  commit: string;
  apiVersion: string;
  model: string;
  scenario: string;
  exchanges: readonly Exchange[];
}

export function toRecording(scenario: Scenario, row: RunRow, about: { source: Recording['source']; commit: string; now: number; model: string }): Recording {
  return { format: 1, source: about.source, recordedAt: new Date(about.now).toISOString(), commit: about.commit, apiVersion: API_VERSION, model: about.model, scenario: scenario.id, exchanges: row.exchanges };
}

/** No key, no network beyond this machine, and nothing spent. Only the model is frozen: the tools really run. */
export async function replayOne(scenario: Scenario, recording: Pick<Recording, 'model' | 'exchanges'>, start: StartEvalTarget, options: { breakDescriptions?: boolean } = {}): Promise<RunRow> {
  const replay = replayer(recording);
  const row = await runOne(scenario, replay, start, { maxUsd: Number.POSITIVE_INFINITY, ...options });
  const left = replay.unused();
  if (left > 0 && row.status !== 'stale') return { ...row, status: 'stale', note: `The run finished with ${String(left)} recorded ${left === 1 ? 'turn' : 'turns'} left over.` };
  return row;
}

/** Built in, needing no key or recording, so it runs every time. */
export const runScripted = (scenario: Scenario, start: StartEvalTarget): Promise<RunRow> => runOne(scenario, obeysInjection(), start, { maxUsd: Number.POSITIVE_INFINITY });
