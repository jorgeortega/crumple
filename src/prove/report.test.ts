import { describe, expect, it } from 'vitest';
import { countChecks, fail, notRun, pass, runChecks, type Check, type CheckOutcome } from './checks.js';
import { CLAIMS, rollUpClaims } from './claims.js';
import { renderBadge, renderJson, renderMarkdown, renderTerminal, safeName, safeTarget, type ProveReport } from './report.js';

const ENVIRONMENT = { version: '0.1.0', os: 'darwin arm64', cpu: 'Test CPU', memoryGb: 16, node: '22.13.1' };

const outcome = (id: string, state: CheckOutcome['state'], claim?: string): CheckOutcome => ({ id, title: `Title of ${id}`, state, detail: `Detail of ${id}`, ...(claim ? { claim } : {}) });

const serverReport = (overrides: Partial<ProveReport> = {}): ProveReport => ({
  kind: 'server',
  target: 'https://you.test/mcp',
  startedAt: '2026-11-05T10:00:00.000Z',
  durationMs: 1234,
  environment: ENVIRONMENT,
  protocol: '2026-07-28',
  checks: [outcome('speaks-mcp', 'pass'), outcome('refuses-foreign-origin', 'fail'), outcome('bad-arguments', 'not_run')],
  requests: { used: 8, max: 30 },
  ...overrides,
});

describe('running checks', () => {
  const check = (id: string, run: Check<undefined>['run'], claim?: string): Check<undefined> => ({ id, title: id, run, ...(claim ? { claim } : {}) });

  it('runs them in order, one at a time, and reports each as it finishes', async () => {
    const order: string[] = [];
    const seen: string[] = [];
    const slow = check('a', async () => {
      order.push('a starts');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('a ends');
      return pass('fine');
    }, 'C1');
    const quick = check('b', () => {
      order.push('b');
      return Promise.resolve(fail('no', { ms: 5 }));
    });
    const outcomes = await runChecks([slow, quick], undefined, { onOutcome: (done) => seen.push(done.id) });

    expect(order).toEqual(['a starts', 'a ends', 'b']);
    expect(seen).toEqual(['a', 'b']);
    expect(outcomes).toEqual([
      { id: 'a', title: 'a', claim: 'C1', state: 'pass', detail: 'fine' },
      { id: 'b', title: 'b', state: 'fail', detail: 'no', measured: { ms: 5 } },
    ]);
  });

  it('calls a crash a fail, without repeating the error\'s text', async () => {
    const [crashed, odd] = await runChecks([
      check('a', () => Promise.reject(new TypeError('text from a server: <img src=x>'))),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- on purpose
      check('b', () => Promise.reject('not an error')),
    ], undefined);
    expect(crashed).toMatchObject({ state: 'fail', detail: 'The check couldn\'t finish, because of a TypeError.' });
    expect(odd).toMatchObject({ state: 'fail', detail: 'The check couldn\'t finish, because of a problem.' });
  });

  it('calls a check that never finishes a fail, and moves on', async () => {
    const outcomes = await runChecks([check('a', () => new Promise(() => undefined)), check('b', () => Promise.resolve(pass('ok')))], undefined, { timeoutMs: 10 });
    expect(outcomes[0]).toMatchObject({ state: 'fail', detail: expect.stringContaining('didn\'t finish') as string });
    expect(outcomes[1]?.state).toBe('pass');
  });
});

describe('claims', () => {
  it('lists all 18, as in the main spec', () => {
    expect(CLAIMS.map((claim) => claim.id)).toEqual(Array.from({ length: 18 }, (_, index) => `C${String(index + 1)}`));
  });

  const claims = [{ id: 'C1', text: 'One' }, { id: 'C2', text: 'Two', pending: 'evals' }];
  const stateOf = (outcomes: CheckOutcome[], id = 'C1') => rollUpClaims(outcomes, claims).find((claim) => claim.id === id)?.state;

  it.each<[string, CheckOutcome[], string, string]>([
    ['every part held', [outcome('a', 'pass', 'C1'), outcome('b', 'pass', 'C1')], 'C1', 'pass'],
    ['any part failed', [outcome('a', 'pass', 'C1'), outcome('b', 'fail', 'C1')], 'C1', 'fail'],
    ['a part didn\'t run', [outcome('a', 'pass', 'C1'), outcome('b', 'not_run', 'C1')], 'C1', 'partly'],
    ['nothing ran', [outcome('a', 'not_run', 'C1')], 'C1', 'not_run'],
    ['no checks exist', [], 'C1', 'not_run'],
    ['it held, with a part checked elsewhere', [outcome('a', 'pass', 'C2')], 'C2', 'partly'],
    ['it failed, with a part checked elsewhere', [outcome('a', 'fail', 'C2')], 'C2', 'fail'],
    ['only the part elsewhere is left', [], 'C2', 'not_run'],
  ])('when %s', (_name, outcomes, id, expected) => {
    expect(stateOf(outcomes, id)).toBe(expected);
  });
});

