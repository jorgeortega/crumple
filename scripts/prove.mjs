#!/usr/bin/env node
// npm run prove: runs every check on Crumple and writes proof/latest.md, .json and .svg, saying
// which commit they came from. With --load (npm run prove:load), it writes proof/load-<date>.md and
// .json instead. The proof folder doesn't count towards "uncommitted changes",
// because the last report is always in it.

import { execFileSync, spawnSync } from 'node:child_process';

/** @param {string[]} args */
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const commit = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain', '--', '.', ':!proof') !== '';

const args = process.argv.includes('--load') ? ['--load', '--out', 'proof'] : ['--self', '--out', 'proof', '--name', 'latest'];

const { status } = spawnSync(process.execPath, ['dist/cli/bin.js', 'prove', ...args], {
  stdio: 'inherit',
  env: { ...process.env, CRUMPLE_PROVE_COMMIT: commit, CRUMPLE_PROVE_DIRTY: dirty ? '1' : '0' },
});
process.exit(status ?? 1);
