import { describe, expect, it } from 'vitest';
import { buildPlan, CallRefused, isBlockedHeader, toRequest } from './request.js';
import type { Operation } from './operation.js';

const GET: Operation = {
  name: 'get_customer',
  method: 'GET',
  path: '/customers/{id}',
  params: [{ name: 'id', arg: 'id', in: 'path' }],
  retry: 'safe',
};

const BASE = 'https://api.example.com';
const signal = new AbortController().signal;
const NO_CREDENTIAL = { kind: 'none' } as const;

function plan(operation: Operation, args: unknown, base = BASE, headers: Record<string, string> = {}) {
  return buildPlan(operation, args, base, { headers, newKey: () => 'generated-key' });
}

function request(operation: Operation, args: unknown) {
  return toRequest(plan(operation, args), NO_CREDENTIAL, undefined, signal);
}

describe('paths', () => {
  it('fills in a path value', () => {
    expect(request(GET, { id: 'cus_1' }).url).toBe('https://api.example.com/customers/cus_1');
  });

  it('encodes a path value, so it can\'t add path segments', () => {
    expect(request(GET, { id: 'a/../b?c=d' }).url).toBe('https://api.example.com/customers/a%2F..%2Fb%3Fc%3Dd');
  });

  it.each(['.', '..'])('refuses %s as a path value, because a client would resolve it', (id) => {
    expect(() => plan(GET, { id })).toThrow(CallRefused);
  });

  it.each([
    ['missing', {}],
    ['null', { id: null }],
    ['empty', { id: '' }],
  ])('refuses a required path value that is %s', (_name, args) => {
    expect(() => plan(GET, args)).toThrow('arguments.id');
  });

  it('refuses a path value when arguments aren\'t an object', () => {
    expect(() => plan(GET, 'not an object')).toThrow(CallRefused);
  });

  it('refuses a placeholder no parameter describes', () => {
    expect(() => plan({ ...GET, params: [] }, { id: 'x' })).toThrow('arguments.id');
  });

  it('joins an array path value with commas, and encodes each item', () => {
    const operation = { ...GET, path: '/customers/{ids}', params: [{ name: 'ids', arg: 'ids', in: 'path' as const }] };
    expect(request(operation, { ids: ['a b', 'c'] }).url).toBe('https://api.example.com/customers/a%20b,c');
  });

  it('flattens an object path value', () => {
    const operation = { ...GET, path: '/customers/{ids}', params: [{ name: 'ids', arg: 'ids', in: 'path' as const }] };
    expect(request(operation, { ids: { a: 1 } }).url).toBe('https://api.example.com/customers/a,1');
  });

  it('keeps the base URL\'s own path', () => {
    const url = toRequest(plan(GET, { id: 'x' }, 'https://api.example.com/v2/'), NO_CREDENTIAL, undefined, signal).url;
    expect(url).toBe('https://api.example.com/v2/customers/x');
  });

  it('allows localhost, for a local upstream', () => {
    const url = toRequest(plan(GET, { id: 'x' }, 'http://127.0.0.1:8080'), NO_CREDENTIAL, undefined, signal).url;
    expect(url).toBe('http://127.0.0.1:8080/customers/x');
  });

  it('adds the slash a path left out', () => {
    expect(request({ ...GET, path: 'customers/{id}' }, { id: 'x' }).url).toBe('https://api.example.com/customers/x');
  });

  it('refuses an operation whose own path climbs out of the base URL', () => {
    const operation: Operation = { ...GET, path: '/../other', params: [] };
    expect(() => plan(operation, {}, 'https://api.example.com/v2')).toThrow('leaves');
  });

  it.each(['file:///etc/passwd', 'not a url', 'ftp://example.com'])('refuses %s as a base URL', (base) => {
    expect(() => plan(GET, { id: 'x' }, base)).toThrow(CallRefused);
  });
});

