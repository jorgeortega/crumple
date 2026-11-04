import { beforeAll, describe, expect, it } from 'vitest';
import { AUDIENCE, base64Url, createIssuer, encodeJson, goodClaims, ISSUER, NOW_S, type Alg, type TestIssuer } from '../../tests/helpers/issuer.js';
import { MAX_JWT_BYTES, verifyJwt, type Jwks } from './jwt.js';

const EXPECT = { issuer: ISSUER, audience: AUDIENCE, now: NOW_S * 1000 };

let issuer: TestIssuer;
let jwks: Jwks;

beforeAll(async () => {
  issuer = await createIssuer('ES256');
  jwks = { keys: [issuer.jwk] };
});

const reasonFor = async (token: string, keys: Jwks = jwks, expected = EXPECT): Promise<string> => {
  const result = await verifyJwt(token, keys, expected);
  return result.ok ? 'ok' : result.reason;
};

describe('a good token', () => {
  it.each<[Alg]>([['RS256'], ['PS256'], ['ES256']])('passes with %s', async (alg) => {
    const own = await createIssuer(alg);
    const result = await verifyJwt(await own.sign(goodClaims()), { keys: [own.jwk] }, EXPECT);
    expect(result).toMatchObject({ ok: true, claims: { sub: 'person@example.test' } });
  });

  it('passes with a list of audiences that includes this server', async () => {
    expect(await reasonFor(await issuer.sign(goodClaims({ aud: ['https://other.test', AUDIENCE] })))).toBe('ok');
  });

  // The change from jose.ts, which was written for ID tokens. Real access tokens look like
  // this, and the ID-token rule would have refused them.
  it('passes with an azp claim and two audiences', async () => {
    const claims = goodClaims({ aud: [AUDIENCE, 'https://login.example.test/userinfo'], azp: 'some-client-id' });
    expect(await reasonFor(await issuer.sign(claims))).toBe('ok');
  });

  it('passes with no iat, since it\'s only refused when it\'s far ahead', async () => {
    const claims = goodClaims();
    delete claims.iat;
    expect(await reasonFor(await issuer.sign(claims))).toBe('ok');
  });

  it('passes with no kid when the issuer has one key', async () => {
    const claims = goodClaims();
    const token = await issuer.signRaw(encodeJson({ alg: 'ES256' }), encodeJson(claims));
    expect(await reasonFor(token)).toBe('ok');
  });

  it('allows a little clock difference', async () => {
    expect(await reasonFor(await issuer.sign(goodClaims({ exp: NOW_S - 30 })))).toBe('ok');
    expect(await reasonFor(await issuer.sign(goodClaims({ nbf: NOW_S + 30 })))).toBe('ok');
    expect(await reasonFor(await issuer.sign(goodClaims({ iat: NOW_S + 60 })))).toBe('ok');
  });
});

