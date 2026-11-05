import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { auditSinkContract, keyStoreContract } from '../../tests/helpers/store-contract.js';
import { callTool, rpc } from '../../tests/helpers/mcp.js';
import { createFaultApi, DEFAULT_CREDENTIAL, OPENAPI } from '../fault-api/index.js';
import { convertOpenApi, createAudit, createKey, createMcpSurface, createTelemetry, memoryAuditSink, memoryKeyStore, plainCredential } from '../mcp-surface/index.js';
import type { KeyStore } from '../access-control/index.js';
import { openSqliteStore, type SqliteStore } from './index.js';

const folders: string[] = [];
const opened: SqliteStore[] = [];

afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {
      // A test already closed it.
    }
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function tempFile(): string {
  const folder = mkdtempSync(join(tmpdir(), 'crumple-store-'));
  folders.push(folder);
  return join(folder, 'crumple.db');
}

function openStore(path = ':memory:', maxAuditEvents?: number): SqliteStore {
  const store = openSqliteStore(path, maxAuditEvents === undefined ? {} : { maxAuditEvents });
  opened.push(store);
  return store;
}

// The same tests for every backend. D1 will run these too.
keyStoreContract('memory', () => memoryKeyStore());
keyStoreContract('SQLite', () => openStore().keys);
auditSinkContract('memory', (capacity) => memoryAuditSink({ capacity }));
auditSinkContract('SQLite', (capacity) => openStore(':memory:', capacity).audit);

