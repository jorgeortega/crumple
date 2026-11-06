import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HANG_DEADLINE_MS, SCENARIOS, type TryReport } from '../../workers/try.js';
import { startWorker, type RunningWorker } from './harness.js';

// The buttons on Cloudflare's runtime, where fault-api is a function call inside the Worker. This is
// the path a visitor gets, and the one fault-api.run.ts can't reach over a socket.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

let worker: RunningWorker;
beforeAll(async () => { worker = await startWorker({ port: 8813, migrate: true }); });
afterAll(async () => { await worker.stop(); });

const press = async (name: string): Promise<TryReport> => {
  const response = await fetch(`${worker.url}/try/${name}`, { method: 'POST' });
  expect(response.status).toBe(200);
  return (await response.json()) as TryReport;
};
const fact = (report: TryReport, label: string): string | undefined => report.facts.find((item) => item.label === label)?.value;

describe('the buttons in workerd', () => {
  it('lose the response: one charge', async () => {
    const report = await press('lose-the-response');
    expect(report).toMatchObject({ held: true });
    expect(fact(report, 'Charges')).toBe('1');
    expect(fact(report, 'Requests the API received')).toBe('2');
    expect(report.api.map((request) => request.outcome)).toEqual(['dropped', 'answered']);
    expect(report.trace).toContain('tools/call createPayment');
  });

  it('hang the API: an error at the deadline, with the real wait', async () => {
    const started = performance.now();
    const report = await press('hang-the-api');
    expect(report.held).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(HANG_DEADLINE_MS - 50);
    expect(performance.now() - started).toBeLessThan(HANG_DEADLINE_MS + 1_000);
    expect(report.api.at(-1)?.outcome).toBe('abandoned');
  });

  it('no permission: refused, with nothing at the API', async () => {
    const report = await press('no-permission');
    expect(report.held).toBe(true);
    expect(report.api).toEqual([]);
  });

  it('plant an instruction: refused, and nothing deleted', async () => {
    const report = await press('plant-an-instruction');
    expect(report.held).toBe(true);
    expect(fact(report, 'Customers deleted')).toBe('0');
  });

  it('runs several at once without one affecting another', async () => {
    const reports = await Promise.all(Array.from({ length: 12 }, () => press('lose-the-response')));
    expect(reports.map((report) => fact(report, 'Charges'))).toEqual(Array.from({ length: 12 }, () => '1'));
  });

  it('refuses another site, and a GET, and a button that doesn\'t exist', async () => {
    const foreign = await fetch(`${worker.url}/try/no-permission`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    expect((await fetch(`${worker.url}/try/no-permission`)).status).toBe(405);
    expect((await fetch(`${worker.url}/try/nope`, { method: 'POST' })).status).toBe(404);
  });

  it('lists every button', () => {
    expect(SCENARIOS).toHaveLength(4);
  });
});

describe('the built Worker', () => {
  it('holds no way to reach a paid model, by a search of what would be deployed', async () => {
    const out = mkdtempSync(join(tmpdir(), 'crumple-bundle-'));
    try {
      await promisify(execFile)(join(ROOT, 'node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--outdir', out, '--config', 'workers/wrangler.toml'], {
        cwd: ROOT,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
      });
      const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.js')).map((entry) => join(entry.parentPath, entry.name));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(statSync(file).size).toBeGreaterThan(10_000);
        const text = readFileSync(file, 'utf8');
        expect(text).not.toContain('api.anthropic.com');
        expect(text).not.toContain('ANTHROPIC_API_KEY');
        // Sanity: this is the real bundle, so the search above means something.
        expect(text).toContain('public-demo-read-key');
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('the page, as Cloudflare serves it', () => {
  it('comes back with its policy, and the Worker never sees it', async () => {
    const page = await fetch(worker.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('A crumple zone for AI agents.');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await fetch(`${worker.url}/page.js`)).status).toBe(200);
  });

  it('has the latest report, with all 18 claims', async () => {
    const proof = (await (await fetch(`${worker.url}/proof.json`)).json()) as { claims: unknown[] };
    expect(proof.claims).toHaveLength(18);
  });
});