// RFC 8725's known attacks, each of which has worked against a real library.
describe('known attacks', () => {
  it('refuses alg: none', async () => {
    const token = `${encodeJson({ alg: 'none', kid: 'key-1' })}.${encodeJson(goodClaims())}.`;
    expect(await reasonFor(token)).toBe('alg');
  });

  // The classic: sign with HS256, using the issuer's public key as the shared secret.
  it('refuses HS256', async () => {
    const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(JSON.stringify(issuer.jwk)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signingInput = `${encodeJson({ alg: 'HS256', kid: 'key-1' })}.${encodeJson(goodClaims())}`;
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(signingInput)));
    expect(await reasonFor(`${signingInput}.${base64Url(signature)}`)).toBe('alg');
  });

  it.each([['jku'], ['x5u'], ['jwk'], ['x5c'], ['crit']])('refuses a token that chooses its own key or rules with %s', async (name) => {
    expect(await reasonFor(await issuer.sign(goodClaims(), { [name]: 'https://attacker.test/keys' }))).toBe('header');
  });

  it('refuses a token signed by someone else with the same kid', async () => {
    const attacker = await createIssuer('ES256');
    expect(await reasonFor(await attacker.sign(goodClaims()))).toBe('signature');
  });

  it('refuses a changed payload', async () => {
    const token = await issuer.sign(goodClaims());
    const [header, , signature] = token.split('.');
    const changed = `${header ?? ''}.${encodeJson(goodClaims({ sub: 'admin' }))}.${signature ?? ''}`;
    expect(await reasonFor(changed)).toBe('signature');
  });

  it('refuses a key shorter than 2048 bits', async () => {
    const weak = await createIssuer('RS256', { modulusLength: 1024 });
    expect(await reasonFor(await weak.sign(goodClaims()), { keys: [weak.jwk] })).toBe('weak_key');
  });

  it('refuses a claim named twice, which two readers could take differently', async () => {
    const header = encodeJson({ alg: 'ES256', kid: 'key-1' });
    const claims = JSON.stringify(goodClaims()).replace('{', '{"sub":"admin",');
    const part = base64Url(new TextEncoder().encode(claims));
    expect(await reasonFor(await issuer.signRaw(header, part))).toBe('malformed');
  });

  it('still reads a repeated name in two separate objects, and nested values', async () => {
    const header = encodeJson({ alg: 'ES256', kid: 'key-1' });
    const nested = goodClaims({ a: { x: 1 }, b: { x: 2 }, list: [{ x: 1 }, { x: 2 }, 'x\\"y'], 'esc"aped': true });
    expect(await reasonFor(await issuer.signRaw(header, encodeJson(nested)))).toBe('ok');
  });

  it('refuses a repeated name written differently', async () => {
    const header = encodeJson({ alg: 'ES256', kid: 'key-1' });
    const claims = JSON.stringify(goodClaims()).replace('{', '{"s\\u0075b":"admin",');
    expect(await reasonFor(await issuer.signRaw(header, base64Url(new TextEncoder().encode(claims))))).toBe('malformed');
  });
});

describe('the wrong claims', () => {
  it.each([
    ['another issuer', { iss: 'https://evil.test/' }, 'iss'],
    ['no issuer', { iss: undefined }, 'iss'],
    ['another audience', { aud: 'https://other.test' }, 'aud'],
    ['no audience', { aud: undefined }, 'aud'],
    ['an audience that isn\'t a string or list', { aud: 5 }, 'aud'],
    ['expired', { exp: NOW_S - 61 }, 'exp'],
    ['no expiry', { exp: undefined }, 'exp'],
    ['an expiry that isn\'t a number', { exp: 'tomorrow' }, 'exp'],
    ['not valid yet', { nbf: NOW_S + 61 }, 'nbf'],
    ['an nbf that isn\'t a number', { nbf: 'soon' }, 'nbf'],
    ['issued far in the future', { iat: NOW_S + 301 }, 'iat'],
    ['an iat that isn\'t a number', { iat: 'now' }, 'iat'],
    ['no subject', { sub: undefined }, 'sub'],
    ['an empty subject', { sub: '' }, 'sub'],
    ['a subject that isn\'t a string', { sub: 5 }, 'sub'],
  ])('refuses %s', async (_name, change, reason) => {
    expect(await reasonFor(await issuer.sign(goodClaims(change)))).toBe(reason);
  });
});

describe('the shape of a token', () => {
  it.each([
    ['empty', ''],
    ['one part', 'abc'],
    ['two parts', 'abc.def'],
    ['four parts', 'a.b.c.d'],
    ['an empty header', '.b.c'],
    ['an empty payload', 'a..c'],
    ['bad characters', 'a$.b.c'],
    ['an impossible length', 'abcde.b.c'],
    ['stray bits', `${encodeJson({ alg: 'ES256' })}.ab.c`],
  ])('refuses %s', async (_name, token) => {
    expect(await reasonFor(token)).toBe('malformed');
  });

  it('refuses a header that isn\'t a JSON object', async () => {
    const claims = encodeJson(goodClaims());
    expect(await reasonFor(`${encodeJson([1])}.${claims}.c`)).toBe('malformed');
    expect(await reasonFor(`${base64Url(new TextEncoder().encode('{nope'))}.${claims}.c`)).toBe('malformed');
  });

  it('refuses text that isn\'t UTF-8', async () => {
    const part = base64Url(new Uint8Array([0xff, 0xfe]));
    expect(await reasonFor(`${part}.${encodeJson(goodClaims())}.c`)).toBe('malformed');
  });

  it('refuses a token over the cap before doing any work', async () => {
    expect(await reasonFor('a'.repeat(MAX_JWT_BYTES + 1))).toBe('too_large');
  });

  it('refuses an ES256 signature of the wrong length', async () => {
    const token = await issuer.sign(goodClaims());
    const shorter = `${token.split('.').slice(0, 2).join('.')}.${base64Url(new Uint8Array(32))}`;
    expect(await reasonFor(shorter)).toBe('signature');
  });
});

