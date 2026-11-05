import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Grant, KeyRecord, KeyStore, Sealed } from '../access-control/index.js';
import type { AuditEvent, AuditSink } from '../telemetry/index.js';

// Keys and audit events in one SQLite file, using the SQLite that comes with Node, so there's
// nothing to install and no native build to fail on a stranger's machine. It's still marked
// experimental and prints a warning when loaded, so only import this when someone asks for a
// database: a first run should never show it.

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_AUDIT_EVENTS = 1_000_000;
const OWNER_ONLY = 0o600;
const IN_MEMORY = ':memory:';
const UPSTREAM = 'upstream';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS keys (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    shown TEXT NOT NULL,
    label TEXT NOT NULL,
    grants TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    caller TEXT NOT NULL,
    tool TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    trace_id TEXT
  );
  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

interface KeyRow {
  id: string;
  hash: string;
  shown: string;
  label: string;
  grants: string;
  created_at: number;
  revoked_at: number | null;
}

interface AuditRow {
  at: number;
  caller: string;
  tool: string;
  decision: 'allow' | 'deny';
  reason: string | null;
  trace_id: string | null;
}

export interface SqliteAuditSink extends AuditSink {
  events(): AuditEvent[];
  /** The newest events, oldest of them first. */
  recent(options: { limit: number; deniedOnly?: boolean }): AuditEvent[];
  dropped(): number;
}

/** The upstream credential, sealed. The key that opens it is never stored here. */
export interface StoredCredential {
  kind: 'header' | 'query';
  name: string;
  sealed: Sealed;
}

export interface CredentialStore {
  get(): StoredCredential | undefined;
  set(credential: StoredCredential, at: number): void;
}

export interface SqliteStore {
  keys: KeyStore;
  audit: SqliteAuditSink;
  credential: CredentialStore;
  close(): void;
}

export interface SqliteStoreOptions {
  /** The newest this many stay, so a flood of bad keys can't fill the disk. */
  maxAuditEvents?: number;
}

function toRecord(row: KeyRow): KeyRecord {
  const grants: unknown = JSON.parse(row.grants);
  // Failing here is failing closed: authenticate turns a failed lookup into a 503, never an allow.
  if (!Array.isArray(grants)) throw new Error('Stored grants aren\'t a list.');
  return {
    id: row.id,
    hash: row.hash,
    shown: row.shown,
    label: row.label,
    grants: grants as Grant[],
    createdAt: row.created_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

function toEvent(row: AuditRow): AuditEvent {
  return {
    at: row.at,
    caller: row.caller,
    tool: row.tool,
    decision: row.decision,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
  };
}

function open(path: string): DatabaseSync {
  try {
    const db = new DatabaseSync(path);
    // Before anything is written, because SQLite's extra files copy this one's permissions.
    if (path !== IN_MEMORY) chmodSync(path, OWNER_ONLY);
    return db;
  } catch (error) {
    throw new Error(`Couldn't open the database at ${path}: ${(error as Error).message}. Check that its folder exists and that you can write to it.`, { cause: error });
  }
}

export function openSqliteStore(path: string, options: SqliteStoreOptions = {}): SqliteStore {
  const { maxAuditEvents = DEFAULT_MAX_AUDIT_EVENTS } = options;
  const db = open(path);

  try {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
    if (version > SCHEMA_VERSION) {
      throw new Error(`The database at ${path} was made by a newer version of Crumple. Update Crumple, or use a different file.`);
    }
    // WAL lets a reader in while a write is happening. NORMAL is the usual pairing with it: a
    // power cut can lose the last few audit events, but can't corrupt the file.
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;${SCHEMA}PRAGMA user_version = ${String(SCHEMA_VERSION)};`);
  } catch (error) {
    db.close();
    throw error;
  }

  // Prepared once, with values always bound, so text is only ever data.
  const insertKey = db.prepare('INSERT INTO keys (id, hash, shown, label, grants, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const keyByHash = db.prepare('SELECT * FROM keys WHERE hash = ?');
  const allKeys = db.prepare('SELECT * FROM keys ORDER BY created_at, id');
  const revokeKey = db.prepare('UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
  const insertEvent = db.prepare('INSERT INTO audit (at, caller, tool, decision, reason, trace_id) VALUES (?, ?, ?, ?, ?, ?)');
  const pruneEvents = db.prepare('DELETE FROM audit WHERE seq <= ?');
  const allEvents = db.prepare('SELECT at, caller, tool, decision, reason, trace_id FROM audit ORDER BY seq');
  const recentEvents = db.prepare('SELECT at, caller, tool, decision, reason, trace_id FROM audit ORDER BY seq DESC LIMIT ?');
  const recentDenied = db.prepare('SELECT at, caller, tool, decision, reason, trace_id FROM audit WHERE decision = \'deny\' ORDER BY seq DESC LIMIT ?');
  const getCredential = db.prepare('SELECT kind, name, ciphertext, iv FROM credentials WHERE id = ?');
  const setCredential = db.prepare('INSERT OR REPLACE INTO credentials (id, kind, name, ciphertext, iv, updated_at) VALUES (?, ?, ?, ?, ?, ?)');

  let dropped = 0;

  // node:sqlite is synchronous, and these promise-shaped wrappers turn its throws into rejections,
  // which is what authenticate turns into a 503.
  const keys: KeyStore = {
    add: async (record) => {
      insertKey.run(record.id, record.hash, record.shown, record.label, JSON.stringify(record.grants), record.createdAt, record.revokedAt ?? null);
      return Promise.resolve();
    },
    findByHash: async (hash) => {
      const row = keyByHash.get(hash) as unknown as KeyRow | undefined;
      return Promise.resolve(row && toRecord(row));
    },
    list: async () => Promise.resolve((allKeys.all() as unknown as KeyRow[]).map(toRecord)),
    revoke: async (id, at) => Promise.resolve(revokeKey.run(at, id).changes === 1),
  };

  const audit: SqliteAuditSink = {
    write(event) {
      const { lastInsertRowid } = insertEvent.run(event.at, event.caller, event.tool, event.decision, event.reason ?? null, event.traceId ?? null);
      // Sequence numbers run on without gaps, so this keeps exactly the newest ones.
      dropped += Number(pruneEvents.run(Number(lastInsertRowid) - maxAuditEvents).changes);
    },
    events: () => (allEvents.all() as unknown as AuditRow[]).map(toEvent),
    recent: ({ limit, deniedOnly = false }) => ((deniedOnly ? recentDenied : recentEvents).all(limit) as unknown as AuditRow[]).map(toEvent).reverse(),
    dropped: () => dropped,
  };

  const credential: CredentialStore = {
    get() {
      const row = getCredential.get(UPSTREAM) as unknown as { kind: 'header' | 'query'; name: string; ciphertext: string; iv: string } | undefined;
      return row && { kind: row.kind, name: row.name, sealed: { ciphertext: row.ciphertext, iv: row.iv } };
    },
    set({ kind, name, sealed }, at) {
      setCredential.run(UPSTREAM, kind, name, sealed.ciphertext, sealed.iv, at);
    },
  };

  return { keys, audit, credential, close: () => { db.close(); } };
}
