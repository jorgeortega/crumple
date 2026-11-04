import { describe, expect, it } from 'vitest';
import { createKey, type KeyStore } from '../../src/access-control/index.js';
import type { AuditEvent, AuditSink } from '../../src/telemetry/index.js';

// One set of tests for every backend. This is what stops "works in memory, breaks in production":
// a new store passes these or it doesn't exist.

const hashOf = async (store: KeyStore, id: string): Promise<string> => {
  const record = (await store.list()).find((candidate) => candidate.id === id);
  if (!record) throw new Error('expected a record');
  return record.hash;
};

export function keyStoreContract(name: string, make: () => KeyStore): void {
  describe(`${name}: the key store contract`, () => {
    it('finds a key by its hash, with everything it was given', async () => {
      const store = make();
      const { id } = await createKey(store, { label: 'ci', grants: [{ tool: '*' }, { tool: 'pay', writes: true }] }, () => 1_000);
      const found = await store.findByHash(await hashOf(store, id));
      expect(found).toMatchObject({ id, label: 'ci', createdAt: 1_000, grants: [{ tool: '*' }, { tool: 'pay', writes: true }] });
      expect(found?.shown).toMatch(/^crumple_/);
      expect(found?.revokedAt).toBeUndefined();
    });

    it('finds nothing for a hash it doesn\'t have', async () => {
      expect(await make().findByHash('nope')).toBeUndefined();
    });

    it('never holds the key itself', async () => {
      const store = make();
      const { key } = await createKey(store, { label: 'a', grants: [] });
      expect(JSON.stringify(await store.list())).not.toContain(key);
    });

    it('lists every key, revoked ones included', async () => {
      const store = make();
      const first = await createKey(store, { label: 'a', grants: [] });
      const second = await createKey(store, { label: 'b', grants: [] });
      await store.revoke(first.id, 5);
      const records = await store.list();
      expect(records.map((record) => record.id).sort()).toEqual([first.id, second.id].sort());
    });

    it('starts empty', async () => {
      expect(await make().list()).toEqual([]);
    });

    it('revokes once, and says whether it did', async () => {
      const store = make();
      const { id } = await createKey(store, { label: 'a', grants: [] });
      const hash = await hashOf(store, id);
      expect(await store.revoke(id, 5)).toBe(true);
      expect(await store.revoke(id, 6)).toBe(false);
      expect(await store.revoke('key_missing', 6)).toBe(false);
      expect((await store.findByHash(hash))?.revokedAt).toBe(5);
    });

    it('hands out copies, so a caller can\'t change a stored grant', async () => {
      const store = make();
      const { id } = await createKey(store, { label: 'a', grants: [{ tool: 'a' }] });
      const hash = await hashOf(store, id);
      const found = await store.findByHash(hash);
      (found?.grants as { tool: string }[]).push({ tool: '*' });
      expect((await store.findByHash(hash))?.grants).toEqual([{ tool: 'a' }]);
    });

    it('keeps odd text intact, and treats it as data', async () => {
      const store = make();
      const label = 'Robert\'); DROP TABLE keys;-- "quoted" ñ';
      const { id } = await createKey(store, { label, grants: [{ tool: 'it\'s' }] });
      const found = await store.findByHash(await hashOf(store, id));
      expect(found).toMatchObject({ label, grants: [{ tool: 'it\'s' }] });
    });
  });
}

/** An audit sink that can read back what it holds, and keeps at most `capacity` events. */
export interface ReadableAuditSink extends AuditSink {
  events(): AuditEvent[];
  dropped(): number;
}

const event = (n: number, more: Partial<AuditEvent> = {}): AuditEvent => ({ at: n, caller: `key_${String(n)}`, tool: 'get', decision: 'allow', ...more });

export function auditSinkContract(name: string, make: (capacity: number) => ReadableAuditSink): void {
  describe(`${name}: the audit sink contract`, () => {
    it('gives events back in order, with every field', () => {
      const sink = make(10);
      sink.write(event(1, { traceId: 'abc' }));
      sink.write(event(2, { decision: 'deny', reason: 'no_grant' }));
      expect(sink.events()).toEqual([
        { at: 1, caller: 'key_1', tool: 'get', decision: 'allow', traceId: 'abc' },
        { at: 2, caller: 'key_2', tool: 'get', decision: 'deny', reason: 'no_grant' },
      ]);
    });

    it('starts empty', () => {
      expect(make(10).events()).toEqual([]);
    });

    it('drops the oldest past its capacity, and counts them', () => {
      const sink = make(2);
      for (const n of [1, 2, 3, 4, 5]) sink.write(event(n));
      expect(sink.events().map((held) => held.at)).toEqual([4, 5]);
      expect(sink.dropped()).toBe(3);
    });

    it('keeps odd text intact, and treats it as data', () => {
      const sink = make(10);
      const tool = 'x\'); DROP TABLE audit;-- "q"';
      sink.write(event(1, { tool }));
      expect(sink.events()[0]?.tool).toBe(tool);
    });
  });
}
