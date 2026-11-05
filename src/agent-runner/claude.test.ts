import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeClaudeApi, finished, type ApiStep, type FakeApi } from '../../tests/helpers/fake-claude.js';
import { API_VERSION, claude, type Sleep } from './claude.js';
import type { ModelReply, ModelRequest } from './model.js';

const KEY = 'test-key-that-must-stay-hidden';

const REQUEST: ModelRequest = {
  model: 'claude-haiku-5-5',
  max_tokens: 8000,
  system: 's',
  tools: [],
  messages: [{ role: 'user', content: 'hello' }],
  output_config: { effort: 'medium' },
};

const apis: FakeApi[] = [];
afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()));
});

async function call(steps: ApiStep[], options: { signal?: AbortSignal; mayAttempt?: () => boolean; attemptTimeoutMs?: number; attempts?: number } = {}) {
  const api = await fakeClaudeApi(steps);
  apis.push(api);
  const waits: number[] = [];
  const sleep: Sleep = (ms) => {
    waits.push(ms);
    return Promise.resolve();
  };
  let lost = 0;
  const client = claude({
    model: REQUEST.model,
    apiKey: KEY,
    baseUrl: api.url,
    sleep,
    ...(options.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: options.attemptTimeoutMs }),
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
  });
  const reply = await client.complete(REQUEST, {
    signal: options.signal ?? AbortSignal.timeout(5_000),
    mayAttempt: options.mayAttempt ?? (() => true),
    onLost: () => { lost += 1; },
  });
  return { reply, api, waits, lost: () => lost };
}

const OK: ApiStep = { body: finished('hi') };

describe('a call to Claude', () => {
  it('sends the request as is, to the right path, with the key and a pinned version', async () => {
    const { reply, api } = await call([OK]);
    expect(reply).toMatchObject({ ok: true, message: { stop_reason: 'end_turn' } });
    expect(api.requests).toHaveLength(1);
    const [sent] = api.requests;
    expect(sent?.path).toBe('/v1/messages');
    expect(sent?.body).toBe(JSON.stringify(REQUEST));
    expect(sent?.headers['x-api-key']).toBe(KEY);
    expect(sent?.headers['anthropic-version']).toBe(API_VERSION);
    expect(API_VERSION).toBe('2026-10-21');
  });

  it('never takes its address from the environment, where a stray .env could send the key elsewhere', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://elsewhere.test');
    const seen: string[] = [];
    const client = claude({
      model: REQUEST.model,
      apiKey: KEY,
      fetch: (input) => {
        seen.push(input as string);
        return Promise.resolve(new Response(JSON.stringify(finished())));
      },
    });
    await client.complete(REQUEST, { signal: AbortSignal.timeout(1_000), mayAttempt: () => true, onLost: () => undefined });
    vi.unstubAllEnvs();
    expect(seen).toEqual(['https://api.anthropic.com/v1/messages']);
  });
});

describe('retrying', () => {
  it.each<[string, number, string]>([
    ['a rate limit', 429, 'rate_limited'],
    ['an internal error', 500, 'server_error'],
    ['being overloaded', 529, 'overloaded'],
    ['a timeout from their side', 408, 'server_error'],
    ['a conflict', 409, 'server_error'],
  ])('retries %s, then succeeds', async (_name, status) => {
    const { reply, api } = await call([{ status, body: { type: 'error' } }, OK]);
    expect(reply.ok).toBe(true);
    expect(api.requests).toHaveLength(2);
  });

  it.each<[string, number, string]>([
    ['a rate limit', 429, 'rate_limited'],
    ['an internal error', 500, 'server_error'],
    ['being overloaded', 529, 'overloaded'],
  ])('gives up on %s after 3 attempts, saying which', async (_name, status, code) => {
    const failing: ApiStep = { status, body: { type: 'error' }, headers: { 'request-id': 'req_9' } };
    const { reply, api } = await call([failing, failing, failing]);
    expect(reply).toEqual({ ok: false, code, status, requestId: 'req_9' });
    expect(api.requests).toHaveLength(3);
  });

  it.each<[number, string]>([
    [400, 'bad_request'],
    [401, 'auth'],
    [402, 'bad_request'],
    [403, 'auth'],
    [404, 'bad_request'],
    [413, 'bad_request'],
  ])('doesn\'t retry a %i, because it won\'t get better', async (status, code) => {
    const { reply, api } = await call([{ status, body: {} }]);
    expect(reply).toMatchObject({ ok: false, code, status });
    expect(api.requests).toHaveLength(1);
  });

  it('honours Retry-After', async () => {
    const { waits } = await call([{ status: 429, body: {}, headers: { 'retry-after': '7' } }, OK]);
    expect(waits).toEqual([7_000]);
  });

  it('backs off when told nothing, or told something it can\'t read', async () => {
    const { waits } = await call([{ status: 500, body: {} }, { status: 500, body: {}, headers: { 'retry-after': 'soon' } }, OK]);
    expect(waits).toEqual([500, 1_000]);
  });

  it('gives up at once when asked to wait longer than is worth it', async () => {
    const { reply, api } = await call([{ status: 429, body: {}, headers: { 'retry-after': '600' } }, OK]);
    expect(reply).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(api.requests).toHaveLength(1);
  });

  it('doesn\'t wait after its last attempt', async () => {
    const { waits } = await call([{ status: 500, body: {} }], { attempts: 1 });
    expect(waits).toEqual([]);
  });
});

