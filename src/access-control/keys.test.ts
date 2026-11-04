import { describe, expect, it } from 'vitest';
import { createKey, hashKey, isKeyShaped, memoryKeyStore, parseBearer, sha256Hex } from './keys.js';

describe('createKey', () => {
  it('stores only the hash, and returns the key this one time', async () => {
    const store = memoryKeyStore();
    const { id, key } = await createKey(store, { label: 'ci', grants: [{ tool: '*' }] }, () => 1_000);

    expect(isKeyShaped(key)).toBe(true);
    const [record] = await store.list();
    expect(record).toMatchObject({ id, label: 'ci', createdAt: 1_000, grants: [{ tool: '*' }], hash: await hashKey(key) });
    // The whole store, as a leak would see it.
    expect(JSON.stringify(await store.list())).not.toContain(key);
  });

  it('keeps just enough of the key to tell keys apart', async () => {
    const store = memoryKeyStore();
    const { key } = await createKey(store, { label: 'ci', grants: [] });
    const [record] = await store.list();
    expect(record?.shown).toBe(key.slice(0, 12));
  });

  it('makes a different key and id every time', async () => {
    const store = memoryKeyStore();
    const first = await createKey(store, { label: 'a', grants: [] });
    const second = await createKey(store, { label: 'b', grants: [] });
    expect(first.key).not.toBe(second.key);
    expect(first.id).not.toBe(second.id);
  });

  it('gives an id that says nothing about the key', async () => {
    const { id, key } = await createKey(memoryKeyStore(), { label: 'a', grants: [] });
    expect(key).not.toContain(id.replace('key_', ''));
    expect(id).toMatch(/^key_[0-9a-f]{16}$/);
  });

  it('refuses a grant of * with writes, which could never work', async () => {
    await expect(createKey(memoryKeyStore(), { label: 'a', grants: [{ tool: '*', writes: true }] })).rejects.toThrow(/by name/);
  });
});

describe('the memory store', () => {
  it('finds a key by its hash', async () => {
    const store = memoryKeyStore();
    const { id, key } = await createKey(store, { label: 'a', grants: [] });
    expect((await store.findByHash(await hashKey(key)))?.id).toBe(id);
    expect(await store.findByHash('nope')).toBeUndefined();
  });

  it('revokes once, and says whether it did', async () => {
    const store = memoryKeyStore();
    const { id, key } = await createKey(store, { label: 'a', grants: [] });
    expect(await store.revoke(id, 5)).toBe(true);
    expect(await store.revoke(id, 6)).toBe(false);
    expect(await store.revoke('key_missing', 6)).toBe(false);
    expect((await store.findByHash(await hashKey(key)))?.revokedAt).toBe(5);
  });

  it('hands out copies, so a caller can\'t change a stored grant', async () => {
    const store = memoryKeyStore();
    const { key } = await createKey(store, { label: 'a', grants: [{ tool: 'a' }] });
    const hash = await hashKey(key);
    const found = await store.findByHash(hash);
    (found?.grants as { tool: string }[]).push({ tool: '*' });
    expect((await store.findByHash(hash))?.grants).toEqual([{ tool: 'a' }]);
  });
});

describe('parseBearer', () => {
  it.each([
    ['Bearer abc', 'abc'],
    // HTTP defines the scheme as case-insensitive. The regex lifted from Latitude 10 wasn't.
    ['bearer abc', 'abc'],
    ['BEARER abc', 'abc'],
    ['Bearer   abc', 'abc'],
  ])('reads %j', (header, token) => {
    expect(parseBearer(header)).toBe(token);
  });

  it.each([[null], [''], ['abc'], ['Bearer'], ['Bearer '], ['Basic abc'], ['Bearer a b']])('finds no token in %j', (header) => {
    expect(parseBearer(header)).toBeUndefined();
  });
});

describe('isKeyShaped', () => {
  it('accepts only the exact shape', async () => {
    const { key } = await createKey(memoryKeyStore(), { label: 'a', grants: [] });
    expect(isKeyShaped(key)).toBe(true);
    expect(isKeyShaped(key.slice(0, -1))).toBe(false);
    expect(isKeyShaped(`${key}a`)).toBe(false);
    expect(isKeyShaped(key.replace('crumple_', 'other___'))).toBe(false);
    expect(isKeyShaped(`crumple_${'!'.repeat(43)}`)).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('matches a known value', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
