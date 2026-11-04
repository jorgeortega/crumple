import { describe, expect, it } from 'vitest';
import { AUDIENCE, createIssuer, goodClaims, ISSUER, NOW_S } from '../../tests/helpers/issuer.js';
import { createExecutor, type Operation } from '../executor/index.js';
import { createFaultApi, DEFAULT_CREDENTIAL } from '../fault-api/index.js';
import { createAudit, createTelemetry, memorySink } from '../telemetry/index.js';
import { createAccessControl, createKey, memoryKeyStore, sealCredential, sealedCredential } from './index.js';

// C3, proved from where it counts: fault-api records every header it receives, so this looks at
// what really arrived rather than at what the code meant to send. Written the way mcp-surface
// will wire these together, since this module can't import the executor itself.

const GET_CUSTOMER: Operation = {
  name: 'get_customer',
  method: 'GET',
  path: '/customers/{id}',
  params: [{ name: 'id', arg: 'id', in: 'path' }],
  retry: 'safe',
  expectsJson: true,
};

async function setup() {
  const sealKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const aad = 'upstream:main';
  const sealed = await sealCredential(`Bearer ${DEFAULT_CREDENTIAL}`, sealKey, aad);

  const issuer = await createIssuer('ES256');
  const api = createFaultApi();
  const spans = memorySink();
  const telemetry = createTelemetry({ sinks: [spans], strict: true, now: () => NOW_S * 1000 });
  const keys = memoryKeyStore();
  const access = createAccessControl({
    keys,
    telemetry,
    audit: createAudit(telemetry, []),
    now: () => NOW_S * 1000,
    fetch: () => Promise.resolve(new Response(JSON.stringify({ keys: [issuer.jwk] }))),
    jwt: {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: 'https://login.example.test/jwks.json',
      resource: AUDIENCE,
      scopes: { read: [{ tool: 'get_customer' }] },
    },
  });
  const executor = createExecutor({
    baseUrl: 'http://fault-api.test',
    getCredential: sealedCredential({ kind: 'header', name: 'authorization', sealed, key: sealKey, aad }),
    telemetry,
    fetch: (request) => api.fetch(request),
  });

  async function call(token: string) {
    const who = await access.authenticate(`Bearer ${token}`);
    if (!who.ok) throw new Error('expected a sign-in');
    expect(access.authorize(who.principal, { name: 'get_customer', writes: false })).toMatchObject({ allow: true });
    return executor.call(GET_CUSTOMER, { id: 'cus_1' }, { caller: who.principal.id });
  }

  return { access, api, call, issuer, keys, spans };
}

describe('the agent\'s token', () => {
  it('as an API key, never reaches the upstream', async () => {
    const { api, call, keys } = await setup();
    const { key } = await createKey(keys, { label: 'agent', grants: [{ tool: 'get_customer' }] });

    expect(await call(key)).toMatchObject({ ok: true, status: 200 });

    const [request] = api.requests();
    expect(request?.headers.authorization).toBe(`Bearer ${DEFAULT_CREDENTIAL}`);
    expect(JSON.stringify(api.requests())).not.toContain(key);
  });

  it('as a JWT, never reaches the upstream', async () => {
    const { api, call, issuer } = await setup();
    const token = await issuer.sign(goodClaims({ scope: 'read' }));

    expect(await call(token)).toMatchObject({ ok: true, status: 200 });

    const [request] = api.requests();
    expect(request?.headers.authorization).toBe(`Bearer ${DEFAULT_CREDENTIAL}`);
    expect(JSON.stringify(api.requests())).not.toContain(token);
  });

  it('doesn\'t appear in any span either', async () => {
    const { call, keys, spans } = await setup();
    const { key } = await createKey(keys, { label: 'agent', grants: [{ tool: 'get_customer' }] });
    await call(key);
    expect(spans.spans().length).toBeGreaterThan(1);
    expect(JSON.stringify(spans.spans())).not.toContain(key);
  });
});
