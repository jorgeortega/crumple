import type { SqliteStore } from '../store/index.js';
import { failure, usage, type Io } from './io.js';

// Loaded only when asked for, because node:sqlite prints a warning on Node 22, and a first run
// with no setup should never show it.

export async function openDatabase(path: string, io: Io, options: { mustExist?: boolean } = {}): Promise<SqliteStore> {
  // Reading a misspelt path would otherwise make an empty database and report nothing to see.
  if (options.mustExist && !io.fileExists(path)) throw failure(`There's no database at ${path}. Check the path.`);
  const { openSqliteStore } = await import('../store/index.js');
  try {
    return openSqliteStore(path);
  } catch (error) {
    throw failure((error as Error).message);
  }
}

export function requireDb(db: string | undefined, command: string): string {
  if (db === undefined) throw usage(`${command} needs a database: add --db ./crumple.db.`);
  return db;
}
