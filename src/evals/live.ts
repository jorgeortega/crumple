import type { ModelClient } from '../agent-runner/index.js';
import { summarise, type ScenarioResult } from './gate.js';
import { replayOne, runOne, runScripted, type Recording, type RunRow, type StartEvalTarget } from './run.js';
import type { Scenario } from './scenarios.js';

// Running the whole list, one run at a time. That keeps the budget exact, since a run's cap is just
// what's left, and keeps rate limits out of the results. It also means a full live run takes minutes.

const unrun = (note: string): RunRow => ({
  status: 'not_run',
  stopped: 'not_run',
  checks: [],
  note,
  refused: false,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0,
  costIsAtMost: false,
  budgetUsedUsd: 0,
  ms: 0,
  toolCalls: [],
  exchanges: [],
});

export interface LiveOptions {
  scenarios: readonly Scenario[];
  start: StartEvalTarget;
  client: () => ModelClient;
  reps: number;
  maxUsd: number;
  breakDescriptions?: boolean;
  onScenario?: (result: ScenarioResult) => void;
}

export async function runLive(options: LiveOptions): Promise<ScenarioResult[]> {
  const { scenarios, start, client, reps, maxUsd, breakDescriptions = false, onScenario } = options;
  let used = 0;
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const rows: RunRow[] = [];
    const planned = scenario.scripted ? 1 : reps;
    for (let rep = 0; rep < planned; rep += 1) {
      if (scenario.scripted) {
        rows.push(await runScripted(scenario, start));
      } else if (used >= maxUsd) {
        rows.push(unrun('The budget ran out.'));
      } else {
        const row = await runOne(scenario, client(), start, { maxUsd: maxUsd - used, breakDescriptions });
        used += row.budgetUsedUsd;
        rows.push(row);
        // Nothing further can start: the next call's worst case didn't fit.
        if (row.status === 'not_run') used = Math.max(used, maxUsd);
      }
    }
    const result = summarise(scenario, rows, planned);
    results.push(result);
    onScenario?.(result);
  }
  return results;
}

export interface ReplayOptions {
  scenarios: readonly Scenario[];
  start: StartEvalTarget;
  /** Undefined when this scenario has no recording yet. */
  readRecording: (id: string) => Promise<Pick<Recording, 'model' | 'exchanges'> | undefined>;
  breakDescriptions?: boolean;
  onScenario?: (result: ScenarioResult) => void;
}

export async function runReplay(options: ReplayOptions): Promise<ScenarioResult[]> {
  const { scenarios, start, readRecording, breakDescriptions = false, onScenario } = options;
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    let rows: RunRow[] = [];
    if (scenario.scripted) {
      rows = [await runScripted(scenario, start)];
    } else {
      const recording = await readRecording(scenario.id);
      if (recording) rows = [await replayOne(scenario, recording, start, { breakDescriptions })];
    }
    const result = summarise(scenario, rows, 1);
    results.push(result);
    onScenario?.(result);
  }
  return results;
}
