import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { claude, hasPrice } from '../agent-runner/index.js';
import { gatePasses, parseScenario, renderEvalJson, renderEvalMarkdown, renderEvalTerminal, renderScenarioLine, runLive, runReplay, toRecording, type EvalReport, type Recording, type Scenario, type ScenarioResult } from '../evals/index.js';
import { CliError, parseFlags, usage, type Io } from './io.js';
import { BUNDLED_SCENARIOS, environment, startCrumple } from './prove.js';

// eval replays for free, or --live spends real money, stopping at the budget. The key only ever comes
// from the environment, and a test run can pass its own fetch through io, never its own address.

const DEFAULT_MODEL = 'claude-haiku-5-5';
const DEFAULT_REPS = 5;
const MAX_REPS = 50;
const DEFAULT_MAX_USD = 1;
const MAX_MAX_USD = 100;
const KIND_ORDER: Record<Scenario['kind'], number> = { safety: 0, behaviour: 1, observation: 2 };

async function loadScenarios(dir: string, only: readonly string[], io: Io): Promise<Scenario[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    throw new CliError(`Can't read the scenarios folder ${dir}. Check the path.`, 1);
  }
  for (const id of only) {
    if (!names.includes(`${id}.json`)) throw usage(`There's no scenario called ${id}. They're the file names in ${dir}.`);
  }
  const chosen = names.filter((name) => only.length === 0 || only.includes(name.slice(0, -5)));
  const scenarios = await Promise.all(chosen.map(async (name) => {
    try {
      return parseScenario(await io.readFile(join(dir, name)), name.slice(0, -5));
    } catch (error) {
      throw new CliError((error as Error).message, 1);
    }
  }));
  if (scenarios.length === 0) throw new CliError(`There are no scenarios in ${dir}.`, 1);
  return scenarios.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : 1));
}

function number(value: string | undefined, flag: string, fallback: number, max: number, whole: boolean): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max || (whole && !Number.isInteger(parsed))) throw usage(`${flag} should be a ${whole ? 'whole ' : ''}number from ${whole ? '1' : 'above 0'} to ${String(max)}, not ${value}.`);
  return parsed;
}

export async function evalCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    live: { type: 'boolean', default: false },
    record: { type: 'boolean', default: false },
    'max-usd': { type: 'string' },
    reps: { type: 'string' },
    model: { type: 'string' },
    only: { type: 'string', multiple: true, default: [] },
    'break-descriptions': { type: 'boolean', default: false },
    out: { type: 'string' },
    transcripts: { type: 'string' },
  });
  if (positionals.length > 1) throw usage('Give one scenarios folder, or none for the ones in the package.');
  const dir = positionals[0] ?? BUNDLED_SCENARIOS;

  if (!values.live) {
    for (const [flag, given] of [['--record', values.record], ['--max-usd', values['max-usd']], ['--reps', values.reps], ['--model', values.model], ['--transcripts', values.transcripts]] as const) {
      if (given) throw usage(`${flag} goes with --live, because a replay spends nothing and records nothing.`);
    }
  }
  if (values.record && values['break-descriptions']) throw usage('--record with --break-descriptions would save recordings of a broken server. Choose one.');

  const scenarios = await loadScenarios(dir, values.only, io);
  const width = Math.max(...scenarios.map((scenario) => scenario.id.length));
  const onScenario = (result: ScenarioResult): void => { io.stdout(renderScenarioLine(result, width)); };
  const breakDescriptions = values['break-descriptions'];
  const startedAt = new Date(io.now()).toISOString();
  const began = performance.now();

  let results: ScenarioResult[];
  let liveDetails: { model: string; reps: number; maxUsd: number } | undefined;
  let liveKey: string | undefined;

  if (values.live) {
    const apiKey = io.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw usage('--live needs your key in ANTHROPIC_API_KEY. Nothing was sent.');
    liveKey = apiKey;
    const model = values.model ?? DEFAULT_MODEL;
    if (!hasPrice(model)) throw usage(`There's no price for ${model}, so its spending couldn't be capped. Nothing was sent.`);
    const reps = number(values.reps, '--reps', DEFAULT_REPS, MAX_REPS, true);
    const maxUsd = number(values['max-usd'], '--max-usd', DEFAULT_MAX_USD, MAX_MAX_USD, false);
    liveDetails = { model, reps, maxUsd };

    io.stdout(`crumple-mcp eval --live  ${model}, ${String(reps)} runs each${breakDescriptions ? ', with every tool description broken' : ''}.`);
    io.stdout(`This spends real money, and stops at $${String(maxUsd)}. Runs go one at a time, so it can take several minutes.\n`);
    results = await runLive({ scenarios, start: startCrumple, client: () => claude({ model, apiKey, fetch: io.fetch }), reps, maxUsd, breakDescriptions, onScenario });
  } else {
    io.stdout(`crumple-mcp eval  replaying recordings, with no key and nothing spent${breakDescriptions ? ', with every tool description broken' : ''}.\n`);
    results = await runReplay({
      scenarios,
      start: startCrumple,
      breakDescriptions,
      onScenario,
      async readRecording(id) {
        const path = join(dir, 'recordings', `${id}.json`);
        if (!io.fileExists(path)) return undefined;
        try {
          return JSON.parse(await io.readFile(path)) as Recording;
        } catch {
          throw new CliError(`The recording ${path} isn't valid JSON.`, 1);
        }
      },
    });
  }

  const report: EvalReport = {
    mode: values.live ? 'live' : 'replay',
    startedAt,
    durationMs: Math.round(performance.now() - began),
    environment: environment(io),
    brokenDescriptions: breakDescriptions,
    results,
    scenarios,
    ...(liveDetails ?? {}),
  };
  io.stdout(renderEvalTerminal(report));

  const date = startedAt.slice(0, 10);
  if (values.record && liveDetails && liveKey !== undefined) {
    const { model } = liveDetails;
    for (const result of results) {
      const kept = result.scenario.scripted ? undefined : result.rows.find((row) => row.status === 'pass');
      if (!kept) continue;
      const json = `${JSON.stringify(toRecording(result.scenario, kept, { source: 'live', commit: io.env.CRUMPLE_PROVE_COMMIT ?? 'unknown', now: io.now(), model }), null, 2)}\n`;
      if (json.includes(liveKey)) throw new CliError('The key is in a recording, which must never happen, so it wasn\'t saved.', 1);
      await io.writeFile(join(dir, 'recordings', `${result.scenario.id}.json`), json);
    }
    io.stdout(`  Kept one passing run per scenario in ${join(dir, 'recordings')}. That's for replay, and it isn't a pass rate.`);
  }
  if (values.transcripts !== undefined) {
    for (const result of results) {
      for (const [index, row] of result.rows.entries()) {
        await io.writeFile(join(values.transcripts, date, `${result.scenario.id}-${String(index + 1)}.json`), `${JSON.stringify(row, null, 2)}\n`);
      }
    }
    io.stdout(`  Transcripts: ${join(values.transcripts, date)}`);
  }
  if (values.out !== undefined) {
    await io.writeFile(join(values.out, `evals-${date}.md`), renderEvalMarkdown(report));
    await io.writeFile(join(values.out, `evals-${date}.json`), renderEvalJson(report));
    io.stdout(`  Report: ${join(values.out, `evals-${date}.md`)}, with .json beside it.`);
  }
  return gatePasses(results) ? 0 : 1;
}
