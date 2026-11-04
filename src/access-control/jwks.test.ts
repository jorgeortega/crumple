import { describe, expect, it } from 'vitest';
import { createKeySource, MAX_JWKS_BYTES } from './jwks.js';

const URL_ = 'https://login.example.test/jwks.json';
const SET_A = { keys: [{ kty: 'EC', kid: 'a' }] };
const SET_B = { keys: [{ kty: 'EC', kid: 'b' }] };

function setup(respond: (() => Response | Promise<Response>)[]) {
  let time = 1_000_000;
  const requests: string[] = [];
  const queue = [...respond];
  const source = createKeySource({
    jwksUri: URL_,
    now: () => time,
    fetch: (input) => {
      requests.push(input as string);
      const next = queue.shift();
      return next ? Promise.resolve(next()) : Promise.reject(new Error('no response left'));
    },
  });
  return { source, requests, advance: (ms: number) => { time += ms; } };
}

const ok = (body: unknown, cacheControl = 'max-age=600') => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'cache-control': cacheControl } });

describe('fetching keys', () => {
  it('fetches once, then serves from the cache', async () => {
    const { source, requests } = setup([ok(SET_A)]);
    expect(await source.get()).toEqual(SET_A);
    expect(await source.get()).toEqual(SET_A);
    expect(requests).toEqual([URL_]);
  });

  it('asks only the configured address, never following a redirect', async () => {
    let seen: RequestInit | undefined;
    const source = createKeySource({
      jwksUri: URL_,
      fetch: (_input, init) => {
        seen = init;
        return Promise.resolve(new Response(JSON.stringify(SET_A)));
      },
    });
    await source.get();
    expect(seen?.redirect).toBe('manual');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks once when many calls arrive together', async () => {
    const { source, requests } = setup([ok(SET_A)]);
    const results = await Promise.all([source.get(), source.get(), source.get()]);
    expect(results).toEqual([SET_A, SET_A, SET_A]);
    expect(requests).toHaveLength(1);
  });

  it('keeps at most 50 keys', async () => {
    const many = { keys: Array.from({ length: 80 }, (_, i) => ({ kty: 'EC', kid: String(i) })) };
    const { source } = setup([ok(many)]);
    expect((await source.get())?.keys).toHaveLength(50);
  });
});

describe('how long keys are kept', () => {
  it.each([
    ['max-age within the limits', 'max-age=600', 600],
    ['a max-age too short', 'max-age=1', 300],
    ['a max-age too long', 'max-age=9999999', 86_400],
    ['no max-age', 'no-store', 300],
  ])('with %s', async (_name, header, seconds) => {
    const { source, requests, advance } = setup([ok(SET_A, header), ok(SET_B)]);
    await source.get();
    advance(seconds * 1000 - 1);
    expect(await source.get()).toEqual(SET_A);
    advance(1);
    expect(await source.get()).toEqual(SET_B);
    expect(requests).toHaveLength(2);
  });

  it('copes with no cache-control header', async () => {
    const { source } = setup([() => new Response(JSON.stringify(SET_A))]);
    expect(await source.get()).toEqual(SET_A);
  });
});

describe('when the issuer rotates its keys', () => {
  it('fetches again for an unknown key', async () => {
    const { source, advance } = setup([ok(SET_A), ok(SET_B)]);
    await source.get();
    advance(60_000);
    expect(await source.refresh()).toEqual(SET_B);
    expect(await source.get()).toEqual(SET_B);
  });

  // Garbage tokens with made-up key ids can't make us hammer the issuer.
  it('fetches again at most once a minute', async () => {
    const { source, requests, advance } = setup([ok(SET_A), ok(SET_B), ok(SET_B)]);
    await source.get();
    await source.refresh();
    await source.refresh();
    advance(59_999);
    await source.refresh();
    expect(requests).toHaveLength(2);
    advance(1);
    await source.refresh();
    expect(requests).toHaveLength(3);
  });
});

describe('when the issuer is down', () => {
  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => new Response('nope', { status: 500 })],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } })],
    ['not JSON', () => new Response('<html>')],
    ['JSON with no key list', () => new Response('{"keys":"nope"}')],
    ['JSON that isn\'t an object', () => new Response('null')],
    ['a response over the cap', () => new Response(JSON.stringify({ keys: [], pad: 'x'.repeat(MAX_JWKS_BYTES) }))],
    ['a lost connection', () => Promise.reject(new Error('connection lost'))],
  ])('keeps the old keys after %s', async (_name, failure) => {
    const { source, advance } = setup([ok(SET_A), failure]);
    await source.get();
    advance(601_000);
    expect(await source.get()).toEqual(SET_A);
  });

  it('says there are no keys when it never had any', async () => {
    const { source } = setup([() => new Response('nope', { status: 500 })]);
    expect(await source.get()).toBeUndefined();
  });

  it('says there are no keys from a refresh too', async () => {
    const { source } = setup([() => new Response('nope', { status: 500 })]);
    expect(await source.refresh()).toBeUndefined();
  });

  it('holds back between failed attempts, so an outage doesn\'t mean one fetch per request', async () => {
    const { source, requests, advance } = setup([() => new Response('nope', { status: 500 }), ok(SET_A)]);
    expect(await source.get()).toBeUndefined();
    expect(await source.get()).toBeUndefined();
    expect(requests).toHaveLength(1);
    advance(10_000);
    expect(await source.get()).toEqual(SET_A);
    expect(requests).toHaveLength(2);
  });

  it('gets going again after one bad fetch, even while another call is waiting', async () => {
    let release: (value: Response) => void = () => undefined;
    const slow = new Promise<Response>((resolve) => { release = resolve; });
    const { source, requests } = setup([() => slow]);
    const [first, second] = [source.get(), source.get()];
    release(new Response(JSON.stringify(SET_A)));
    expect(await first).toEqual(SET_A);
    expect(await second).toEqual(SET_A);
    expect(requests).toHaveLength(1);
  });
});
