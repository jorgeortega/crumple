#!/usr/bin/env node
// Fails if anything shaped like a live credential is in a file git would commit.
// Lifted from Latitude 10's scan. It runs in the pre-push hook, because this project
// has no CI until December 2026 and because it reuses code from a private codebase.
// If it fires on a real key: rotate the key first, then remove it. Deleting the line
// doesn't help once the key has left this machine.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SECRET_SHAPES = [
  { name: 'Stripe live key', pattern: /\b[sr]k_live_[0-9A-Za-z]{10,}/ },
  { name: 'Stripe webhook secret', pattern: /\bwhsec_[0-9A-Za-z]{24,}/ },
  { name: 'AWS access key id', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\b(gh[pousr]_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{60,})\b/ },
  { name: 'Anthropic key', pattern: /\bsk-ant-[0-9A-Za-z_-]{24,}/ },
  { name: 'OpenAI key', pattern: /\bsk-(proj-)?[0-9A-Za-z_-]{40,}/ },
  { name: 'npm token', pattern: /\bnpm_[0-9A-Za-z]{36}\b/ },
  { name: 'Slack token', pattern: /\bxox[abprs]-[0-9A-Za-z-]{20,}/ },
  // Latitude 10's own key prefixes, since code is lifted from there.
  { name: 'Latitude 10 key', pattern: /\bl10[a-z]?_[0-9A-Za-z_-]{24,}/ },
  { name: 'Crumple key', pattern: /\bcrumple_[0-9A-Za-z_-]{43}/ },
  { name: 'Private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{64,}/ },
];

// Lockfiles are full of long hashes, and these formats can't hold readable text.
const SKIPPED = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zip|pdf|mp4|webm|wasm|tgz)$|(^|\/)package-lock\.json$/;

/**
 * @param {string} text
 * @returns {string[]} the names of the credential shapes found, never the values
 */
export function findSecretShapes(text) {
  return SECRET_SHAPES.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

// Tracked files plus untracked ones git wouldn't ignore, so a key is caught before
// its first commit rather than after.
function filesGitWouldCommit() {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter(Boolean);
}

/** @param {string} file */
function readable(file) {
  try {
    const text = readFileSync(file, 'utf8');
    return text.includes('\0') ? undefined : text;
  } catch {
    // Tracked but deleted from disk: it isn't going anywhere new.
    return undefined;
  }
}

function main() {
  const found = [];
  const files = filesGitWouldCommit().filter((file) => !SKIPPED.test(file));
  for (const file of files) {
    const text = readable(file);
    if (text === undefined) continue;
    for (const name of findSecretShapes(text)) found.push(`${file}: ${name}`);
  }

  if (found.length > 0) {
    console.error('Secret scan failed. Rotate any real key first, then remove it:');
    for (const line of found) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`Secret scan passed (${files.length} files).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
