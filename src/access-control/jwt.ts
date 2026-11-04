// Checks a JWT access token on Web Crypto alone. Three algorithms, keys only from the issuer's
// published set and never from the token's own header, and base64url and JSON parsed strictly,
// so a token can only mean one thing. Pure: no fetch, and the time is passed in.
//
// Lifted from Latitude 10's app/hosted-mcp/_lib/jose.ts, which checks ID tokens. This checks
// access tokens, so the azp rule is gone (a real access token can have azp or two audiences),
// nonce is gone, and iat is only refused when it's far ahead. Attacks: RFC 8725.

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface Jwks {
  keys: Jwk[];
}

export type JwtClaims = Record<string, unknown> & { sub: string };

export type JwtReason =
  | 'malformed'
  | 'too_large'
  | 'alg'
  | 'typ'
  | 'header'
  | 'no_key'
  | 'weak_key'
  | 'signature'
  | 'iss'
  | 'aud'
  | 'exp'
  | 'nbf'
  | 'iat'
  | 'sub';

export type JwtResult = { ok: true; claims: JwtClaims } | { ok: false; reason: JwtReason };

export interface JwtExpectations {
  issuer: string;
  audience: string;
  /** Milliseconds since the epoch. */
  now: number;
  /** RFC 9068's typ check. Off by default: MCP doesn't require that profile. */
  requireAccessTokenType?: boolean;
}

export const MAX_JWT_BYTES = 16 * 1024;

const SKEW_SECONDS = 60;
const IAT_AHEAD_SECONDS = 5 * 60;
const MIN_RSA_BITS = 2048;
const ES256_SIGNATURE_BYTES = 64;
const ACCESS_TOKEN_TYPES = new Set(['at+jwt', 'application/at+jwt']);

// Headers that would let a token choose its own key or rules.
const REFUSED_HEADERS = ['crit', 'jku', 'x5u', 'jwk', 'x5c'];

type Alg = 'RS256' | 'PS256' | 'ES256';

