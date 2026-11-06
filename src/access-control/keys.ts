import { findWildcardWrite, type Grant } from './policy.js';

// API keys: a prefix plus 32 random bytes, stored as SHA-256 and shown once, so a database
// leak gives nobody a working key. Lifted from Latitude 10's app/_lib/auth/keys.ts.
//
// A fast hash is right here. Slow hashes like Argon2 exist because human passwords can be
// guessed. 256 random bits can't, so a slow hash would add a cost to every request and no
// security. And since a key is found by its hash, there's no secret comparison to time.

export const KEY_PREFIX = 'crumple_';

const KEY_SHAPE = /^crumple_[A-Za-z0-9_-]{43}$/;
const KEY_BYTES = 32;
const ID_BYTES = 8;
const SHOWN_LENGTH = 12;

export interface KeyRecord {
  id: string;
  hash: string;
  /** The start of the key, to tell keys apart in a list. */
  shown: string;
  label: string;
  grants: readonly Grant[];
  createdAt: number;
  revokedAt?: number;
}

/** Small on purpose. Memory lives here, and SQLite passes the same tests. */
export interface KeyStore {
  add(record: KeyRecord): Promise<void>;
  findByHash(hash: string): Promise<KeyRecord | undefined>;
  list(): Promise<KeyRecord[]>;
  revoke(id: string, at: number): Promise<boolean>;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

export const hashKey = sha256Hex;

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const base64 = btoa(String.fromCharCode(...bytes));
  return `${KEY_PREFIX}${base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

/** The only moment the key exists in full. It's returned here and never stored. */
export async function createKey(
  store: KeyStore,
  input: { label: string; grants: readonly Grant[] },
  now: () => number = () => Date.now(),
): Promise<{ id: string; key: string }> {
  if (findWildcardWrite(input.grants)) {
    throw new Error('A grant of * only covers reads. Grant each write tool by name, with writes: true.');
  }
  const key = randomKey();
  const id = `key_${hex(crypto.getRandomValues(new Uint8Array(ID_BYTES)))}`;
  await store.add({
    id,
    hash: await hashKey(key),
    shown: key.slice(0, SHOWN_LENGTH),
    label: input.label,
    grants: input.grants,
    createdAt: now(),
  });
  return { id, key };
}

export function memoryKeyStore(): KeyStore {
  const records = new Map<string, KeyRecord>();
  const copy = (record: KeyRecord): KeyRecord => structuredClone(record);

  return {
    add(record) {
      records.set(record.id, copy(record));
      return Promise.resolve();
    },
    findByHash(hash) {
      const found = [...records.values()].find((record) => record.hash === hash);
      return Promise.resolve(found && copy(found));
    },
    list: () => Promise.resolve([...records.values()].map(copy)),
    revoke(id, at) {
      const record = records.get(id);
      if (!record || record.revokedAt !== undefined) return Promise.resolve(false);
      record.revokedAt = at;
      return Promise.resolve(true);
    },
  };
}

/** The token from an Authorization header. HTTP defines the scheme as case-insensitive. */
export function parseBearer(header: string | null | undefined): string | undefined {
  return header ? /^bearer +([^ ]+)$/i.exec(header)?.[1] : undefined;
}

export const isKeyShaped = (token: string): boolean => KEY_SHAPE.test(token);
