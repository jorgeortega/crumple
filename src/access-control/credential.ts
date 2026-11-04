// The upstream credential. The agent's token and this are different things, and they never
// meet: the agent proves who it is to Crumple, and Crumple uses this to reach the API.
//
// Sealed with AES-GCM 256, with a fresh IV each time and the purpose bound in as additional
// data, so a sealed value copied to another row or use won't open. Lifted from Latitude 10's
// app/hosted-mcp/_lib/credential.ts, with keys passed in rather than read from process.env.
//
// The honest limit: sealing only helps when the key lives apart from the data. It protects a
// SQLite file or a database backup. If the sealed value and its key share one .env file,
// sealing adds nothing, so plainCredential exists and nothing should imply it's encrypted.

export const CREDENTIAL_UNAVAILABLE = 'The stored credential can\'t be used. Store it again.';

export type Credential =
  | { kind: 'none' }
  | { kind: 'header' | 'query'; name: string; readonly value: string };

export interface Sealed {
  ciphertext: string;
  iv: string;
}

export interface SealedCredentialOptions {
  kind: 'header' | 'query';
  name: string;
  sealed: Sealed;
  /** 32 bytes, base64. */
  key: string;
  /** The key being rotated out, tried only if the current one can't open the value. */
  previousKey?: string;
  /** What this value is for, such as 'upstream:main'. */
  aad: string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;

const unavailable = (): Error => new Error(CREDENTIAL_UNAVAILABLE);
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

async function importKey(key: string) {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(key.trim());
  } catch {
    throw unavailable();
  }
  if (bytes.byteLength !== KEY_BYTES) throw unavailable();
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealCredential(plain: string, key: string, aad: string): Promise<Sealed> {
  if (!plain) throw unavailable();
  const cryptoKey = await importKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encode(aad) }, cryptoKey, encode(plain));
  return { ciphertext: toBase64(new Uint8Array(sealed)), iv: toBase64(iv) };
}

async function tryOpen(sealed: Sealed, key: string, aad: string): Promise<string | undefined> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(sealed.iv), additionalData: encode(aad) },
      await importKey(key),
      fromBase64(sealed.ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return undefined;
  }
}

// The value can be read directly, because the request needs it, but it isn't enumerable, and
// JSON and inspection print only the kind and the name. So a log line or a spread can't carry it.
function hidden(kind: 'header' | 'query', name: string, value: string): Credential {
  const shown = (): { kind: string; name: string } => ({ kind, name });
  const credential = { kind, name };
  Object.defineProperty(credential, 'value', { value, enumerable: false });
  Object.defineProperty(credential, 'toJSON', { value: shown, enumerable: false });
  Object.defineProperty(credential, Symbol.for('nodejs.util.inspect.custom'), { value: shown, enumerable: false });
  return credential as Credential;
}

/** Opens the value for each call. Whatever went wrong, it says only that it can't be used. */
export function sealedCredential(options: SealedCredentialOptions): () => Promise<Credential> {
  const { kind, name, sealed, key, previousKey, aad } = options;
  return async () => {
    const plain = (await tryOpen(sealed, key, aad)) ?? (previousKey === undefined ? undefined : await tryOpen(sealed, previousKey, aad));
    if (plain === undefined) throw unavailable();
    return hidden(kind, name, plain);
  };
}

/** For a credential from an environment variable. Hidden the same way, and not encrypted. */
export function plainCredential(kind: 'none'): () => Promise<Credential>;
export function plainCredential(kind: 'header' | 'query', name: string, value: string): () => Promise<Credential>;
export function plainCredential(kind: 'none' | 'header' | 'query', name = '', value = ''): () => Promise<Credential> {
  const credential: Credential = kind === 'none' ? { kind } : hidden(kind, name, value);
  return () => Promise.resolve(credential);
}
