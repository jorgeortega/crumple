import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findSecretShapes } from '../scripts/secret-scan.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/secret-scan.mjs', import.meta.url));

// Every fake key is assembled at run time, so this file doesn't trip the scan it tests.
const FAKE_GITHUB_TOKEN = `ghp_${'a'.repeat(36)}`;

describe('findSecretShapes', () => {
  it.each([
    ['Stripe live key', `key = "sk_live_${'a'.repeat(24)}"`],
    ['Stripe webhook secret', `whsec_${'a'.repeat(24)}`],
    ['AWS access key id', `AKIA${'A'.repeat(16)}`],
    ['GitHub token', FAKE_GITHUB_TOKEN],
    ['Anthropic key', `sk-ant-${'a'.repeat(24)}`],
    ['OpenAI key', `sk-proj-${'a'.repeat(40)}`],
    ['npm token', `npm_${'a'.repeat(36)}`],
    ['Slack token', `xoxb-${'1'.repeat(20)}`],
    ['Latitude 10 key', `l10m_${'a'.repeat(24)}`],
    ['Crumple key', `crumple_${'a'.repeat(43)}`],
    ['Private key', `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(80)}`],
  ])('finds a %s', (name, text) => {
    expect(findSecretShapes(text)).toEqual([name]);
  });

  it.each([
    ['a test mode key', 'sk_test_abcdefghijklmnop'],
    ['a template in a private key header', '-----BEGIN PRIVATE KEY-----\n${der}'],
    ['a short key prefix in prose', 'keys start with l10m_ and are hashed'],
  ])('ignores %s', (_label, text) => {
    expect(findSecretShapes(text)).toEqual([]);
  });
});

describe('the scan command', () => {
  const folders: string[] = [];

  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  function repoWith(files: Record<string, string>): string {
    const folder = mkdtempSync(join(tmpdir(), 'crumple-scan-'));
    folders.push(folder);
    execFileSync('git', ['init', '-q'], { cwd: folder });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
    return folder;
  }

  function scan(cwd: string) {
    return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
  }

  it('passes on a clean repo', () => {
    expect(scan(repoWith({ 'a.ts': 'export const a = 1;' })).status).toBe(0);
  });

  // Untracked files count: the point is to stop a key before it's ever committed.
  it('fails on a key in a file git hasn\'t seen yet, naming the file', () => {
    const result = scan(repoWith({ 'config.ts': `const key = '${FAKE_GITHUB_TOKEN}';` }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('config.ts: GitHub token');
  });

  // The output ends up in terminals and logs, so it must not spread the secret.
  it('never prints the secret itself', () => {
    const result = scan(repoWith({ 'config.ts': FAKE_GITHUB_TOKEN }));
    expect(result.stdout + result.stderr).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it('skips files git ignores', () => {
    const result = scan(repoWith({ '.gitignore': '.env\n', '.env': FAKE_GITHUB_TOKEN }));
    expect(result.status).toBe(0);
  });

  it('skips binary files', () => {
    const result = scan(repoWith({ 'blob.bin': `\0${FAKE_GITHUB_TOKEN}` }));
    expect(result.status).toBe(0);
  });
});
