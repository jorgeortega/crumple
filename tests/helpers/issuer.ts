// A software token issuer, so JWT tests need no network and no real identity provider.
// That's also the limit of those tests: nothing here has met a real provider yet.

export const ISSUER = 'https://login.example.test/';
export const AUDIENCE = 'https://mcp.example.test/mcp';
export const NOW_S = 1_800_000_000;

export type Alg = 'RS256' | 'PS256' | 'ES256';
export interface PublicJwk {
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

const PARAMS = {
  RS256: { generate: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
  PS256: { generate: { name: 'RSA-PSS', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, sign: { name: 'RSA-PSS', saltLength: 32 } },
  ES256: { generate: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
} as const;

export const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export const encodeJson = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));

export interface TestIssuer {
  jwk: PublicJwk;
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
  signRaw(headerPart: string, claimsPart: string): Promise<string>;
}

export function goodClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: ISSUER, aud: AUDIENCE, sub: 'person@example.test', exp: NOW_S + 600, iat: NOW_S, ...overrides };
}

export async function createIssuer(alg: Alg = 'ES256', options: { kid?: string; modulusLength?: number } = {}): Promise<TestIssuer> {
  const { kid = 'key-1', modulusLength } = options;
  const params = PARAMS[alg];
  const generate = modulusLength === undefined ? params.generate : { ...params.generate, modulusLength };
  const pair = await crypto.subtle.generateKey(generate, true, ['sign', 'verify']);
  // What a real JWKS holds: the public part, and none of the fields WebCrypto adds.
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwk: PublicJwk = { kty: exported.kty ?? '', kid, use: 'sig' };
  for (const field of ['n', 'e', 'crv', 'x', 'y'] as const) {
    const value = exported[field];
    if (value !== undefined) jwk[field] = value;
  }

  async function signRaw(headerPart: string, claimsPart: string): Promise<string> {
    const input = new TextEncoder().encode(`${headerPart}.${claimsPart}`);
    const signature = new Uint8Array(await crypto.subtle.sign(params.sign, pair.privateKey, input));
    return `${headerPart}.${claimsPart}.${base64Url(signature)}`;
  }

  return {
    jwk,
    signRaw,
    sign: (claims, header = {}) => signRaw(encodeJson({ alg, kid, ...header }), encodeJson(claims)),
  };
}