describe('a lost answer, which may still have been billed', () => {
  it('retries, and counts the lost one', async () => {
    const { reply, api, lost } = await call(['drop', OK]);
    expect(reply.ok).toBe(true);
    expect(api.requests).toHaveLength(2);
    expect(lost()).toBe(1);
  });

  it('counts every one, and says it couldn\'t reach them', async () => {
    const { reply, lost } = await call(['drop', 'drop', 'drop']);
    expect(reply).toEqual({ ok: false, code: 'unreachable' });
    expect(lost()).toBe(3);
  });

  it('times out an attempt that hangs', async () => {
    const { reply, lost } = await call(['hang', 'hang'], { attemptTimeoutMs: 40, attempts: 2 });
    expect(reply).toEqual({ ok: false, code: 'timeout' });
    expect(lost()).toBe(2);
  });

  it('stops at the run\'s deadline, and makes no more attempts', async () => {
    const abort = new AbortController();
    setTimeout(() => { abort.abort(); }, 40);
    const { reply, api } = await call(['hang', OK], { signal: abort.signal });
    expect(reply).toMatchObject({ ok: false, code: 'timeout' });
    expect(api.requests).toHaveLength(1);
  });

  it.each<[string, ApiStep]>([
    ['isn\'t JSON', { rawBody: '<html>' }],
    ['is null', { rawBody: 'null' }],
    ['has no content', { body: { stop_reason: 'end_turn', usage: {} } }],
    ['has no stop reason', { body: { content: [], usage: {} } }],
    ['has no usage', { body: { content: [], stop_reason: 'end_turn' } }],
    ['has a null usage', { body: { content: [], stop_reason: 'end_turn', usage: null } }],
  ])('refuses a 200 that %s, because reading on would be guessing', async (_name, step) => {
    const { reply, api, lost } = await call([step, OK]);
    expect(reply).toMatchObject({ ok: false, code: 'invalid_response', status: 200 });
    expect(api.requests).toHaveLength(1);
    expect(lost()).toBe(1);
  });
});

describe('the money, and the key', () => {
  it('asks before the first attempt, and sends nothing when told no', async () => {
    const { reply, api } = await call([OK], { mayAttempt: () => false });
    expect(reply).toEqual({ ok: false, code: 'max_usd' });
    expect(api.requests).toEqual([]);
  });

  it('asks again before a retry', async () => {
    const answers = [true, false];
    const { reply, api } = await call([{ status: 500, body: {} }, OK], { mayAttempt: () => answers.shift() ?? false });
    expect(reply).toEqual({ ok: false, code: 'max_usd' });
    expect(api.requests).toHaveLength(1);
  });

  it('doesn\'t follow a redirect, so the key can\'t be carried off', async () => {
    const elsewhere = await fakeClaudeApi([OK]);
    apis.push(elsewhere);
    const { reply, lost } = await call([{ status: 307, body: {}, headers: { location: `${elsewhere.url}/v1/messages` } }], { attempts: 1 });
    expect(reply.ok).toBe(false);
    expect(lost()).toBe(1);
    expect(elsewhere.requests).toEqual([]);
  });

  it('keeps an error\'s text out of what it reports, even when that text repeats the key', async () => {
    const { reply } = await call([{ status: 401, body: { error: { message: `Bad key: ${KEY}` } } }]);
    const seen: ModelReply = reply;
    expect(JSON.stringify(seen)).not.toContain(KEY);
    expect(JSON.stringify(seen)).not.toContain('Bad key');
  });
});
