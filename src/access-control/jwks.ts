import type { Jwk, Jwks } from './jwt.js';

// The issuer's public keys, cached. From Latitude 10's app/hosted-mcp/_lib/idp.ts, without
// discovery, since the address is configured. One change matters: having no keys at all comes
// back as undefined, not an empty list, because "we couldn't check" must not look like "this
// token is bad". A 401 would send a person to log in again over a problem that's ours.
//
// The limit: if the issuer stays down, old keys stay in use, so a signing key it revoked meanwhile
// would still be trusted. The other choice is refusing everyone during an issuer's outage.

export const MAX_JWKS_BYTES = 64 * 1024;

const MIN_TTL_S = 300;
const MAX_TTL_S = 86_400;
const REFRESH_EVERY_MS = 60_000;
const RETRY_FAILED_AFTER_MS = 10_000;
const TIMEOUT_MS = 5_000;
const MAX_KEYS = 50;

export interface KeySource {
  /** The cached keys, fetching if they've run out. undefined means there are none to check with. */
  get(): Promise<Jwks | undefined>;
  /** For an unknown key id: fetches again, at most once a minute, so junk tokens can't hammer the issuer. */
  refresh(): Promise<Jwks | undefined>;
}

export interface KeySourceOptions {
  jwksUri: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Fetched {
  jwks: Jwks;
  ttlSeconds: number;
}

function ttlFrom(cacheControl: string | null): number {
  const maxAge = /max-age=(\d+)/.exec(cacheControl ?? '')?.[1];
  return Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, maxAge === undefined ? MIN_TTL_S : Number(maxAge)));
}

async function fetchKeys(uri: string, fetchFn: typeof fetch): Promise<Fetched | undefined> {
  try {
    // The address is the operator's own. No redirects, so it stays the only one we ask.
    const response = await fetchFn(uri, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (response.status !== 200) return undefined;
    const text = await response.text();
    if (text.length > MAX_JWKS_BYTES) return undefined;
    const body = JSON.parse(text) as { keys?: unknown } | null;
    if (!Array.isArray(body?.keys)) return undefined;
    return { jwks: { keys: (body.keys as Jwk[]).slice(0, MAX_KEYS) }, ttlSeconds: ttlFrom(response.headers.get('cache-control')) };
  } catch {
    return undefined;
  }
}

export function createKeySource(options: KeySourceOptions): KeySource {
  const { jwksUri, now = () => Date.now() } = options;
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));

  let held: Jwks | undefined;
  let until = Number.NEGATIVE_INFINITY;
  let lastRefresh = Number.NEGATIVE_INFINITY;
  let lastFailure = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<Jwks | undefined> | undefined;

  // One request at a time, so a burst when the cache runs out doesn't become a burst at the issuer.
  function load(): Promise<Jwks | undefined> {
    inFlight ??= (async () => {
      const fetched = await fetchKeys(jwksUri, fetchFn);
      if (fetched) {
        held = fetched.jwks;
        until = now() + fetched.ttlSeconds * 1000;
      } else {
        lastFailure = now();
      }
      inFlight = undefined;
      return held;
    })();
    return inFlight;
  }

  return {
    async get() {
      if (held && until > now()) return held;
      // During an outage, not one fetch per request.
      if (now() - lastFailure < RETRY_FAILED_AFTER_MS) return held;
      return load();
    },
    async refresh() {
      if (now() - lastRefresh < REFRESH_EVERY_MS) return held;
      lastRefresh = now();
      return load();
    },
  };
}