describe('query parameters', () => {
  const list = (param: Partial<Operation['params'][number]> = {}): Operation => ({
    ...GET,
    path: '/customers',
    params: [{ name: 'q', arg: 'q', in: 'query', ...param }],
  });

  it('adds a value', () => {
    expect(request(list(), { q: 'a b' }).url).toBe('https://api.example.com/customers?q=a+b');
  });

  it('leaves out one not given', () => {
    expect(request(list(), {}).url).toBe('https://api.example.com/customers');
  });

  it('repeats an array by default', () => {
    expect(request(list(), { q: ['a', 'b'] }).url).toContain('q=a&q=b');
  });

  it('joins an array when explode is false', () => {
    expect(request(list({ explode: false }), { q: ['a', 'b'] }).url).toContain('q=a%2Cb');
  });

  it('spreads an object by default, skipping empty values', () => {
    expect(request(list(), { q: { a: 1, b: null } }).url).toContain('?a=1');
  });

  it('writes an object as deepObject', () => {
    expect(request(list({ style: 'deepObject' }), { q: { a: 1 } }).url).toContain('q%5Ba%5D=1');
  });

  it('joins an object when explode is false', () => {
    expect(request(list({ explode: false }), { q: { a: 1 } }).url).toContain('q=a%2C1');
  });

  it('writes a number and a boolean as text', () => {
    expect(request(list(), { q: 5 }).url).toContain('q=5');
    expect(request(list(), { q: true }).url).toContain('q=true');
  });

  it('writes a nested value as JSON', () => {
    expect(request(list(), { q: [{ a: 1 }] }).url).toContain(encodeURIComponent('{"a":1}').replace(/%3A/, '%3A'));
  });
});

describe('headers', () => {
  const withHeader: Operation = { ...GET, path: '/customers', params: [{ name: 'X-Region', arg: 'region', in: 'header' }] };

  it('sends a header parameter', () => {
    expect(request(withHeader, { region: 'eu' }).headers.get('x-region')).toBe('eu');
  });

  it('joins an array header with commas', () => {
    expect(request(withHeader, { region: ['eu', 'us'] }).headers.get('x-region')).toBe('eu,us');
  });

  it('refuses a line break, which could add a header', () => {
    expect(() => plan(withHeader, { region: 'eu\r\nx-admin: true' })).toThrow('line breaks');
  });

  it('refuses a value a header can\'t hold', () => {
    expect(() => plan(withHeader, { region: 'café世' })).toThrow('valid header');
  });

  // A model must never be able to set these through an argument.
  it.each(['authorization', 'Cookie', 'host', 'x-api-key', 'traceparent', 'mcp-method', 'content-length'])('ignores an argument for %s', (name) => {
    expect(isBlockedHeader(name)).toBe(true);
    const operation: Operation = { ...GET, path: '/x', params: [{ name, arg: 'value', in: 'header' }] };
    expect(request(operation, { value: 'from-the-model' }).headers.get(name)).toBeNull();
  });

  it('adds fixed headers from config', () => {
    const built = toRequest(plan(GET, { id: 'x' }, BASE, { 'x-fault': 'hang' }), NO_CREDENTIAL, undefined, signal);
    expect(built.headers.get('x-fault')).toBe('hang');
  });

  it('says who\'s calling', () => {
    expect(request(GET, { id: 'x' }).headers.get('user-agent')).toContain('crumple-mcp');
  });

  it('sends a traceparent when there is one', () => {
    const built = toRequest(plan(GET, { id: 'x' }), NO_CREDENTIAL, '00-abc-def-01', signal);
    expect(built.headers.get('traceparent')).toBe('00-abc-def-01');
  });
});

