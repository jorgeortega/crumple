import { describe, expect, it, vi } from 'vitest';
import { harness, runOnce } from '../../tests/helpers/cli.js';
import { DEFAULT_CREDENTIAL } from '../fault-api/index.js';
import type { StartTarget } from '../prove/index.js';
import { runDemo } from './demo.js';
import { startCrumple } from './prove.js';
import { wrongServer } from './wrong-server.js';

const demo = async (servers: { plain?: StartTarget; crumple?: StartTarget }): Promise<{ code: number; out: string }> => {
  const running = harness();
  const code = await runDemo({ plain: servers.plain ?? wrongServer, crumple: servers.crumple ?? startCrumple }, running.io);
  return { code, out: running.out() };
};

describe('demo', () => {
  it('shows the double charge next to Crumple, measured and not typed in', async () => {
    const { code, out, err } = await runOnce(['demo']);
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toMatch(/Plain retry loop\s+succeeded\s+2/);
    expect(out).toMatch(/Crumple\s+succeeded\s+1/);
    // Someone reading this should know who wrote the losing side.
    expect(out).toContain('a server we wrote to make this mistake');
    expect(out).toContain('It isn\'t any real project');
  }, 60_000);

  it('shows the trace of Crumple\'s call, with the attempt that lost its response', async () => {
    const { out } = await runOnce(['demo']);
    expect(out).toContain('createPayment');
    expect(out).toMatch(/server\s+\d+ ms/);
    expect(out).not.toContain(DEFAULT_CREDENTIAL);
  }, 60_000);

  it('goes on to every check, and says plainly how far they reach', async () => {
    const { out } = await runOnce(['demo']);
    expect(out).toMatch(/pass\s+denied-by-default/);
    expect(out).toMatch(/pass\s+deadline-holds/);
    expect(out).toContain('13 passed, 0 failed, 0 not run');
    expect(out).toMatch(/Of 18 claims, \d+ passed, 2 were partly checked and \d+ weren't checked by this run\./);
    expect(out).toContain('says nothing about production');
  }, 60_000);

  it('ends by saying what to run next', async () => {
    const { out } = await runOnce(['demo']);
    expect(out).toContain('npx crumple-mcp serve');
    expect(out).toContain('npx crumple-mcp prove https://');
  }, 60_000);

  it('fails when Crumple charges more than once', async () => {
    const { code, out } = await demo({ crumple: wrongServer });
    expect(code).toBe(1);
    expect(out).toMatch(/Crumple\s+succeeded\s+2/);
    expect(out).toContain('Crumple charged 2 times');
  }, 60_000);

  it('says the comparison shows nothing if the plain loop doesn\'t charge twice', async () => {
    const { code, out } = await demo({ plain: startCrumple });
    expect(code).toBe(1);
    expect(out).toContain('so this comparison shows nothing');
  }, 60_000);

  it('fails when a later check doesn\'t hold, and says why that can happen', async () => {
    const tooGenerous: StartTarget = (setup) => startCrumple({ ...setup, limits: { perCaller: 100, queuePerCaller: 100, perUpstream: 100, queueUpstream: 100 } });
    const { code, out } = await demo({ crumple: tooGenerous });
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL\s+noisy-caller/);
    expect(out).toContain('a very busy machine');
  }, 60_000);

  it('takes no options, and says so', async () => {
    const { code, err } = await runOnce(['demo', '--fast']);
    expect(code).toBe(2);
    expect(err).toContain('--fast');
    const extra = await runOnce(['demo', 'something']);
    expect(extra.code).toBe(2);
    expect(extra.err).toContain('demo takes no');
  });

  it('is in the help', async () => {
    const { out } = await runOnce(['--help']);
    expect(out).toMatch(/demo\s+Break an API on purpose/);
    expect(out).toContain('No key');
  });

  it('stays on this machine, as it says it does', async () => {
    const sent = vi.spyOn(globalThis, 'fetch');
    try {
      const { code, out } = await runOnce(['demo']);
      expect(code).toBe(0);
      expect(out).toContain('nothing leaves this machine');
      const hosts = new Set(sent.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input).hostname));
      expect(hosts).toEqual(new Set(['127.0.0.1']));
    } finally {
      sent.mockRestore();
    }
  }, 60_000);
});
