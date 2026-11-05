import { describe, expect, it } from 'vitest';
import { wrongServer } from '../../tests/helpers/wrong-server.js';
import { runChecks } from './checks.js';
import { SELF_CHECKS } from './self-checks.js';

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
