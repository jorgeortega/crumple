import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createFaultApi, DEFAULT_CREDENTIAL } from '../fault-api/index.js';
import { createExecutor, type Operation } from '../executor/index.js';
import { createTelemetry, memorySink } from '../telemetry/index.js';
import { CREDENTIAL_UNAVAILABLE, plainCredential, sealCredential, sealedCredential } from './credential.js';

const newKey = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const AAD = 'upstream:main';
const SECRET = 'Bearer s3cret-upstream-value';

const flipFirstByte = (base64: string): string => {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return btoa(String.fromCharCode(...bytes));
};

describe('sealing', () => {
  it('opens with the right key and purpose', async () => {
    const key = newKey();
    const sealed = await sealCredential(SECRET, key, AAD);
    const credential = await sealedCredential({ kind: 'header', name: 'authorization', sealed, key, aad: AAD })();
    expect(credential).toMatchObject({ kind: 'header', name: 'authorization', value: SECRET });
  });

  it('doesn\'t contain the secret in its sealed form', async () => {
    const sealed = await sealCredential(SECRET, newKey(), AAD);
    expect(JSON.stringify(sealed)).not.toContain('s3cret');
  });

  it('uses a fresh IV every time, so the same secret never looks the same', async () => {
    const key = newKey();
    const [first, second] = await Promise.all([sealCredential(SECRET, key, AAD), sealCredential(SECRET, key, AAD)]);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('refuses to seal nothing', async () => {
    await expect(sealCredential('', newKey(), AAD)).rejects.toThrow(CREDENTIAL_UNAVAILABLE);
  });

  it('refuses to seal with a key of the wrong length', async () => {
    await expect(sealCredential(SECRET, btoa('short'), AAD)).rejects.toThrow(CREDENTIAL_UNAVAILABLE);
    await expect(sealCredential(SECRET, 'not base64!', AAD)).rejects.toThrow(CREDENTIAL_UNAVAILABLE);
  });

  it.each([
    ['the wrong key', async (key: string) => ({ sealed: await sealCredential(SECRET, key, AAD), key: newKey(), aad: AAD })],
    ['the wrong purpose', async (key: string) => ({ sealed: await sealCredential(SECRET, key, 'upstream:other'), key, aad: AAD })],
    ['a flipped byte', async (key: string) => {
      const sealed = await sealCredential(SECRET, key, AAD);
      return { sealed: { ...sealed, ciphertext: flipFirstByte(sealed.ciphertext) }, key, aad: AAD };
    }],
    ['a flipped IV', async (key: string) => {
      const sealed = await sealCredential(SECRET, key, AAD);
      return { sealed: { ...sealed, iv: flipFirstByte(sealed.iv) }, key, aad: AAD };
    }],
    ['a broken key', async (key: string) => ({ sealed: await sealCredential(SECRET, key, AAD), key: 'not base64!', aad: AAD })],
  ])('won\'t open with %s, and says only that', async (_name, make) => {
    const { sealed, key, aad } = await make(newKey());
    await expect(sealedCredential({ kind: 'header', name: 'authorization', sealed, key, aad })()).rejects.toThrow(CREDENTIAL_UNAVAILABLE);
  });
});

describe('rotation', () => {
  it('opens a value sealed under the previous key', async () => {
    const [oldKey, newOne] = [newKey(), newKey()];
    const sealed = await sealCredential(SECRET, oldKey, AAD);
    const credential = await sealedCredential({ kind: 'header', name: 'x', sealed, key: newOne, previousKey: oldKey, aad: AAD })();
    expect(credential).toMatchObject({ value: SECRET });
  });

  it('still prefers the current key', async () => {
    const key = newKey();
    const sealed = await sealCredential(SECRET, key, AAD);
    expect(await sealedCredential({ kind: 'header', name: 'x', sealed, key, previousKey: newKey(), aad: AAD })()).toMatchObject({ value: SECRET });
  });

  it('won\'t open when neither key fits', async () => {
    const sealed = await sealCredential(SECRET, newKey(), AAD);
    await expect(sealedCredential({ kind: 'header', name: 'x', sealed, key: newKey(), previousKey: newKey(), aad: AAD })()).rejects.toThrow(CREDENTIAL_UNAVAILABLE);
  });
});

// C4: the ways a value usually escapes.
describe('an opened credential', () => {
  const ways = async () => {
    const key = newKey();
    const sealed = await sealCredential(SECRET, key, AAD);
    return [
      await sealedCredential({ kind: 'query', name: 'api_key', sealed, key, aad: AAD })(),
      await plainCredential('query', 'api_key', SECRET)(),
    ];
  };

  it('can be read directly, because the request needs it', async () => {
    for (const credential of await ways()) expect(credential).toHaveProperty('value', SECRET);
  });

  it('stays out of JSON', async () => {
    for (const credential of await ways()) {
      expect(JSON.stringify(credential)).toBe('{"kind":"query","name":"api_key"}');
      expect(JSON.stringify({ nested: [credential] })).not.toContain('s3cret');
    }
  });

  it('stays out of logs', async () => {
    for (const credential of await ways()) {
      expect(inspect(credential)).not.toContain('s3cret');
      expect(inspect({ nested: credential }, { depth: 5, showHidden: false })).not.toContain('s3cret');
    }
  });

  it('stays out of a spread', async () => {
    for (const credential of await ways()) expect({ ...credential }).toEqual({ kind: 'query', name: 'api_key' });
  });

  it('can\'t be overwritten', async () => {
    const [credential] = await ways();
    expect(() => {
      Object.assign(credential ?? {}, { value: 'other' });
    }).toThrow(TypeError);
  });
});

describe('plainCredential', () => {
  it('supports an API that needs no credential', async () => {
    expect(await plainCredential('none')()).toEqual({ kind: 'none' });
  });
});

const GET_CUSTOMER: Operation = {
  name: 'get_customer',
  method: 'GET',
  path: '/customers/{id}',
  params: [{ name: 'id', arg: 'id', in: 'path' }],
  retry: 'safe',
  expectsJson: true,
};

describe('with the executor and fault-api', () => {
  async function run(fault: string) {
    const key = newKey();
    const sealed = await sealCredential(`Bearer ${DEFAULT_CREDENTIAL}`, key, AAD);
    const api = createFaultApi();
    const spans = memorySink();
    const executor = createExecutor({
      baseUrl: 'http://fault-api.test',
      getCredential: sealedCredential({ kind: 'header', name: 'authorization', sealed, key, aad: AAD }),
      headers: { 'x-fault': fault },
      telemetry: createTelemetry({ sinks: [spans], strict: true }),
      fetch: (request) => api.fetch(request),
    });
    const outcome = await executor.call(GET_CUSTOMER, { id: 'cus_1' }, { caller: 'key_1' });
    return { api, outcome, spans };
  }

  it('reaches the API through the same request path', async () => {
    const { outcome } = await run('');
    expect(outcome).toMatchObject({ ok: true, status: 200 });
  });

  // C4 end to end at module level: an API that repeats the credential gets nowhere.
  it('stays out of the result and the trace when the API echoes it', async () => {
    const { outcome, spans } = await run('echo-auth');
    expect(JSON.stringify(outcome)).not.toContain(DEFAULT_CREDENTIAL);
    expect(JSON.stringify(spans.spans())).not.toContain(DEFAULT_CREDENTIAL);
  });

  it('sends nothing when the credential can\'t be opened', async () => {
    const api = createFaultApi();
    const sealed = await sealCredential('value', newKey(), AAD);
    const executor = createExecutor({
      baseUrl: 'http://fault-api.test',
      getCredential: sealedCredential({ kind: 'header', name: 'authorization', sealed, key: newKey(), aad: AAD }),
      telemetry: createTelemetry(),
      fetch: (request) => api.fetch(request),
    });
    const outcome = await executor.call(GET_CUSTOMER, { id: 'cus_1' }, { caller: 'key_1' });
    expect(outcome.ok).toBe(false);
    expect(api.requests()).toHaveLength(0);
  });
});
