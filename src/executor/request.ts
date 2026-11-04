import type { Credential, Operation, OperationParam } from './operation.js';

// Lifted from Latitude 10's app/hosted-mcp/_lib/upstream.ts and agentify/convert.ts, and
// changed in three ways: any configured host is allowed, including localhost; a request is
// built afresh for each attempt, because a Request can only be sent once; and the credential
// stays out of the plan, which lives longer than an attempt and gets passed around.

const USER_AGENT = 'crumple-mcp (+https://github.com/jorgeortega/crumple)';
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LINE_BREAK = /[\r\n\0]/;
const IDEMPOTENCY_HEADER = 'idempotency-key';
const IDEMPOTENCY_KEY = /^[\x20-\x7E]{1,255}$/;

// Headers a model must never set through an argument: credentials, cookies, transport.
const BLOCKED_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'host', 'content-length', 'content-type',
  'accept', 'accept-encoding', 'connection', 'transfer-encoding', 'x-api-key', 'api-key', 'x-forwarded-for', 'forwarded',
  'x-request-id', 'traceparent', 'tracestate', 'user-agent', 'x-real-ip',
]);

export function isBlockedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return BLOCKED_HEADERS.has(lower) || lower.startsWith('mcp-');
}

/** Refused before anything is sent. Its message is safe to show: it never carries a value. */
export class CallRefused extends Error {}

export interface RequestPlan {
  url: URL;
  method: string;
  headers: Headers;
  body?: string;
  /** The idempotency key every attempt sends, for an operation that takes one. */
  key?: string;
}

export interface PlanOptions {
  headers: Record<string, string>;
  newKey: () => string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}

function pathValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => encodeURIComponent(scalar(item))).join(',');
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, item]) => [encodeURIComponent(key), encodeURIComponent(scalar(item))]).join(',');
  }
  return encodeURIComponent(scalar(value));
}

function addQuery(query: URLSearchParams, param: OperationParam, value: unknown): void {
  if (Array.isArray(value)) {
    if (param.explode === false) query.append(param.name, value.map(scalar).join(','));
    else for (const item of value) query.append(param.name, scalar(item));
  } else if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined && item !== null);
    if (param.style === 'deepObject') for (const [key, item] of entries) query.append(`${param.name}[${key}]`, scalar(item));
    else if (param.explode === false) query.append(param.name, entries.flatMap(([key, item]) => [key, scalar(item)]).join(','));
    else for (const [key, item] of entries) query.append(key, scalar(item));
  } else {
    query.append(param.name, scalar(value));
  }
}

function setHeader(headers: Headers, param: OperationParam, value: unknown): void {
  const text = Array.isArray(value) ? value.map(scalar).join(',') : scalar(value);
  if (LINE_BREAK.test(text)) throw new CallRefused(`arguments.${param.arg}: can't contain line breaks.`);
  try {
    headers.set(param.name, text);
  } catch {
    throw new CallRefused(`arguments.${param.arg}: isn't a valid header value.`);
  }
}

