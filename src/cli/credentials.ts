import { plainCredential, sealCredential, sealedCredential, type Credential } from '../mcp-surface/index.js';
import type { SqliteStore } from '../store/index.js';
import { openDatabase, requireDb } from './database.js';
import { failure, parseFlags, usage, type Io } from './io.js';

// The upstream credential. A value is never a flag, because flags show up in shell history and
// process lists. The environment is the normal way. `credential set` is for when the database
// gets backed up or copied: the seal key stays out of the file. On one machine, with the key and
// the file side by side, sealing adds little.

export const CREDENTIAL_ENV = 'CRUMPLE_UPSTREAM_CREDENTIAL';
export const SEAL_KEY_ENV = 'CRUMPLE_SEAL_KEY';

const AAD = 'upstream:main';
const DEFAULT_HEADER = 'authorization';

export interface CredentialFlags {
  header?: string | undefined;
  query?: string | undefined;
}

function placement(flags: CredentialFlags): { kind: 'header' | 'query'; name: string } {
  if (flags.header !== undefined && flags.query !== undefined) throw usage('Use --credential-header or --credential-query, not both.');
  return flags.query === undefined ? { kind: 'header', name: flags.header ?? DEFAULT_HEADER } : { kind: 'query', name: flags.query };
}

export interface ResolvedCredential {
  getCredential: () => Promise<Credential>;
  /** For the banner. Never holds the value. */
  describe: string;
  present: boolean;
}

/** What `serve` uses. Having both a plain and a sealed credential is an error, not a silent choice. */
export async function resolveCredential(flags: CredentialFlags, store: SqliteStore | undefined, io: Io): Promise<ResolvedCredential> {
  const plain = io.env[CREDENTIAL_ENV];
  const stored = store?.credential.get();

  if (stored) {
    if (plain) throw failure(`There's a sealed credential in the database, and ${CREDENTIAL_ENV} is set too. Unset it, or replace the stored one with credential set.`);
    if (flags.header !== undefined || flags.query !== undefined) throw usage('The sealed credential already says where it goes. Run credential set again to change that.');
    const key = io.env[SEAL_KEY_ENV];
    if (!key) throw failure(`The database holds a sealed credential, and opening it needs ${SEAL_KEY_ENV}. Set it to the key you sealed it with.`);
    const getCredential = sealedCredential({ kind: stored.kind, name: stored.name, sealed: stored.sealed, key, aad: AAD });
    // Finding out now is better than on every call.
    await getCredential().catch(() => {
      throw failure(`The sealed credential won't open with this ${SEAL_KEY_ENV}. Check the key, or store the credential again with credential set.`);
    });
    return { getCredential, describe: 'using the sealed credential in the database', present: true };
  }

  const { kind, name } = placement(flags);
  if (!plain) return { getCredential: plainCredential('none'), describe: `with no credential, because ${CREDENTIAL_ENV} isn't set`, present: false };
  return { getCredential: plainCredential(kind, name, plain), describe: `using ${CREDENTIAL_ENV}`, present: true };
}

export async function credentialCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    db: { type: 'string' },
    'credential-header': { type: 'string' },
    'credential-query': { type: 'string' },
  });
  if (positionals[0] !== 'set') throw usage('Run credential set --db ./crumple.db.');
  const db = requireDb(values.db, 'credential set');

  const plain = io.env[CREDENTIAL_ENV];
  if (!plain) throw usage(`Put the credential in ${CREDENTIAL_ENV} first. It's never a flag, because flags end up in shell history.`);
  const key = io.env[SEAL_KEY_ENV];
  if (!key) throw usage(`Set ${SEAL_KEY_ENV} to a key of your own first. To make one: openssl rand -base64 32. Keep it away from the database, or sealing adds nothing.`);

  const { kind, name } = placement({ header: values['credential-header'], query: values['credential-query'] });
  let sealed;
  try {
    sealed = await sealCredential(plain, key, AAD);
  } catch {
    throw usage(`${SEAL_KEY_ENV} should be 32 bytes in base64. To make one: openssl rand -base64 32.`);
  }

  const store = await openDatabase(db, io);
  try {
    store.credential.set({ kind, name, sealed }, io.now());
  } finally {
    store.close();
  }
  io.stdout(`Sealed the credential into ${db}. You can unset ${CREDENTIAL_ENV} now. serve will need ${SEAL_KEY_ENV} to open it.`);
  return 0;
}
