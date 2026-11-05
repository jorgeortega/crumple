import { parse } from 'yaml';
import type { Grant, JwtConfig, McpSurfaceOptions } from '../mcp-surface/index.js';
import { failure } from './io.js';

// Only what flags can't carry: JWT settings and their scope map, plus limits and timeouts.
// Written by hand and pure, because zod isn't a dependency of ours. Unknown fields are errors
// that name the field, because a misspelt `writes` must not quietly do nothing. There's no field
// for a secret, on purpose: a credential comes from the environment.

type Upstream = McpSurfaceOptions['upstream'];

export interface Config {
  jwt?: JwtConfig;
  deadlineMs?: number;
  attemptTimeoutMs?: number;
  retry?: NonNullable<Upstream['retry']>;
  limits?: NonNullable<Upstream['limits']>;
  /** Sent on every upstream request, which is how a test tells fault-api what to break. */
  upstreamHeaders?: Record<string, string>;
}

type Json = Record<string, unknown>;

// A secret has no field here, and this is the one field one could be typed into.
const SECRET_HEADER = /auth|cookie|token|key|secret|password/i;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function objectAt(value: unknown, path: string, known: readonly string[]): Json {
  if (!isObject(value)) throw failure(`In your config, ${path} should be an object.`);
  for (const field of Object.keys(value)) {
    if (!known.includes(field)) throw failure(`In your config, ${path}.${field} isn't something Crumple knows. Known fields: ${known.join(', ')}.`);
  }
  return value;
}

function positiveInt(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw failure(`In your config, ${path} should be a whole number above zero.`);
  return value as number;
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') throw failure(`In your config, ${path} is required, and should be text.`);
  return value;
}

function url(value: unknown, path: string): string {
  const text = requiredText(value, path);
  try {
    new URL(text);
  } catch {
    throw failure(`In your config, ${path} should be a full URL, not ${text}.`);
  }
  return text;
}

function grantAt(value: unknown, path: string): Grant {
  const grant = objectAt(value, path, ['tool', 'writes']);
  const tool = requiredText(grant.tool, `${path}.tool`);
  if (grant.writes === undefined) return { tool };
  if (typeof grant.writes !== 'boolean') throw failure(`In your config, ${path}.writes should be true or false.`);
  return { tool, writes: grant.writes };
}

function jwtAt(value: unknown): JwtConfig {
  const jwt = objectAt(value, 'jwt', ['issuer', 'audience', 'jwksUri', 'resource', 'scopes', 'requireAccessTokenType']);
  if (!isObject(jwt.scopes)) throw failure('In your config, jwt.scopes is required: an object from each scope to the grants it gives.');
  const scopes: Record<string, Grant[]> = {};
  for (const [scope, grants] of Object.entries(jwt.scopes)) {
    if (!Array.isArray(grants)) throw failure(`In your config, jwt.scopes.${scope} should be a list of grants.`);
    scopes[scope] = (grants as unknown[]).map((grant, index) => grantAt(grant, `jwt.scopes.${scope}[${index}]`));
  }
  if (jwt.requireAccessTokenType !== undefined && typeof jwt.requireAccessTokenType !== 'boolean') {
    throw failure('In your config, jwt.requireAccessTokenType should be true or false.');
  }
  return {
    issuer: requiredText(jwt.issuer, 'jwt.issuer'),
    audience: requiredText(jwt.audience, 'jwt.audience'),
    jwksUri: url(jwt.jwksUri, 'jwt.jwksUri'),
    resource: url(jwt.resource, 'jwt.resource'),
    scopes,
    ...(jwt.requireAccessTokenType === undefined ? {} : { requireAccessTokenType: jwt.requireAccessTokenType }),
  };
}

function numbersAt<Name extends string>(value: unknown, path: string, known: readonly Name[]): Partial<Record<Name, number>> {
  const object = objectAt(value, path, known);
  const out: Partial<Record<Name, number>> = {};
  for (const name of known) {
    if (object[name] !== undefined) out[name] = positiveInt(object[name], `${path}.${name}`);
  }
  return out;
}

function headersAt(value: unknown): Record<string, string> {
  if (!isObject(value)) throw failure('In your config, upstreamHeaders should be an object from each header to its value.');
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== 'string') throw failure(`In your config, upstreamHeaders.${name} should be text.`);
    if (SECRET_HEADER.test(name)) throw failure(`In your config, upstreamHeaders.${name} looks like a secret, which doesn't belong in a file. Use CRUMPLE_UPSTREAM_CREDENTIAL.`);
  }
  return value as Record<string, string>;
}

/** Validates a config that's already parsed. */
export function checkConfig(value: unknown): Config {
  const raw = objectAt(value, 'the top level', ['jwt', 'deadlineMs', 'attemptTimeoutMs', 'retry', 'limits', 'upstreamHeaders']);
  return {
    ...(raw.jwt === undefined ? {} : { jwt: jwtAt(raw.jwt) }),
    ...(raw.deadlineMs === undefined ? {} : { deadlineMs: positiveInt(raw.deadlineMs, 'deadlineMs') }),
    ...(raw.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: positiveInt(raw.attemptTimeoutMs, 'attemptTimeoutMs') }),
    ...(raw.retry === undefined ? {} : { retry: numbersAt(raw.retry, 'retry', ['attempts', 'baseMs', 'capMs']) }),
    ...(raw.limits === undefined ? {} : { limits: numbersAt(raw.limits, 'limits', ['perCaller', 'perUpstream', 'queuePerCaller', 'queueUpstream']) }),
    ...(raw.upstreamHeaders === undefined ? {} : { upstreamHeaders: headersAt(raw.upstreamHeaders) }),
  };
}

export function parseConfig(text: string, source: string): Config {
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    throw failure(`Couldn't read the config at ${source}: ${(error as Error).message.split('\n')[0] ?? 'it isn\'t JSON or YAML'}. Check that it's JSON or YAML.`);
  }
  return checkConfig(value);
}
