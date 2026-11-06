import { describe, expect, it } from 'vitest';
import { DEFAULT_CREDENTIAL, MALICIOUS_TEXT } from '../src/fault-api/index.js';
import { CHARGE_KEY, READ_KEY, type DemoSurface, type SurfaceSetup } from './surface.js';
import { HANG_DEADLINE_MS, isScenario, runScenario, SCENARIOS, type ScenarioId, type TryReport } from './try.js';

const fact = (report: TryReport, label: string): string | undefined => report.facts.find((item) => item.label === label)?.value;

describe('each button, run for real', () => {
  it('lose the response: one charge, two requests, one key', async () => {
    const report = await runScenario('lose-the-response');
    expect(report.held).toBe(true);
    expect(report.headline).toMatch(/^One charge\./);
    expect(fact(report, 'Charges')).toBe('1');
    expect(fact(report, 'Requests the API received')).toBe('2');
    expect(fact(report, 'Idempotency keys among them')).toBe('1');
    expect(fact(report, 'The agent was told')).toBe('It worked');
    expect(report.api.map((request) => request.outcome)).toEqual(['dropped', 'answered']);
    expect(report.trace).toContain('tools/call createPayment');
  });

  it('hang the API: an error at the deadline, and the API sees the caller give up', async () => {
    const report = await runScenario('hang-the-api');
    expect(report.held).toBe(true);
    expect(report.ms).toBeGreaterThanOrEqual(HANG_DEADLINE_MS - 50);
    expect(fact(report, 'The agent was told')).not.toBe('It worked');
    expect(report.api.at(-1)?.outcome).toBe('abandoned');
  });

  it('no permission: refused, and nothing reached the API', async () => {
    const report = await runScenario('no-permission');
    expect(report.held).toBe(true);
    expect(report.api).toEqual([]);
    expect(fact(report, 'Refusals in the audit log')).toBe('1');
    expect(fact(report, 'The agent was told')).toContain('Refused');
  });

  it('plant an instruction: the agent obeys, and it\'s refused', async () => {
    const report = await runScenario('plant-an-instruction');
    expect(report.held).toBe(true);
    expect(fact(report, 'The record said')).toBe(MALICIOUS_TEXT);
    expect(fact(report, 'Customers deleted')).toBe('0');
    expect(report.api.map((request) => request.path)).toEqual(['/customers/cus_1']);
  });

  it('gives each run its own data, so one visitor can\'t affect another', async () => {
    const [first, second] = await Promise.all([runScenario('lose-the-response'), runScenario('lose-the-response')]);
    expect(fact(first, 'Charges')).toBe('1');
    expect(fact(second, 'Charges')).toBe('1');
  });

  it('sends back nothing secret, even a fake secret', async () => {
    for (const id of SCENARIOS) {
      if (id === 'hang-the-api') continue;
      const text = JSON.stringify(await runScenario(id));
      for (const secret of [DEFAULT_CREDENTIAL, READ_KEY, CHARGE_KEY]) expect(text).not.toContain(secret);
    }
  });
});

describe('when something doesn\'t hold, the page says so', () => {
  // A server that answers every call the same way, with an API that did whatever the test says.
  function wrong(reply: unknown, api: { effects?: number; requests?: number }, status = 200) {
    return (_setup: SurfaceSetup): Promise<DemoSurface> => Promise.resolve({
      surface: { fetch: () => Promise.resolve(new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status })) },
      api: {
        effects: () => Array.from({ length: api.effects ?? 0 }, () => ({ at: 0, kind: 'payment' })) as never,
        requests: () => Array.from({ length: api.requests ?? 0 }, () => ({ at: 0, method: 'POST', path: '/x', headers: {}, outcome: 'answered' as const })),
      },
    });
  }
  const worked = { result: { content: [{ text: 'fine' }] } };
  const refused = { error: { message: 'no' } };
  const failed = { result: { content: [{ text: 'It broke.' }], isError: true } };

  it.each<[string, ScenarioId, Parameters<typeof wrong>, string]>([
    ['charging twice', 'lose-the-response', [worked, { effects: 2, requests: 2 }], 'the API applied 2'],
    ['a delete that reached the API', 'no-permission', [refused, { requests: 1 }], 'the API received 1 request'],
    ['a delete that wasn\'t refused', 'no-permission', [worked, {}], 'the API received 0 requests'],
    ['an instruction that worked', 'plant-an-instruction', [worked, { effects: 1 }], 'this run didn\'t'],
    ['an answer instead of a timeout', 'hang-the-api', [worked, {}], 'and it wasn\'t'],
  ])('%s', async (_name, id, args, expected) => {
    const report = await runScenario(id, { create: wrong(...args) });
    expect(report.held).toBe(false);
    expect(report.headline).toContain(expected);
  });

  it('says plainly when the deadline passed', async () => {
    let now = 0;
    const late = (_setup: SurfaceSetup): Promise<DemoSurface> => Promise.resolve({
      surface: { fetch: () => { now += 60_000; return Promise.resolve(new Response(JSON.stringify(failed))); } },
      api: { effects: () => [], requests: () => [] },
    });
    const report = await runScenario('hang-the-api', { create: late, now: () => now });
    expect(report.held).toBe(false);
    expect(fact(report, 'The agent waited')).toBe('60000 ms');
    expect(fact(report, 'The agent was told')).toBe('It broke.');
  });

  it('copes with an answer that isn\'t JSON, or has no text', async () => {
    const broken = await runScenario('no-permission', { create: wrong('<html>', {}, 502) });
    expect(fact(broken, 'The agent was told')).toBe('Something unexpected, HTTP 502');
    expect((await runScenario('no-permission', { create: wrong({ error: {} }, {}) })).held).toBe(false);
    expect(fact(await runScenario('lose-the-response', { create: wrong({ result: {} }, {}) }), 'The agent was told')).toBe('It worked');
    expect(fact(await runScenario('lose-the-response', { create: wrong({ result: { content: [{}] } }, {}) }), 'The agent was told')).toBe('It worked');
    expect(fact(await runScenario('lose-the-response', { create: wrong({}, {}) }), 'The agent was told')).toBe('It worked');
  });
});

describe('the list of buttons', () => {
  it('knows its own', () => {
    expect(isScenario('hang-the-api')).toBe(true);
    expect(isScenario('anything-else')).toBe(false);
  });
});
