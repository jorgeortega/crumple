#!/usr/bin/env node
// npm run prove: runs every check on Crumple and writes proof/latest.md, .json and .svg, saying
// which commit they came from. It runs the three suites prove --self can't reach, needing uv and a
// download, and folds in what they found, so all 18 claims are in one report. With --load (npm run
// prove:load), it writes proof/load-<date>.md and .json instead. With --eval (npm run eval:live), it
// runs the live evals with your key, spending real money and stopping at $1, keeping a report in
// proof/ and full transcripts out of the repo. The proof folder doesn't count towards "uncommitted
// changes", because the last report is always in it.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** @param {string[]} args */
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const commit = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain', '--', '.', ':!proof') !== '';

/** @type {Record<string, string[]>} */
const COMMANDS = {
  '--load': ['prove', '--load', '--out', 'proof'],
  '--eval': ['eval', '--live', '--record', '--max-usd', '1', '--out', 'proof', '--transcripts', '.eval-runs'],
};

/** @param {string[]} args */
const crumple = (args) => spawnSync(process.execPath, ['dist/cli/bin.js', ...args], {
  stdio: 'inherit',
  env: { ...process.env, CRUMPLE_PROVE_COMMIT: commit, CRUMPLE_PROVE_DIRTY: dirty ? '1' : '0' },
}).status;

const named = COMMANDS[process.argv[2] ?? ''];
if (named) process.exit(crumple(named) ?? 1);

// Built code, named so the type check doesn't follow it into dist. npm run prove builds it first.
const built = '../dist/prove/index.js';
const { SUITES, suiteOutcome, withSuites, countChecks, renderBadge, renderJson, renderMarkdown } = /** @type {typeof import('../src/prove/index.js')} */ (await import(built));

/**
 * One suite, read from vitest's own results and never from its printed words.
 * @param {string} script
 * @param {string} folder
 * @returns {import('../src/prove/index.js').SuiteRun}
 */
function runSuite(script, folder) {
  const results = join(folder, `${script.replace(':', '-')}.json`);
  const began = performance.now();
  const { status } = spawnSync('npm', ['run', '--silent', script, '--', '--reporter=json', `--outputFile=${results}`], { stdio: ['ignore', 'ignore', 'ignore'] });
  const durationMs = Math.round(performance.now() - began);
  if (!existsSync(results)) return { exitCode: status === 0 ? 1 : status, passed: 0, failed: 0, skipped: 0, durationMs };
  const { numPassedTests: passed, numFailedTests: failed, numPendingTests: pending, numTodoTests: todo } = JSON.parse(readFileSync(results, 'utf8'));
  return { exitCode: status, passed, failed, skipped: pending + todo, durationMs };
}

const folder = mkdtempSync(join(tmpdir(), 'crumple-suites-'));
const outcomes = SUITES.map((suite) => {
  console.log(`Running ${suite.claim}'s suite: npm run ${suite.script}`);
  const outcome = suiteOutcome(suite, runSuite(suite.script, folder));
  console.log(`  ${outcome.state === 'pass' ? 'pass' : 'FAIL'}  ${outcome.detail}\n`);
  return outcome;
});
rmSync(folder, { recursive: true, force: true });

const status = crumple(['prove', '--self', '--out', 'proof', '--name', 'latest']);
if (status === null) process.exit(1);

// renderJson works out the counts again, and they have to include the suites.
const selfReport = JSON.parse(readFileSync('proof/latest.json', 'utf8'));
delete selfReport.counts;
const report = withSuites(selfReport, outcomes);
writeFileSync('proof/latest.md', renderMarkdown(report));
writeFileSync('proof/latest.json', renderJson(report));
writeFileSync('proof/latest.svg', renderBadge(countChecks(report.checks)));

const claims = report.claims ?? [];
const held = claims.filter(({ state }) => state === 'pass').length;
console.log(`\nAll together: ${String(held)} of ${String(claims.length)} claims passed.`);
process.exit(countChecks(report.checks).failed > 0 ? 1 : 0);