describe('the body', () => {
  const create: Operation = {
    name: 'create',
    method: 'POST',
    path: '/customers',
    params: [],
    body: { arg: 'body', contentType: 'application/json' },
    retry: 'never',
  };

  it('sends JSON', async () => {
    const built = request(create, { body: { name: 'Ada' } });
    expect(built.headers.get('content-type')).toBe('application/json');
    expect(await built.json()).toEqual({ name: 'Ada' });
  });

  it('sends none when it wasn\'t given', () => {
    expect(request(create, {}).body).toBeNull();
  });

  it('can build the same request again, because a Request can only be sent once', async () => {
    const built = plan(create, { body: { name: 'Ada' } });
    const first = toRequest(built, NO_CREDENTIAL, undefined, signal);
    const second = toRequest(built, NO_CREDENTIAL, undefined, signal);
    expect(await first.text()).toBe(await second.text());
  });
});

// C3 and C4 start here.
describe('the credential', () => {
  it('goes in a header', () => {
    const built = toRequest(plan(GET, { id: 'x' }), { kind: 'header', name: 'authorization', value: 'Bearer s3cret' }, undefined, signal);
    expect(built.headers.get('authorization')).toBe('Bearer s3cret');
  });

  it('goes in the query', () => {
    const built = toRequest(plan(GET, { id: 'x' }), { kind: 'query', name: 'api_key', value: 's3cret' }, undefined, signal);
    expect(new URL(built.url).searchParams.get('api_key')).toBe('s3cret');
  });

  it('goes on last, so a fixed header or an argument can\'t replace it', () => {
    const built = toRequest(plan(GET, { id: 'x' }, BASE, { authorization: 'Bearer from-config' }), { kind: 'header', name: 'authorization', value: 'Bearer real' }, undefined, signal);
    expect(built.headers.get('authorization')).toBe('Bearer real');
  });

  it('isn\'t in the plan, which lives longer and gets passed around', () => {
    const built = plan(GET, { id: 'x' });
    expect(JSON.stringify([...built.headers])).not.toContain('s3cret');
  });

  it('never follows a redirect, which could carry it to another host', () => {
    expect(request(GET, { id: 'x' }).redirect).toBe('manual');
  });

  it.each([
    ['a bad name', { kind: 'header', name: 'bad name', value: 'x' }],
    ['a line break', { kind: 'header', name: 'authorization', value: 'a\nb' }],
    ['no value', { kind: 'header', name: 'authorization', value: '' }],
    ['a value a header can\'t hold', { kind: 'header', name: 'authorization', value: 'café世' }],
  ] as const)('refuses a credential with %s', (_name, credential) => {
    expect(() => toRequest(plan(GET, { id: 'x' }), credential, undefined, signal)).toThrow(CallRefused);
  });
});

describe('idempotency keys', () => {
  const pay: Operation = {
    name: 'pay',
    method: 'POST',
    path: '/payments',
    params: [{ name: 'Idempotency-Key', arg: 'idempotencyKey', in: 'header' }],
    retry: 'with_key',
  };

  it('generates one for an operation that takes one', () => {
    const built = plan(pay, {});
    expect(built.key).toBe('generated-key');
    expect(built.headers.get('idempotency-key')).toBe('generated-key');
  });

  it('uses the agent\'s, when it\'s retrying after being told to', () => {
    const built = plan(pay, { idempotencyKey: 'from-the-error' });
    expect(built.key).toBe('from-the-error');
    expect(built.headers.get('idempotency-key')).toBe('from-the-error');
  });

  it.each([
    ['not text', 5],
    ['empty', ''],
    ['too long', 'k'.repeat(256)],
    ['with a line break', 'a\nb'],
  ])('refuses a key that is %s', (_name, idempotencyKey) => {
    expect(() => plan(pay, { idempotencyKey })).toThrow('idempotencyKey');
  });

  it('works when the operation doesn\'t name the parameter', () => {
    expect(plan({ ...pay, params: [] }, {}).headers.get('idempotency-key')).toBe('generated-key');
  });

  it('sends none for other operations', () => {
    const operation: Operation = { ...pay, retry: 'never' };
    expect(plan(operation, {}).key).toBeUndefined();
    expect(plan(operation, {}).headers.get('idempotency-key')).toBeNull();
  });
});
