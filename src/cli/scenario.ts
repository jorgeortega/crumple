import { recorder, replayer, runAgent, type AgentRun, type Exchange, type ModelClient, API_VERSION } from '../agent-runner/index.js';
import type { StartTarget, TargetSetup } from '../prove/index.js';
import { startCrumple } from './prove.js';

// One task against a real Crumple, recorded or replayed. evals will build on this. For now it's what
// npm run record uses, and what shows a recording replays identically.

export interface Scenario {
  name: string;
  task: string;
  /** Which of Crumple's test keys the agent gets. */
  key: 'read' | 'write' | 'other';
  fault?: string;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    // Every response to a payment is lost, so Crumple's error is all the model has to go on. This one
    // also tests the riskiest idea in record and replay, since the model has to quote a key back.
    name: 'first-payment',
    task: 'Charge customer cus_1 $50.',
    key: 'write',
    fault: 'drop;times=3',
  },
];

export const RECORD_MAX_USD = 0.1;

export interface Recording {
  format: 1;
  recordedAt: string;
  commit: string;
  apiVersion: string;
  model: string;
  scenario: Scenario;
  exchanges: readonly Exchange[];
}

export interface ScenarioRun {
  run: AgentRun;
  /** Applied in fault-api: what actually happened, whatever the model said. */
  effects: number;
}

/** The same keys every time, so what Crumple says can match a recording byte for byte. */
export function seededKeys(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`;
  };
}

function setupFor(scenario: Scenario): TargetSetup {
  return { newKey: seededKeys(), retry: { attempts: 3, baseMs: 10, capMs: 20 }, ...(scenario.fault ? { fault: scenario.fault } : {}) };
}

export async function runScenario(scenario: Scenario, model: ModelClient, maxUsd: number, start: StartTarget = startCrumple): Promise<ScenarioRun> {
  const target = await start(setupFor(scenario));
  try {
    const run = await runAgent({ task: scenario.task, mcp: { url: target.url, token: target.keys[scenario.key] }, model, limits: { maxUsd } });
    return { run, effects: target.upstream.effects().length };
  } finally {
    await target.stop();
  }
}

export async function recordScenario(scenario: Scenario, client: ModelClient, about: { commit: string; now: () => number }, start: StartTarget = startCrumple): Promise<ScenarioRun & { recording: Recording }> {
  const recording = recorder(client);
  const result = await runScenario(scenario, recording, RECORD_MAX_USD, start);
  return {
    ...result,
    recording: {
      format: 1,
      recordedAt: new Date(about.now()).toISOString(),
      commit: about.commit,
      apiVersion: API_VERSION,
      model: client.name,
      scenario,
      exchanges: recording.exchanges,
    },
  };
}

export interface Replayed extends ScenarioRun {
  /** Why this no longer matches its recording, when it doesn't. */
  stale?: string;
}

/** No key, no network beyond this machine, and nothing spent. Only the model is frozen: the tools really run. */
export async function replayRecording(recording: Pick<Recording, 'model' | 'scenario' | 'exchanges'>, start: StartTarget = startCrumple): Promise<Replayed> {
  const replay = replayer(recording);
  const result = await runScenario(recording.scenario, replay, Number.POSITIVE_INFINITY, start);
  if (result.run.stopped === 'stale') return { ...result, stale: result.run.notes.at(-1) ?? 'It doesn\'t match its recording.' };
  const unused = replay.unused();
  if (unused > 0) return { ...result, stale: `The run finished with ${String(unused)} recorded turns left over.` };
  return result;
}

export { claude } from '../agent-runner/index.js';