describe('counts', () => {
  it('never counts what didn\'t run as passed or failed', () => {
    expect(countChecks([outcome('a', 'pass'), outcome('b', 'fail'), outcome('c', 'not_run'), outcome('d', 'not_run')])).toEqual({ passed: 1, failed: 1, notRun: 2 });
  });
});

describe('text from a server can\'t reach a reader', () => {
  it.each([
    ['getCustomer', 'getCustomer'],
    ['admin.tools_v2-x', 'admin.tools_v2-x'],
    ['![x](https://evil.test/a.png)', '??x??https?', ],
    ['<img src=x onerror=alert(1)>', '?img?src?x?onerror?alert?1??'],
    ['\u001b[31mred\u001b[0m', '??31mred??0m'],
    ['a|b`c', 'a?b?c'],
  ])('escapes %j', (name, expected) => {
    expect(safeName(name).startsWith(expected)).toBe(true);
    expect(safeName(name)).toMatch(/^[A-Za-z0-9_.?-]+$/);
  });

  it('shortens a very long name', () => {
    expect(safeName('a'.repeat(500))).toBe(`${'a'.repeat(64)}...`);
  });

  it('never puts a raw tool name in the Markdown or JSON', () => {
    const report = serverReport({ tools: { count: 1, totalTokens: 10, incomplete: false, perTool: [{ name: '![x](https://evil.test/a.png)', tokens: 10 }] } });
    for (const text of [renderMarkdown(report), renderJson(report)]) {
      // What's left is inert text in a code span: no link, no image, nothing that loads.
      expect(text).not.toContain('https://evil.test');
      expect(text).not.toContain('![x]');
    }
  });
});

describe('the target in a report', () => {
  it('drops the query string and sign-in details, which is where keys get put', () => {
    expect(safeTarget('https://user:pass@you.test:8443/mcp?key=secret#x')).toBe('https://you.test:8443/mcp');
  });

  it('doesn\'t repeat a command line, which may hold secrets', () => {
    expect(safeTarget('node server.js --key secret')).toBe('a local process');
  });

  it('applies to everything written', () => {
    const report = serverReport({ target: 'https://you.test/mcp?key=secret' });
    for (const text of [renderTerminal(report), renderMarkdown(report), renderJson(report)]) expect(text).not.toContain('secret');
  });
});

describe('the terminal report', () => {
  it('states what passed, failed and didn\'t run, and how much of the budget went', () => {
    const text = renderTerminal(serverReport({ notes: ['This answered with no credential.'] }));
    expect(text).toContain('https://you.test/mcp');
    expect(text).toContain('Protocol 2026-07-28');
    expect(text).toMatch(/pass\s+speaks-mcp/);
    expect(text).toMatch(/FAIL\s+refuses-foreign-origin/);
    expect(text).toMatch(/not run\s+bad-arguments/);
    expect(text).toContain('1 passed, 1 failed, 1 not run. 8 of 30 requests used.');
    expect(text).toContain('Note: This answered with no credential.');
    expect(text).toContain('npx @modelcontextprotocol/conformance');
    expect(text).toContain('How to fix these');
  });

  it('never mentions Latitude 10, which only the shared file may do', () => {
    expect(renderTerminal(serverReport()).toLowerCase()).not.toContain('latitude');
  });

  it('gives the time for a run on Crumple, which has no budget', () => {
    const text = renderTerminal(serverReport({ kind: 'self', requests: undefined as never, durationMs: 4500, checks: [outcome('C1', 'pass')] }));
    expect(text).toContain('Crumple itself, on this machine');
    expect(text).toContain('1 passed, 0 failed, 0 not run. 4.5 s.');
    expect(text).not.toContain('How to fix');
    expect(text).not.toContain('conformance');
  });

  it('counts tools in plain English, and admits when the list didn\'t finish', () => {
    expect(renderTerminal(serverReport({ tools: { count: 1, totalTokens: 7, incomplete: false, perTool: [] } }))).toContain('1 tool, about 7 tokens per turn (estimate)');
    expect(renderTerminal(serverReport({ tools: { count: 3, totalTokens: 9, incomplete: true, perTool: [] } }))).toContain('3 tools or more');
  });

  it('names what can\'t be checked from outside', () => {
    expect(renderTerminal(serverReport({ outOfReach: [{ claim: 'C5', text: 'double charges' }] }))).toContain('Can\'t be checked from outside: C5.');
  });
});

