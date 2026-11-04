import { beforeAll, describe, expect, it } from 'vitest';
import { AUDIENCE, createIssuer, goodClaims, ISSUER, NOW_S, type PublicJwk, type TestIssuer } from '../../tests/helpers/issuer.js';
import { createAudit, createTelemetry, memoryAuditSink, memorySink } from '../telemetry/index.js';
import { callerId, createAccessControl, type JwtConfig } from './authenticate.js';
import { createKey, memoryKeyStore } from './keys.js';

const JWKS_URI = 'https://login.example.test/jwks.json';
const METADATA_URL = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp';
const READ = { name: 'get_customer', writes: false };
const LIST = { name: 'list_customers', writes: false };
const WRITE = { name: 'create_payment', writes: true };

const CONFIG: JwtConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksUri: JWKS_URI,
  resource: AUDIENCE,
  scopes: {
    'customers:read': [{ tool: 'get_customer' }, { tool: 'list_customers' }],
    'payments:write': [{ tool: 'create_payment', writes: true }],
  },
};

let issuer: TestIssuer;

beforeAll(async () => {
  issuer = await createIssuer('ES256');
});

function setup(options: { jwt?: Partial<JwtConfig>; jwks?: () => Response | Promise<Response> } = {}) {
  const fetched: string[] = [];
  const spans = memorySink();
  const records = memoryAuditSink();
  const telemetry = createTelemetry({ sinks: [spans], now: () => NOW_S * 1000, strict: true });
  const keys = memoryKeyStore();
  const access = createAccessControl({
    keys,
    jwt: { ...CONFIG, ...options.jwt },
    telemetry,
    audit: createAudit(telemetry, [records]),
    now: () => NOW_S * 1000,
    fetch: (input) => {
      fetched.push(input as string);
      return Promise.resolve((options.jwks ?? (() => jwksResponse([issuer.jwk])))());
    },
  });
  return { access, fetched, keys, records, spans };
}

const jwksResponse = (keys: PublicJwk[]): Response => new Response(JSON.stringify({ keys }));

async function signIn(claims: Record<string, unknown> = goodClaims({ scope: 'customers:read' })) {
  const context = setup();
  const who = await context.access.authenticate(`Bearer ${await issuer.sign(claims)}`);
  if (!who.ok) throw new Error('expected a sign-in');
  return { ...context, principal: who.principal };
}

describe('a valid token', () => {
  it('becomes a principal with the grants its scopes map to', async () => {
    const { principal } = await signIn(goodClaims({ scope: 'customers:read payments:write' }));
    expect(principal.kind).toBe('jwt');
    expect(principal.grants).toEqual([{ tool: 'get_customer' }, { tool: 'list_customers' }, { tool: 'create_payment', writes: true }]);
  });

  it('checks its permissions through the same policy as a key', async () => {
    const { access, principal } = await signIn();
    expect(access.authorize(principal, READ)).toMatchObject({ allow: true });
    expect(access.authorize(principal, WRITE)).toMatchObject({ allow: false, reason: 'no_grant' });
    expect(access.visible(principal, [READ, LIST, WRITE])).toEqual([READ, LIST]);
  });

  // The decision the owner approved: a sub is often an email address.
  it('appears as a hash, and the person\'s name goes nowhere', async () => {
    const { access, principal, records, spans } = await signIn();
    access.authorize(principal, READ);
    expect(principal.id).toBe(await callerId(ISSUER, 'person@example.test'));
    expect(principal.id).toMatch(/^jwt_[0-9a-f]{16}$/);
    expect(JSON.stringify([principal, records.events(), spans.spans()])).not.toContain('person@example.test');
  });

  it('has a different id under a different issuer', async () => {
    expect(await callerId('https://a.test/', 'x')).not.toBe(await callerId('https://b.test/', 'x'));
  });

  it('leaves no token on the principal', async () => {
    const context = setup();
    const token = await issuer.sign(goodClaims({ scope: 'customers:read' }));
    const who = await context.access.authenticate(`Bearer ${token}`);
    expect(JSON.stringify(who)).not.toContain(token);
    expect(JSON.stringify(context.spans.spans())).not.toContain(token);
  });
});

describe('scopes', () => {
  it.each([
    ['a scope nobody mapped', { scope: 'admin:everything' }, []],
    ['no scope at all', {}, []],
    ['a scope that isn\'t a string', { scope: 5 }, []],
    // An object's prototype would be found by a plain lookup, and would then crash.
    ['the scope __proto__', { scope: '__proto__ constructor' }, []],
  ])('grants nothing for %s', async (_name, extra, grants) => {
    const { principal } = await signIn(goodClaims(extra));
    expect(principal.grants).toEqual(grants);
  });

  it('shows an empty list to a token with no mapped scopes', async () => {
    const { access, principal } = await signIn(goodClaims({ scope: 'other' }));
    expect(access.visible(principal, [READ, WRITE])).toEqual([]);
  });

  it.each([
    ['scp as a string', { scp: 'customers:read' }],
    ['scp as a list', { scp: ['customers:read', 5] }],
    ['extra spaces', { scope: '  customers:read  ' }],
    ['the same scope twice', { scope: 'customers:read', scp: 'customers:read' }],
  ])('reads %s', async (_name, extra) => {
    const { principal } = await signIn(goodClaims(extra));
    expect(principal.grants).toEqual(CONFIG.scopes['customers:read']);
  });

  it('refuses a config that would grant * with writes', () => {
    expect(() => setup({ jwt: { scopes: { all: [{ tool: '*', writes: true }] } } })).toThrow(/Scope all/);
  });

  it('says which scopes would allow a tool', () => {
    const { access } = setup();
    expect(access.scopesFor(WRITE)).toEqual(['payments:write']);
    expect(access.scopesFor(READ)).toEqual(['customers:read']);
    expect(access.scopesFor({ name: 'other', writes: false })).toEqual([]);
  });
});