export function parseBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CallRefused(`The base URL "${baseUrl}" isn't a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CallRefused(`The base URL must use http or https, not ${url.protocol}`);
  }
  return url;
}

function idempotencyKey(operation: Operation, args: Record<string, unknown>, newKey: () => string): string {
  const param = operation.params.find((candidate) => candidate.name.toLowerCase() === IDEMPOTENCY_HEADER);
  const given = param ? args[param.arg] : undefined;
  if (given === undefined || given === null) return newKey();
  if (typeof given !== 'string' || !IDEMPOTENCY_KEY.test(given)) {
    throw new CallRefused(`arguments.${param?.arg ?? 'idempotencyKey'}: must be text of up to 255 characters.`);
  }
  return given;
}

/** Everything about a request except the credential. A bad argument stops here, for free. */
export function buildPlan(operation: Operation, argsIn: unknown, baseUrl: string, options: PlanOptions): RequestPlan {
  const base = parseBaseUrl(baseUrl);
  const basePath = base.pathname.replace(/\/$/, '');
  const args = isPlainObject(argsIn) ? argsIn : {};
  const given = (param: OperationParam) => args[param.arg] !== undefined && args[param.arg] !== null;

  const path = operation.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const param = operation.params.find((candidate) => candidate.in === 'path' && candidate.name === name);
    if (!param || !given(param) || args[param.arg] === '') throw new CallRefused(`arguments.${param?.arg ?? name}: is required.`);
    const encoded = pathValue(args[param.arg]);
    if (encoded === '.' || encoded === '..') throw new CallRefused(`arguments.${param.arg}: can't be "." or "..".`);
    return encoded;
  });

  const url = new URL(`${base.origin}${basePath}${path.startsWith('/') ? '' : '/'}${path}`);
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
    throw new CallRefused('This tool\'s path leaves the API\'s base URL.');
  }

  const headers = new Headers({ accept: 'application/json, */*;q=0.5', 'user-agent': USER_AGENT, ...options.headers });
  const query = new URLSearchParams();
  const usesKey = operation.retry === 'with_key';

  for (const param of operation.params) {
    if (!given(param)) continue;
    if (param.in === 'query') addQuery(query, param, args[param.arg]);
    if (param.in === 'header' && !isBlockedHeader(param.name) && !(usesKey && param.name.toLowerCase() === IDEMPOTENCY_HEADER)) {
      setHeader(headers, param, args[param.arg]);
    }
  }
  url.search = query.toString();

  const plan: RequestPlan = { url, method: operation.method, headers };

  if (operation.body && args[operation.body.arg] !== undefined) {
    plan.body = JSON.stringify(args[operation.body.arg]);
    headers.set('content-type', operation.body.contentType);
  }

  if (usesKey) {
    plan.key = idempotencyKey(operation, args, options.newKey);
    headers.set(IDEMPOTENCY_HEADER, plan.key);
  }
  return plan;
}

/** One attempt's request. The credential goes on last, so nothing can replace it. */
export function toRequest(plan: RequestPlan, credential: Credential, traceparent: string | undefined, signal: AbortSignal): Request {
  const url = new URL(plan.url);
  const headers = new Headers(plan.headers);
  if (traceparent !== undefined) headers.set('traceparent', traceparent);

  if (credential.kind !== 'none') {
    const { name, value } = credential;
    if (!HEADER_NAME.test(name) || LINE_BREAK.test(value) || value === '') throw new CallRefused('The upstream credential is unusable.');
    try {
      if (credential.kind === 'header') headers.set(name, value);
      else url.searchParams.set(name, value);
    } catch {
      throw new CallRefused('The upstream credential is unusable.');
    }
  }

  // A redirect is never followed, because it could carry the credential to another host.
  return new Request(url, {
    method: plan.method,
    headers,
    redirect: 'manual',
    signal,
    ...(plan.body === undefined ? {} : { body: plan.body }),
  });
}

const MIN_REDACTABLE_LENGTH = 4;

/** The forms a credential could come back in, for removing from what the API returned. */
export function credentialForms(credential: Credential): string[] {
  if (credential.kind === 'none' || credential.value.length < MIN_REDACTABLE_LENGTH) return [];
  // An API may echo the token alone, without the scheme it was sent with.
  const token = credential.value.replace(/^(bearer|token|basic)\s+/i, '');
  const forms = [credential.value, token].flatMap((value) => [value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2)]);
  // Longest first, so "Bearer abc" goes whole rather than leaving "Bearer" behind.
  return [...new Set(forms)].filter((form) => form.length >= MIN_REDACTABLE_LENGTH).sort((a, b) => b.length - a.length);
}

export function redact(text: string, forms: string[]): string {
  return forms.reduce((result, form) => result.split(form).join('[credential]'), text);
}