const ALGS = {
  RS256: { kty: 'RSA', import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  PS256: { kty: 'RSA', import: { name: 'RSA-PSS', hash: 'SHA-256' }, verify: { name: 'RSA-PSS', saltLength: 32 } },
  ES256: { kty: 'EC', import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
} as const;

const refuse = (reason: JwtReason): JwtResult => ({ ok: false, reason });
const isAlg = (value: unknown): value is Alg => typeof value === 'string' && Object.hasOwn(ALGS, value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Strict base64url: the alphabet only, no padding, and no stray bits, so two spellings can't decode alike. */
function base64UrlBytes(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const again = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return again === text ? Uint8Array.from(binary, (char) => char.charCodeAt(0)) : undefined;
}

// JSON.parse keeps the last of a repeated key, so {"sub":"a","sub":"b"} would mean whatever a
// later reader chose. Only called on text that has already parsed, so its strings are valid.
function hasDuplicateKeys(text: string): boolean {
  const stack: ({ keys: Set<string>; expectKey: boolean } | null)[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = end;
    } else if (char === '{') {
      stack.push({ keys: new Set(), expectKey: true });
    } else if (char === '[') {
      stack.push(null);
    } else if (char === '}' || char === ']') {
      stack.pop();
    } else if (char === ',') {
      const top = stack.at(-1);
      if (top) top.expectKey = true;
    }
  }
  return false;
}

function jsonObject(bytes: Uint8Array<ArrayBuffer>): Record<string, unknown> | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) || hasDuplicateKeys(text)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function decode(token: string) {
  const parts = token.split('.');
  const [headerPart, claimsPart, signaturePart] = parts;
  if (parts.length !== 3 || !headerPart || !claimsPart || signaturePart === undefined) return undefined;
  const headerBytes = base64UrlBytes(headerPart);
  const claimBytes = base64UrlBytes(claimsPart);
  const signature = base64UrlBytes(signaturePart);
  if (!headerBytes || !claimBytes || !signature) return undefined;
  const header = jsonObject(headerBytes);
  const claims = jsonObject(claimBytes);
  if (!header || !claims) return undefined;
  return { header, claims, signature, signingInput: new TextEncoder().encode(`${headerPart}.${claimsPart}`) };
}

// The published keys this token may be checked with: the right type for its algorithm, not marked
// for another algorithm or for encryption, and its kid, or the issuer's only key.
function candidates(jwks: Jwks | null | undefined, alg: Alg, kid: unknown): Jwk[] {
  const listed: unknown = jwks?.keys;
  const keys = (Array.isArray(listed) ? listed : []) as (Jwk | null | undefined)[];
  const usable = keys.filter(
    (key): key is Jwk =>
      typeof key === 'object' &&
      key !== null &&
      key.kty === ALGS[alg].kty &&
      (key.alg === undefined || key.alg === alg) &&
      (key.use === undefined || key.use === 'sig') &&
      (alg !== 'ES256' || key.crv === 'P-256'),
  );
  if (typeof kid === 'string') return usable.filter((key) => key.kid === kid);
  return keys.length === 1 ? usable : [];
}

async function importKey(key: Jwk, alg: Alg) {
  // Only the public fields go in. The cast is because the fields can be missing: importing then
  // fails at runtime, which is handled here, and a key that won't import can't verify anything.
  const material = key.kty === 'RSA' ? { kty: 'RSA', n: key.n, e: key.e } : { kty: 'EC', crv: key.crv, x: key.x, y: key.y };
  try {
    return await crypto.subtle.importKey('jwk', material as never, ALGS[alg].import, false, ['verify']);
  } catch {
    return undefined;
  }
}

function isWeak(key: Jwk): boolean {
  if (key.kty !== 'RSA') return false;
  const bytes = key.n === undefined ? undefined : base64UrlBytes(key.n);
  return (bytes?.byteLength ?? 0) * 8 < MIN_RSA_BITS;
}

function checkClaims(claims: Record<string, unknown>, expected: JwtExpectations): JwtReason | undefined {
  const now = Math.floor(expected.now / 1000);
  if (claims.iss !== expected.issuer) return 'iss';

  // MCP requires this: a token issued for another service is refused, even from a trusted issuer.
  const audiences: unknown[] = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!audiences.includes(expected.audience)) return 'aud';

  if (!isNumber(claims.exp) || now > claims.exp + SKEW_SECONDS) return 'exp';
  if (claims.nbf !== undefined && (!isNumber(claims.nbf) || now < claims.nbf - SKEW_SECONDS)) return 'nbf';
  if (claims.iat !== undefined && (!isNumber(claims.iat) || claims.iat > now + IAT_AHEAD_SECONDS)) return 'iat';
  if (typeof claims.sub !== 'string' || claims.sub === '') return 'sub';
  return undefined;
}

export async function verifyJwt(token: string, jwks: Jwks, expected: JwtExpectations): Promise<JwtResult> {
  if (token.length > MAX_JWT_BYTES) return refuse('too_large');
  const decoded = decode(token);
  if (!decoded) return refuse('malformed');
  const { header, claims, signature, signingInput } = decoded;

  // An allowlist of algorithms is what stops `none` and HS256-with-the-public-key.
  const alg = header.alg;
  if (!isAlg(alg)) return refuse('alg');
  if (REFUSED_HEADERS.some((name) => Object.hasOwn(header, name))) return refuse('header');
  if (expected.requireAccessTokenType && !(typeof header.typ === 'string' && ACCESS_TOKEN_TYPES.has(header.typ.toLowerCase()))) return refuse('typ');

  const keys = candidates(jwks, alg, header.kid);
  if (keys.length === 0) return refuse('no_key');
  if (alg === 'ES256' && signature.byteLength !== ES256_SIGNATURE_BYTES) return refuse('signature');

  let verified = false;
  for (const key of keys) {
    if (isWeak(key)) return refuse('weak_key');
    const imported = await importKey(key, alg);
    if (imported && (await crypto.subtle.verify(ALGS[alg].verify, imported, signature, signingInput))) {
      verified = true;
      break;
    }
  }
  if (!verified) return refuse('signature');

  // Claims are only read once the signature holds, so nothing unsigned can steer anything.
  const reason = checkClaims(claims, expected);
  return reason ? refuse(reason) : { ok: true, claims: claims as JwtClaims };
}
