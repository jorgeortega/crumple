// Import this only when someone asks for a database. Loading node:sqlite prints a warning, and a
// first run with no setup should never show it. It also can't run on Workers.
export { openSqliteStore } from './sqlite.js';
export type { CredentialStore, SqliteAuditSink, SqliteStore, SqliteStoreOptions, StoredCredential } from './sqlite.js';
