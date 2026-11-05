#!/usr/bin/env node
// npm run record -- first-payment: runs one scenario against a real model and saves it in
// scenarios/recordings/, then replays it to check that it matches. This spends real money, capped at
// RECORD_MAX_USD, and it needs your own key in ANTHROPIC_API_KEY. It's never run by a test.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// The build's output, typed from the source it comes from.
const BUILT = '../dist/cli/scenario.js';
const { claude, RECORD_MAX_USD, recordScenario, replayRecording, SCENARIOS } = /** @type {typeof import('../src/cli/scenario.js')} */ (await import(BUILT));

const { values, positionals } = parseArgs({ allowPositionals: true, options: { model: { type: 'string', default: 'claude-haiku-5-5' } } });
const scenario = SCENARIOS.find(({ name }) => name === positionals[0]);
if (!scenario) {
  console.error(`Name a scenario: ${SCENARIOS.map(({ name }) => name).join(', ')}`);
  process.exit(2);
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('This needs your key in ANTHROPIC_API_KEY. Nothing was sent.');
  process.exit(2);
}

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
console.log(`Running ${scenario.name} on ${values.model}, against a local Crumple. Capped at $${String(RECORD_MAX_USD)}.\n`);

const { run, effects, recording } = await recordScenario(scenario, claude({ model: values.model, apiKey }), { commit, now: () => Date.now() });

console.log(`Stopped:    ${run.stopped}, after ${String(run.turns)} turns`);
console.log(`Tool calls: ${run.toolCalls.map(({ name, outcome }) => `${name} (${outcome})`).join(', ') || 'none'}`);
console.log(`Payments:   ${String(effects)} applied in fault-api`);
console.log(`Tokens:     ${JSON.stringify(run.usage)}`);
console.log(`Cost:       ${run.costUsd === null ? 'unknown' : `${run.costIsAtMost ? 'at most ' : ''}$${run.costUsd.toFixed(6)}`}`);
if (run.modelError) console.log(`Model error: ${JSON.stringify(run.modelError)}`);
for (const note of run.notes) console.log(`Note:       ${note}`);

const json = `${JSON.stringify(recording, null, 2)}\n`;
if (json.includes(apiKey)) {
  console.error('\nThe key is in the recording, which must never happen, so it wasn\'t saved.');
  process.exit(1);
}
if (run.stopped !== 'done') {
  console.error('\nThe run didn\'t finish, so it wasn\'t saved.');
  process.exit(1);
}

const file = `scenarios/recordings/${scenario.name}.json`;
mkdirSync('scenarios/recordings', { recursive: true });
writeFileSync(file, json);
console.log(`\nSaved ${file}.`);

const { stale, effects: replayedEffects } = await replayRecording(recording);
if (stale) {
  console.error(`The replay doesn't match: ${stale}`);
  process.exit(1);
}
console.log(`Replayed with no model call: it matches, byte for byte, with ${String(replayedEffects)} applied.`);
