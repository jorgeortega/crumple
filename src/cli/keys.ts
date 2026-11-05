import { createKey, type Grant } from '../mcp-surface/index.js';
import { openDatabase, requireDb } from './database.js';
import { failure, parseFlags, usage, type Io } from './io.js';

// Manages keys in a database. A key is shown when it's made and never again.

function grantsFrom(read: string[] | undefined, write: string[] | undefined): Grant[] {
  // With nothing named, a key can read everything and write nothing. Writes are always by name.
  const reads = read && read.length > 0 ? read.map((tool) => ({ tool })) : [{ tool: '*' }];
  return [...reads, ...(write ?? []).map((tool) => ({ tool, writes: true }))];
}

const describeGrants = (grants: readonly Grant[]): string =>
  grants.map((grant) => (grant.tool === '*' ? 'read everything' : `${grant.writes === true ? 'write' : 'read'} ${grant.tool}`)).join(', ') || 'nothing';

export async function keysCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    db: { type: 'string' },
    label: { type: 'string' },
    read: { type: 'string', multiple: true },
    write: { type: 'string', multiple: true },
  });
  const [action, target] = positionals;

  if (action === 'create') {
    const store = await openDatabase(requireDb(values.db, 'keys create'), io);
    try {
      const grants = grantsFrom(values.read, values.write);
      const { id, key } = await createKey(store.keys, { label: values.label ?? 'unnamed', grants }, () => io.now());
      io.stdout(`Created ${id}. It can: ${describeGrants(grants)}.\n\nThe key, shown once:\n  ${key}`);
      return 0;
    } catch (error) {
      throw usage((error as Error).message);
    } finally {
      store.close();
    }
  }

  if (action === 'list') {
    const store = await openDatabase(requireDb(values.db, 'keys list'), io, { mustExist: true });
    try {
      const records = await store.keys.list();
      if (records.length === 0) io.stdout('There are no keys yet. Make one with keys create.');
      for (const record of records) {
        const status = record.revokedAt === undefined ? 'active' : 'revoked';
        io.stdout(`${record.id}  ${record.shown}...  ${status}  ${record.label}  can: ${describeGrants(record.grants)}`);
      }
      return 0;
    } finally {
      store.close();
    }
  }

  if (action === 'revoke') {
    if (target === undefined) throw usage('Say which key: keys revoke <id> --db ./crumple.db. keys list shows the ids.');
    const store = await openDatabase(requireDb(values.db, 'keys revoke'), io, { mustExist: true });
    try {
      if (!(await store.keys.revoke(target, io.now()))) throw failure(`There's no active key ${target}. keys list shows the ids.`);
      io.stdout(`Revoked ${target}. It stops working on its next call.`);
      return 0;
    } finally {
      store.close();
    }
  }

  throw usage('Run keys create, keys list or keys revoke <id>, each with --db ./crumple.db.');
}
