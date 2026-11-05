import { describe, expect, it } from 'vitest';
import { wrongServer } from '../cli/wrong-server.js';
import { runChecks } from './checks.js';
import { proverChecks, SELF_CHECKS, type Prover } from './self-checks.js';

// The main risk with a module whose job is printing "pass" is a check that can't print anything else.
// So every check has to fail against a server that really is wrong, and for the reason it's there for.
describe('every check can fail', () => {
  const WHY: Record<string, RegExp> = {
    'denied-by-default': /no key wasn't refused/,
    'permission-holds': /delete went through, with 1 effect/,
    'token-stays-here': /agent's key reached the API/,
    'credential-stays-hidden': /credential is in the tool's output/,
    'one-effect': /One response was lost, and there are 2 effects/,
    'deadline-holds': /With hang, no answer came within/,
    'right-retries': /A 400 got 3 attempts/,
    'breaker-opens': /still reached the API/,
    'noisy-caller': /Nothing was refused/,
    'errors-say-what-next': /doesn't say whether retrying can help/,
  };

  it('has a reason listed for every check', () => {
    expect(Object.keys(WHY).sort()).toEqual(SELF_CHECKS.map((check) => check.id).sort());
  });

  it.each(SELF_CHECKS.map((check) => [check.id, check] as const))('%s fails on a server that\'s wrong', async (id, check) => {
    const [outcome] = await runChecks([check], wrongServer);
    expect(outcome?.state).toBe('fail');
    expect(outcome?.detail).toMatch(WHY[id] ?? /never/);
  }, 15_000);
});

// These two are about prove, not the server, so a wrong server can't make them fail. A wrong prove can.
describe('the checks on prove itself can fail', () => {
  const [safe, cost] = proverChecks(async (url, key) => {
    // Does exactly what prove mustn't: trusts the hint, and calls the tool.
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'listCustomers', arguments: {} } }),
    });
    return { checks: [], notes: [], tools: { count: 1, totalTokens: 1, incomplete: false, perTool: [{ name: 'a', tokens: 1 }] } };
  });

  it('notices a prove that calls a tool nobody named', async () => {
    const [outcome] = await runChecks([safe as NonNullable<typeof safe>], wrongServer);
    expect(outcome).toMatchObject({ state: 'fail', detail: expect.stringContaining('called a real tool nobody named') as string });
    expect(cost).toBeDefined();
  });

  it.each<[string, Awaited<ReturnType<Prover>>['tools'], RegExp]>([
    ['no tools', undefined, /no tools/],
    ['no estimate', { count: 2, totalTokens: 0, incomplete: false, perTool: [] }, /no estimate/],
  ])('notices %s', async (_name, tools, message) => {
    const prover: Prover = () => Promise.resolve({ checks: [], notes: [], ...(tools ? { tools } : {}) });
    const [first, second] = proverChecks(prover);
    const which = tools ? second : first;
    const [outcome] = await runChecks([which as NonNullable<typeof which>], wrongServer);
    expect(outcome?.state).toBe('fail');
    expect(outcome?.detail).toMatch(message);
  });
});