describe('choosing a key', () => {
  it('refuses an unknown kid', async () => {
    expect(await reasonFor(await issuer.sign(goodClaims(), { kid: 'other' }))).toBe('no_key');
  });

  it('refuses a missing kid when the issuer has several keys', async () => {
    const other = await createIssuer('ES256', { kid: 'key-2' });
    const token = await issuer.signRaw(encodeJson({ alg: 'ES256' }), encodeJson(goodClaims()));
    expect(await reasonFor(token, { keys: [issuer.jwk, other.jwk] })).toBe('no_key');
  });

  it('skips keys marked for another algorithm or for encryption', async () => {
    const token = await issuer.sign(goodClaims());
    expect(await reasonFor(token, { keys: [{ ...issuer.jwk, alg: 'RS256' }] })).toBe('no_key');
    expect(await reasonFor(token, { keys: [{ ...issuer.jwk, use: 'enc' }] })).toBe('no_key');
    expect(await reasonFor(token, { keys: [{ ...issuer.jwk, crv: 'P-384' }] })).toBe('no_key');
    expect(await reasonFor(token, { keys: [{ ...issuer.jwk, kty: 'RSA' }] })).toBe('no_key');
  });

  it('accepts a key that names the right algorithm', async () => {
    expect(await reasonFor(await issuer.sign(goodClaims()), { keys: [{ ...issuer.jwk, alg: 'ES256' }] })).toBe('ok');
  });

  it('treats a key that won\'t import as a bad signature', async () => {
    const token = await issuer.sign(goodClaims());
    expect(await reasonFor(token, { keys: [{ ...issuer.jwk, x: 'AAAA', y: 'AAAA' }] })).toBe('signature');
  });

  it('refuses an RSA key with no modulus as weak', async () => {
    const own = await createIssuer('RS256');
    const noModulus = { ...own.jwk };
    delete noModulus.n;
    expect(await reasonFor(await own.sign(goodClaims()), { keys: [noModulus] })).toBe('weak_key');
  });

  // jose.ts read jwks.keys.length without checking. Latitude 10 validates the document first,
  // so it isn't reachable there. It could be here.
  it.each([
    ['no keys field', {}],
    ['keys that aren\'t a list', { keys: 'nope' }],
    ['null', null],
    ['an empty list', { keys: [] }],
  ])('doesn\'t crash on a key set with %s', async (_name, broken) => {
    const token = await issuer.signRaw(encodeJson({ alg: 'ES256' }), encodeJson(goodClaims()));
    expect(await reasonFor(token, broken as unknown as Jwks)).toBe('no_key');
  });

  it('doesn\'t crash on junk inside the list', async () => {
    const token = await issuer.sign(goodClaims());
    expect(await reasonFor(token, { keys: [null, 5, 'x', issuer.jwk] } as unknown as Jwks)).toBe('ok');
  });
});

describe('the access token type', () => {
  const strict = { ...EXPECT, requireAccessTokenType: true };

  it('is ignored unless asked for', async () => {
    expect(await reasonFor(await issuer.sign(goodClaims(), { typ: 'JWT' }))).toBe('ok');
  });

  it.each([['at+jwt'], ['application/at+jwt'], ['at+JWT'], ['Application/AT+JWT']])('accepts %s when asked for', async (typ) => {
    expect(await reasonFor(await issuer.sign(goodClaims(), { typ }), jwks, strict)).toBe('ok');
  });

  it.each([['JWT'], [undefined], [5]])('refuses %s when asked for', async (typ) => {
    expect(await reasonFor(await issuer.sign(goodClaims(), { typ }), jwks, strict)).toBe('typ');
  });
});