describe('the Markdown report', () => {
  it('has the credit line once, at the end', () => {
    const text = renderMarkdown(serverReport());
    expect(text.match(/Latitude 10/g)).toHaveLength(1);
    expect(text.trim().endsWith('which also hosts MCP servers.')).toBe(true);
  });

  it('says it isn\'t an audit, and points to the official suite', () => {
    const text = renderMarkdown(serverReport());
    expect(text).toContain('isn\'t a security audit');
    expect(text).toContain('npx @modelcontextprotocol/conformance');
  });

  it('labels token counts as estimates, and lists them', () => {
    const text = renderMarkdown(serverReport({ tools: { count: 2, totalTokens: 30, incomplete: false, perTool: [{ name: 'big', tokens: 25 }, { name: 'small', tokens: 5 }] } }));
    expect(text).toContain('**estimates**');
    expect(text).toContain('| `big` | 25 |');
  });

  it('lists what can\'t be seen, every time', () => {
    const text = renderMarkdown(serverReport({ outOfReach: [{ claim: 'C5', text: 'Whether writes apply twice.' }] }));
    expect(text).toContain('**C5:** Whether writes apply twice.');
    expect(text).toContain('No result here means nothing either way');
  });

  it('shows claims for Crumple, with what wasn\'t checked', () => {
    const claims = rollUpClaims([outcome('C1', 'pass', 'C1'), outcome('C2', 'pass', 'C2')]);
    const text = renderMarkdown(serverReport({ kind: 'self', requests: undefined as never, claims, environment: { ...ENVIRONMENT, commit: 'abc1234', dirty: true }, checks: [outcome('C1', 'pass', 'C1')] }));
    expect(text).toContain('| C1 | Access is denied by default | pass |  |');
    expect(text).toContain('| C2 | The model can\'t talk its way past a permission | partly checked | the part with a real model needs evals (Task 28) |');
    expect(text).toContain('| C15 | The public demo can\'t run up a bill or be abused | not run |');
    expect(text).toContain('commit abc1234 with uncommitted changes');
    expect(text).toContain('production load');
  });

  it('keeps a table together when a detail holds a pipe or a line break', () => {
    const checks = [{ ...outcome('a', 'pass'), detail: 'one | two\nthree' }];
    expect(renderMarkdown(serverReport({ checks }))).toContain('one \\| two three');
  });

  it('only mentions fixing things when something failed', () => {
    expect(renderMarkdown(serverReport({ checks: [outcome('a', 'pass')] }))).not.toContain('How to fix');
  });
});

describe('the JSON report', () => {
  it('carries the same results as the Markdown, with counts', () => {
    const parsed = JSON.parse(renderJson(serverReport())) as { counts: unknown; checks: unknown[]; target: string };
    expect(parsed.counts).toEqual({ passed: 1, failed: 1, notRun: 1 });
    expect(parsed.checks).toHaveLength(3);
    expect(parsed.target).toBe('https://you.test/mcp');
  });

  it('keeps what a run on Crumple calls itself', () => {
    const parsed = JSON.parse(renderJson(serverReport({ kind: 'self', target: 'self' }))) as { target: string };
    expect(parsed.target).toBe('self');
  });
});

describe('the badge', () => {
  it.each([
    [{ passed: 3, failed: 1, notRun: 7 }, '3 passed · 1 failed · 7 not run', '#cf222e'],
    [{ passed: 3, failed: 0, notRun: 0 }, '3 passed · 0 failed · 0 not run', '#1a7f37'],
    [{ passed: 0, failed: 0, notRun: 5 }, '0 passed · 0 failed · 5 not run', '#6e7781'],
  ])('shows %j without ever just saying passing', (counts, text, colour) => {
    const badge = renderBadge(counts);
    expect(badge).toContain(text);
    expect(badge).toContain(colour);
    expect(badge).toContain('<svg');
  });

  it('holds nothing but numbers from a run', () => {
    expect(renderBadge({ passed: 1, failed: 0, notRun: 0 })).not.toContain('http://evil');
  });
});

describe('helpers', () => {
  it('builds results', () => {
    expect(pass('a')).toEqual({ state: 'pass', detail: 'a' });
    expect(fail('b', { ms: 1 })).toEqual({ state: 'fail', detail: 'b', measured: { ms: 1 } });
    expect(notRun('c')).toEqual({ state: 'not_run', detail: 'c' });
  });
});