describe('a bad token', () => {
  it.each([
    ['another audience', { aud: 'https://other.test' }, 'aud'],
    ['another issuer', { iss: 'https://evil.test/' }, 'iss'],
    ['expired', { exp: NOW_S - 120 }, 'exp'],
  ])('is refused for %s, and only the audit log knows why', async (_name, change, reason) => {
    const { access, records } = setup();
    const answer = await access.authenticate(`Bearer ${await issuer.sign(goodClaims(change))}`);
    expect(answer).toEqual({ ok: false, status: 401, challenge: `Bearer error="invalid_token", resource_metadata="${METADATA_URL}"` });
    expect(records.events()[0]).toMatchObject({ decision: 'deny', reason });
  });

  it('is refused for junk', async () => {
    const { access } = setup();
    expect(await access.authenticate('Bearer junk')).toMatchObject({ ok: false, status: 401 });
  });

  it('is refused when the token type is required and missing', async () => {
    const { access } = setup({ jwt: { requireAccessTokenType: true } });
    const answer = await access.authenticate(`Bearer ${await issuer.sign(goodClaims())}`);
    expect(answer).toMatchObject({ ok: false, status: 401 });
  });

  it('passes when the token type is required and right', async () => {
    const { access } = setup({ jwt: { requireAccessTokenType: true } });
    const answer = await access.authenticate(`Bearer ${await issuer.sign(goodClaims(), { typ: 'at+jwt' })}`);
    expect(answer).toMatchObject({ ok: true });
  });
});

describe('keys and tokens together', () => {
  it('still takes an API key when an issuer is configured', async () => {
    const { access, keys } = setup();
    const { id, key } = await createKey(keys, { label: 'a', grants: [] });
    expect(await access.authenticate(`Bearer ${key}`)).toMatchObject({ ok: true, principal: { id, kind: 'key' } });
  });

  it('never tries a bad key as a token', async () => {
    const { access, fetched } = setup();
    await access.authenticate(`Bearer crumple_${'a'.repeat(43)}`);
    expect(fetched).toEqual([]);
  });

  it('points a caller with no credentials at the metadata', async () => {
    const { access } = setup();
    expect(await access.authenticate(null)).toEqual({ ok: false, status: 401, challenge: `Bearer resource_metadata="${METADATA_URL}"` });
  });
});

describe('when the issuer rotates its keys', () => {
  it('fetches again for an unknown key id, and accepts the new key', async () => {
    const rotated = await createIssuer('ES256', { kid: 'key-2' });
    const responses = [jwksResponse([issuer.jwk]), jwksResponse([rotated.jwk])];
    const { access, fetched } = setup({ jwks: () => responses.shift() ?? new Response('', { status: 500 }) });

    expect(await access.authenticate(`Bearer ${await issuer.sign(goodClaims())}`)).toMatchObject({ ok: true });
    expect(await access.authenticate(`Bearer ${await rotated.sign(goodClaims())}`)).toMatchObject({ ok: true });
    expect(fetched).toHaveLength(2);
  });

  it('refuses a key id that\'s still unknown after fetching again', async () => {
    const stranger = await createIssuer('ES256', { kid: 'key-9' });
    const { access } = setup();
    expect(await access.authenticate(`Bearer ${await stranger.sign(goodClaims())}`)).toMatchObject({ ok: false, status: 401 });
  });
});

// A 401 would send a person to log in again over a problem that's ours.
describe('when the issuer can\'t be reached', () => {
  it('says 503, never 401 and never allowed, when it has no keys at all', async () => {
    const { access, records } = setup({ jwks: () => new Response('down', { status: 500 }) });
    expect(await access.authenticate(`Bearer ${await issuer.sign(goodClaims())}`)).toEqual({ ok: false, status: 503 });
    expect(records.events()[0]?.reason).toBe('unavailable');
  });
});

describe('Protected Resource Metadata', () => {
  it('describes the server, at the address RFC 9728 gives', () => {
    expect(setup().access.resourceMetadata()).toEqual({
      url: METADATA_URL,
      document: {
        resource: AUDIENCE,
        authorization_servers: [ISSUER],
        scopes_supported: ['customers:read', 'payments:write'],
        bearer_methods_supported: ['header'],
      },
    });
  });

  it('handles a server at the root', () => {
    const { access } = setup({ jwt: { resource: 'https://mcp.example.test/' } });
    expect(access.resourceMetadata()?.url).toBe('https://mcp.example.test/.well-known/oauth-protected-resource');
  });

  it('isn\'t there with API keys alone', () => {
    const telemetry = createTelemetry();
    const access = createAccessControl({ telemetry, audit: createAudit(telemetry, []) });
    expect(access.resourceMetadata()).toBeUndefined();
    expect(access.scopesFor(READ)).toEqual([]);
  });
});