describe('a database file', () => {
  it('keeps keys and audit events across a restart', async () => {
    const path = tempFile();
    const first = openStore(path);
    const { id } = await createKey(first.keys, { label: 'ci', grants: [{ tool: '*' }] });
    first.audit.write({ at: 1, caller: id, tool: 'get', decision: 'allow' });
    first.close();

    const second = openStore(path);
    expect((await second.keys.list()).map((record) => record.id)).toEqual([id]);
    expect(second.audit.events()).toHaveLength(1);
  });

  it('is readable only by its owner, including SQLite\'s extra files', async () => {
    const path = tempFile();
    const store = openStore(path);
    await createKey(store.keys, { label: 'a', grants: [] });
    const modes = [path, `${path}-wal`, `${path}-shm`].filter(existsSync).map((file) => statSync(file).mode & 0o777);
    expect(modes.length).toBeGreaterThan(1);
    expect(modes.every((mode) => mode === 0o600)).toBe(true);
  });

  it('tightens the permissions of a file that already exists', () => {
    const path = tempFile();
    writeFileSync(path, '', { mode: 0o644 });
    openStore(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('says what to do when it can\'t open the file', () => {
    expect(() => openSqliteStore(join(tempFile(), 'no', 'such', 'folder.db'))).toThrow(/Couldn't open the database.*Check that its folder exists/);
  });

  it('refuses a database from a newer version, rather than reading it wrongly', () => {
    const path = tempFile();
    const newer = new DatabaseSync(path);
    newer.exec('PRAGMA user_version = 99');
    newer.close();
    expect(() => openSqliteStore(path)).toThrow(/newer version of Crumple/);
  });

  it('refuses a file that isn\'t a database', () => {
    const path = tempFile();
    writeFileSync(path, 'this is not a database, and it is long enough to have a header');
    expect(() => openSqliteStore(path)).toThrow();
  });

  it('opens an existing database again without losing anything', async () => {
    const path = tempFile();
    const first = openStore(path);
    await createKey(first.keys, { label: 'a', grants: [] });
    first.close();
    expect(await openStore(path).keys.list()).toHaveLength(1);
  });

  it('refuses a second key with the same hash', async () => {
    const { keys } = openStore();
    const record = { id: 'key_1', hash: 'same', shown: 'crumple_abcd', label: 'a', grants: [], createdAt: 1 };
    await keys.add(record);
    await expect(keys.add({ ...record, id: 'key_2' })).rejects.toThrow();
  });
});

describe('the sealed credential', () => {
  const CREDENTIAL = { kind: 'header' as const, name: 'authorization', sealed: { ciphertext: 'c2VhbGVk', iv: 'aXY=' } };

  it('has none until one is set', () => {
    expect(openStore().credential.get()).toBeUndefined();
  });

  it('comes back as it went in, and survives a restart', () => {
    const path = tempFile();
    const first = openStore(path);
    first.credential.set(CREDENTIAL, 1);
    first.close();
    expect(openStore(path).credential.get()).toEqual(CREDENTIAL);
  });

  it('has one at a time, so setting again replaces it', () => {
    const { credential } = openStore();
    credential.set(CREDENTIAL, 1);
    credential.set({ kind: 'query', name: 'api_key', sealed: { ciphertext: 'bmV3', iv: 'aXY=' } }, 2);
    expect(credential.get()).toMatchObject({ kind: 'query', name: 'api_key' });
  });
});

describe('reading the audit log', () => {
  function withEvents() {
    const { audit } = openStore();
    for (const at of [1, 2, 3, 4]) audit.write({ at, caller: 'key_1', tool: 'get', decision: at % 2 === 0 ? 'deny' : 'allow' });
    return audit;
  }

  it('gives the newest events, oldest of them first', () => {
    expect(withEvents().recent({ limit: 2 }).map((event) => event.at)).toEqual([3, 4]);
  });

  it('can show only refusals', () => {
    expect(withEvents().recent({ limit: 10, deniedOnly: true }).map((event) => event.at)).toEqual([2, 4]);
  });
});

describe('failing closed', () => {
  function withStore(keys: KeyStore) {
    const telemetry = createTelemetry();
    return createMcpSurface({
      tools: convertOpenApi(OPENAPI).tools,
      upstream: { baseUrl: 'http://fault-api.test', getCredential: plainCredential('none'), fetch: () => Promise.reject(new Error('should not be called')) },
      access: { keys },
      telemetry,
      audit: createAudit(telemetry, []),
    });
  }

  const TOKEN = `crumple_${'a'.repeat(43)}`;

  it('answers 503, never allowed, when the database has gone', async () => {
    const store = openStore();
    store.close();
    const surface = withStore(store.keys);
    expect((await callTool((request) => surface.fetch(request), 'getCustomer', { id: 'cus_1' }, { token: TOKEN })).status).toBe(503);
  });

  it.each([
    ['grants that aren\'t JSON', 'not json'],
    ['grants that aren\'t a list', '{"tool":"*"}'],
  ])('rejects a lookup with %s', async (_name, grants) => {
    const path = tempFile();
    const store = openStore(path);
    const { id } = await createKey(store.keys, { label: 'a', grants: [] });
    const [record] = await store.keys.list();
    const direct = new DatabaseSync(path);
    direct.prepare('UPDATE keys SET grants = ? WHERE id = ?').run(grants, id);
    direct.close();
    await expect(store.keys.findByHash(record?.hash ?? '')).rejects.toThrow();
  });

  it('lets the call go ahead when saving an audit event fails, and counts it', () => {
    const store = openStore();
    const telemetry = createTelemetry();
    const audit = createAudit(telemetry, [store.audit]);
    store.close();
    audit.record({ caller: 'key_1', tool: 'get', decision: 'allow' });
    expect(audit.failures()).toBe(1);
  });
});

describe('with a real server, across a restart', () => {
  function serve(store: SqliteStore, api: ReturnType<typeof createFaultApi>) {
    const telemetry = createTelemetry();
    const surface = createMcpSurface({
      tools: convertOpenApi(OPENAPI).tools,
      upstream: { baseUrl: 'http://fault-api.test', getCredential: plainCredential('header', 'authorization', `Bearer ${DEFAULT_CREDENTIAL}`), fetch: (request: Request) => api.fetch(request) },
      access: { keys: store.keys },
      telemetry,
      audit: createAudit(telemetry, [store.audit]),
    });
    return (request: Request): Promise<Response> => surface.fetch(request);
  }

  it('a key keeps working, a revoked key stays revoked, and the audit log carries on', async () => {
    const path = tempFile();
    const api = createFaultApi();

    const before = openStore(path);
    const kept = await createKey(before.keys, { label: 'kept', grants: [{ tool: '*' }] });
    const gone = await createKey(before.keys, { label: 'gone', grants: [{ tool: '*' }] });
    const firstServer = serve(before, api);
    expect((await callTool(firstServer, 'getCustomer', { id: 'cus_1' }, { token: kept.key })).status).toBe(200);
    await before.keys.revoke(gone.id, 1);
    before.close();

    const after = openStore(path);
    const secondServer = serve(after, api);
    expect((await rpc(secondServer, 'tools/list', {}, { token: kept.key })).status).toBe(200);
    expect((await callTool(secondServer, 'getCustomer', { id: 'cus_1' }, { token: gone.key })).status).toBe(401);
    await callTool(secondServer, 'deleteCustomer', { id: 'cus_1' }, { token: kept.key });

    expect(after.audit.events().map((event) => [event.tool, event.decision, event.reason])).toEqual([
      ['getCustomer', 'allow', undefined],
      ['-', 'deny', 'revoked_key'],
      ['deleteCustomer', 'deny', 'writes_not_allowed'],
    ]);
  });

  it('keeps no key on disk, only its hash', async () => {
    const path = tempFile();
    const store = openStore(path);
    const { key } = await createKey(store.keys, { label: 'a', grants: [] });
    store.close();
    const direct = new DatabaseSync(path);
    expect(JSON.stringify(direct.prepare('SELECT * FROM keys').all())).not.toContain(key);
    direct.close();
  });
});
