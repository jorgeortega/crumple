import { describe, expect, it } from 'vitest';
import { OPENAPI } from '../fault-api/index.js';
import { convertOpenApi, toJsonSchema, type SurfaceTool } from './convert.js';
import { expectsJson, isWrite, retryPolicy } from './facts.js';

const doc = (paths: unknown, extra: object = {}) => ({ openapi: '3.1.0', info: { title: 't', version: '1' }, paths, ...extra });
const op = (operationId: string, more: object = {}) => ({ operationId, responses: { 200: { description: 'ok' } }, ...more });

function only(paths: unknown, extra: object = {}): SurfaceTool {
  const { tools } = convertOpenApi(doc(paths, extra));
  const [tool] = tools;
  if (!tool) throw new Error('expected a tool');
  return tool;
}

const schemaOf = (tool: SurfaceTool) => tool.inputSchema as { properties: Record<string, Record<string, unknown>>; required?: string[]; additionalProperties: boolean };

describe('the facts', () => {
  it.each([['GET', false], ['HEAD', false], ['get', false], ['POST', true], ['PUT', true], ['PATCH', true], ['DELETE', true]])('%s is a write: %s', (method, expected) => {
    expect(isWrite(method)).toBe(expected);
  });

  const KEY = [{ in: 'header', name: 'Idempotency-Key' }];

  it.each<[string, string, boolean, { in: string; name: string }[], string]>([
    ['a read', 'GET', false, [], 'safe'],
    ['a HEAD', 'HEAD', false, [], 'safe'],
    ['a write marked safe', 'PUT', true, [], 'safe'],
    ['a write with a key', 'POST', false, KEY, 'with_key'],
    ['a key in another capitalisation', 'POST', false, [{ in: 'header', name: 'idempotency-KEY' }], 'with_key'],
    ['a key that isn\'t a header', 'POST', false, [{ in: 'query', name: 'Idempotency-Key' }], 'never'],
    ['a plain POST', 'POST', false, [], 'never'],
    ['a PUT, which the RFC calls idempotent', 'PUT', false, [], 'never'],
    ['a DELETE', 'DELETE', false, [], 'never'],
    ['safe wins over a key', 'POST', true, KEY, 'safe'],
  ])('%s', (_name, method, markedSafe, params, expected) => {
    expect(retryPolicy(method, { markedSafe, params })).toBe(expected);
  });

  it.each([
    [['application/json'], true],
    [['application/problem+json'], true],
    [['application/json; charset=utf-8'], true],
    [['text/plain', 'application/json'], true],
    [['text/html'], false],
    [['application/jsonl'], false],
    [[], false],
  ])('%j promises JSON: %s', (types, expected) => {
    expect(expectsJson(types)).toBe(expected);
  });
});

describe('fault-api\'s own document', () => {
  const { tools, warnings } = convertOpenApi(OPENAPI);
  const tool = (name: string) => tools.find((candidate) => candidate.name === name);

  it('converts with nothing to warn about', () => {
    expect(warnings).toEqual([]);
    expect(tools.map((candidate) => candidate.name).sort()).toEqual(['createCustomer', 'createPayment', 'deleteCustomer', 'getCustomer', 'getPayment', 'listCustomers']);
  });

  it('makes the payment a retryable write with a key', () => {
    expect(tool('createPayment')).toMatchObject({ writes: true, operation: { retry: 'with_key', method: 'POST', path: '/payments', expectsJson: true, body: { arg: 'body', contentType: 'application/json' } } });
    expect(tool('createPayment')?.operation.params).toContainEqual({ name: 'Idempotency-Key', arg: 'idempotencyKey', in: 'header' });
  });

  it('makes reads safe and a delete a single attempt', () => {
    expect(tool('getCustomer')).toMatchObject({ writes: false, operation: { retry: 'safe' } });
    expect(tool('deleteCustomer')).toMatchObject({ writes: true, operation: { retry: 'never' }, annotations: { destructiveHint: true, readOnlyHint: false } });
  });
});

describe('the idempotency key argument', () => {
  const header = (required: boolean) => ({ name: 'Idempotency-Key', in: 'header', required, schema: { type: 'string' } });

  it('is optional even when the API requires the header', () => {
    const tool = only({ '/pay': { post: op('pay', { parameters: [header(true)] }) } });
    expect(schemaOf(tool).required).toBeUndefined();
    expect(schemaOf(tool).properties.idempotencyKey).toMatchObject({ type: 'string', maxLength: 255 });
  });

  it('tells the model when to use it', () => {
    const tool = only({ '/pay': { post: op('pay', { parameters: [header(false)] }) } });
    expect(schemaOf(tool).properties.idempotencyKey?.description).toMatch(/outcome_unknown/);
  });

  it('keeps its name when the API has its own parameter called that', () => {
    const own = { name: 'idempotencyKey', in: 'query', schema: { type: 'string' } };
    const tool = only({ '/pay': { post: op('pay', { parameters: [own, header(false)] }) } });
    expect(tool.operation.params).toEqual([
      { name: 'idempotencyKey', arg: 'query_idempotencyKey', in: 'query' },
      { name: 'Idempotency-Key', arg: 'idempotencyKey', in: 'header' },
    ]);
  });

  it('stays an ordinary parameter on an operation marked safe', () => {
    const tool = only({ '/pay': { post: op('pay', { 'x-crumple-safe-to-retry': true, parameters: [header(true)] }) } });
    expect(tool.operation.retry).toBe('safe');
    expect(tool.operation.params[0]).toMatchObject({ arg: 'Idempotency-Key' });
    expect(schemaOf(tool).required).toEqual(['Idempotency-Key']);
  });
});

describe('what a model can\'t set', () => {
  it.each([['Authorization'], ['cookie'], ['X-Api-Key'], ['Host'], ['traceparent'], ['Mcp-Method']])('refuses a %s header as a parameter', (name) => {
    const { tools, warnings } = convertOpenApi(doc({ '/a': { get: op('a', { parameters: [{ name, in: 'header', schema: { type: 'string' } }] }) } }));
    expect(tools[0]?.operation.params).toEqual([]);
    expect(schemaOf(tools[0] as SurfaceTool).properties).toEqual({});
    expect(warnings.join()).toContain(name);
  });

  it('skips a cookie', () => {
    const { tools, warnings } = convertOpenApi(doc({ '/a': { get: op('a', { parameters: [{ name: 'c', in: 'cookie' }] }) } }));
    expect(tools[0]?.operation.params).toEqual([]);
    expect(warnings[0]).toContain('cookie');
  });

  it('ignores a parameter in a place it doesn\'t know', () => {
    expect(only({ '/a': { get: op('a', { parameters: [{ name: 'c', in: 'mystery' }] }) } }).operation.params).toEqual([]);
  });
});

describe('parameters', () => {
  it('makes one flat input with no extras allowed', () => {
    const tool = only({ '/c/{id}': { get: op('a', { parameters: [
      { name: 'id', in: 'path', required: true, description: 'The id', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer' } },
      { name: 'x-tag', in: 'header', required: true },
    ] }) } });
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'string', description: 'The id' }, limit: { type: 'integer' }, 'x-tag': { type: 'string' } },
      required: ['id', 'x-tag'],
      additionalProperties: false,
    });
  });

  it('always requires a path parameter', () => {
    expect(schemaOf(only({ '/c/{id}': { get: op('a', { parameters: [{ name: 'id', in: 'path' }] }) } })).required).toEqual(['id']);
  });

  it('lets an operation override a path-level parameter', () => {
    const tool = only({ '/a': {
      parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
      get: op('a', { parameters: [{ name: 'q', in: 'query', schema: { type: 'integer' } }] }),
    } });
    expect(schemaOf(tool).properties.q).toEqual({ type: 'integer' });
  });

  it('keeps two parameters with one name apart, and a parameter called body', () => {
    const tool = only({ '/a/{x}': { post: op('a', {
      parameters: [
        { name: 'x', in: 'path', schema: { type: 'string' } },
        { name: 'x', in: 'query', schema: { type: 'string' } },
        { name: 'x', in: 'header', schema: { type: 'string' } },
        { name: 'body', in: 'query', schema: { type: 'string' } },
      ],
    }) } });
    expect(tool.operation.params.map((param) => param.arg)).toEqual(['x', 'query_x', 'header_x', 'query_body']);
  });

  it('numbers a name that\'s still taken', () => {
    const tool = only({ '/a': { get: op('a', { parameters: [
      { name: 'query_x', in: 'query', schema: { type: 'string' } },
      { name: 'x', in: 'header', schema: { type: 'string' } },
      { name: 'x', in: 'query', schema: { type: 'string' } },
      { name: 'header_x', in: 'query', schema: { type: 'string' } },
    ] }) } });
    expect(tool.operation.params.map((param) => param.arg)).toEqual(['query_x', 'x', 'query_x_2', 'header_x']);
  });

  it('reads a schema from content, and keeps deepObject and explode', () => {
    const tool = only({ '/a': { get: op('a', { parameters: [
      { name: 'filter', in: 'query', style: 'deepObject', content: { 'application/json': { schema: { type: 'object' } } } },
      { name: 'ids', in: 'query', explode: false, schema: { type: 'array' } },
    ] }) } });
    expect(tool.operation.params).toEqual([
      { name: 'filter', arg: 'filter', in: 'query', style: 'deepObject' },
      { name: 'ids', arg: 'ids', in: 'query', explode: false },
    ]);
    expect(schemaOf(tool).properties.filter).toEqual({ type: 'object' });
  });

  it('skips junk in the list', () => {
    expect(only({ '/a': { get: op('a', { parameters: [null, 5, { name: 1, in: 'query' }, { name: 'x' }] }) } }).operation.params).toEqual([]);
  });

  it('skips an operation whose path names a parameter nobody declared', () => {
    const { tools, warnings } = convertOpenApi(doc({ '/a/{id}': { get: op('a') } }));
    expect(tools).toEqual([]);
    expect(warnings[0]).toContain('{id}');
  });

  it('follows a $ref to a shared parameter', () => {
    const tool = only({ '/a': { get: op('a', { parameters: [{ $ref: '#/components/parameters/q' }] }) } }, {
      components: { parameters: { q: { name: 'q', in: 'query', schema: { type: 'string' } } } },
    });
    expect(tool.operation.params[0]?.name).toBe('q');
  });
});

describe('request bodies', () => {
  const body = (content: object, required = true, description?: string) => ({ required, content, ...(description ? { description } : {}) });

  it('becomes a body argument', () => {
    const tool = only({ '/a': { post: op('a', { requestBody: body({ 'application/json': { schema: { type: 'object' } } }, true, 'The thing') }) } });
    expect(schemaOf(tool).properties.body).toEqual({ type: 'object', description: 'The thing' });
    expect(schemaOf(tool).required).toEqual(['body']);
    expect(tool.operation.body).toEqual({ arg: 'body', contentType: 'application/json' });
  });

  it('accepts a vendor JSON type, without its parameters', () => {
    const tool = only({ '/a': { post: op('a', { requestBody: body({ 'application/vnd.x+json; charset=utf-8': { schema: {} } }, false) }) } });
    expect(tool.operation.body?.contentType).toBe('application/vnd.x+json');
    expect(schemaOf(tool).required).toBeUndefined();
  });

  it('skips an operation that requires a body that isn\'t JSON', () => {
    const { tools, warnings } = convertOpenApi(doc({ '/a': { post: op('a', { requestBody: body({ 'multipart/form-data': {} }) }) } }));
    expect(tools).toEqual([]);
    expect(warnings[0]).toContain('multipart/form-data');
  });

  it('drops an optional body that isn\'t JSON, and says so', () => {
    const { tools, warnings } = convertOpenApi(doc({ '/a': { post: op('a', { requestBody: body({ 'text/plain': {} }, false) }) } }));
    expect(tools[0]?.operation.body).toBeUndefined();
    expect(warnings[0]).toContain('text/plain');
  });

  it('says none for a body with no content', () => {
    const { warnings } = convertOpenApi(doc({ '/a': { post: op('a', { requestBody: { required: true } }) } }));
    expect(warnings[0]).toContain('none');
  });

  it('copes with a body that resolves to nothing useful', () => {
    expect(convertOpenApi(doc({ '/a': { post: op('a', { requestBody: { $ref: '#/components/x' } }) } }, { components: { x: 'nope' } })).tools[0]?.operation.body).toBeUndefined();
  });

  it('accepts media with no schema, and a missing body description', () => {
    const tool = only({ '/a': { post: op('a', { requestBody: body({ 'application/json': 'odd' }) }) } });
    expect(schemaOf(tool).properties.body).toEqual({});
  });

  it('removes read-only properties, because the server sets those', () => {
    const tool = only({ '/a': { post: op('a', { requestBody: body({ 'application/json': { schema: {
      type: 'object',
      required: ['id', 'name'],
      properties: { id: { type: 'string', readOnly: true }, name: { type: 'string' } },
    } } }) }) } });
    expect(schemaOf(tool).properties.body).toEqual({ type: 'object', required: ['name'], properties: { name: { type: 'string' } } });
  });

  it('drops required altogether when nothing is left in it', () => {
    const tool = only({ '/a': { post: op('a', { requestBody: body({ 'application/json': { schema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', readOnly: true } },
    } } }) }) } });
    expect(schemaOf(tool).properties.body).toEqual({ type: 'object', properties: {} });
  });
});

describe('responses', () => {
  it('notices JSON through a $ref', () => {
    const tool = only({ '/a': { get: op('a', { responses: { 201: { $ref: '#/components/responses/r' }, 400: { content: { 'text/html': {} } } } }) } }, {
      components: { responses: { r: { content: { 'application/json': {} } } } },
    });
    expect(tool.operation.expectsJson).toBe(true);
  });

  it.each([
    ['no responses', {}],
    ['only errors', { responses: { 400: { content: { 'application/json': {} } } } }],
    ['no content', { responses: { 204: { description: 'gone' } } }],
    ['HTML', { responses: { 200: { content: { 'text/html': {} } } } }],
  ])('promises nothing with %s', (_name, more) => {
    const tool = only({ '/a': { get: { operationId: 'a', ...more } } });
    expect(tool.operation.expectsJson).toBeUndefined();
  });
});

describe('names and descriptions', () => {
  it('uses the operationId, cleaned', () => {
    expect(only({ '/a': { get: op('get customer/{id}!') } }).name).toBe('get_customer_id');
  });

  it('makes a name from the method and path when there\'s no operationId', () => {
    expect(only({ '/users/{id}/pets': { get: { parameters: [{ name: 'id', in: 'path' }] } } }).name).toBe('get_users_id_pets');
  });

  it('falls back to the method when nothing else is left', () => {
    expect(only({ '/': { get: { operationId: '!!!' } } }).name).toBe('get');
  });

  it('caps a long name at 64', () => {
    expect(only({ '/a': { get: op('x'.repeat(100)) } }).name).toHaveLength(64);
  });

  it('numbers a duplicate', () => {
    const { tools } = convertOpenApi(doc({ '/a': { get: op('same') }, '/b': { get: op('same') }, '/c': { get: op('same') } }));
    expect(tools.map((tool) => tool.name)).toEqual(['same', 'same_2', 'same_3']);
    expect(tools[1]?.operation.name).toBe('same_2');
  });

  it('joins the summary and description, and uses a short summary as the title', () => {
    const tool = only({ '/a': { get: op('a', { summary: 'Short', description: 'Long words' }) } });
    expect(tool).toMatchObject({ title: 'Short', description: 'Short\n\nLong words' });
  });

  it('doesn\'t repeat a description the same as the summary', () => {
    expect(only({ '/a': { get: op('a', { summary: 'Same', description: 'Same' }) } }).description).toBe('Same');
  });

  it('gives no title for a long summary', () => {
    expect(only({ '/a': { get: op('a', { summary: 's'.repeat(81) }) } }).title).toBeUndefined();
  });

  it('falls back to the method and path', () => {
    expect(only({ '/a': { get: op('a') } }).description).toBe('GET /a');
  });

  it('caps a long description, because every tool costs tokens on every turn', () => {
    expect(only({ '/a': { get: op('a', { description: 'd'.repeat(2_000) }) } }).description).toHaveLength(1_200);
  });
});

describe('which operations become tools', () => {
  const paths = {
    '/a': { get: op('a', { tags: ['public'] }) },
    '/b': { post: op('b', { tags: ['internal'] }) },
    '/c': { delete: op('c', { 'x-crumple-exclude': true }) },
    '/d': { get: op('d', { deprecated: true }) },
  };

  it('takes every operation, writes included, because a grant is what permits a call', () => {
    const { tools, warnings } = convertOpenApi(doc(paths));
    expect(tools.map((tool) => tool.name)).toEqual(['a', 'b']);
    expect(warnings).toEqual(['GET /d: deprecated, skipped']);
  });

  it('filters by name or tag', () => {
    expect(convertOpenApi(doc(paths), { include: ['public'] }).tools.map((tool) => tool.name)).toEqual(['a']);
    expect(convertOpenApi(doc(paths), { include: ['b'] }).tools.map((tool) => tool.name)).toEqual(['b']);
    expect(convertOpenApi(doc(paths), { exclude: ['internal'] }).tools.map((tool) => tool.name)).toEqual(['a']);
  });

  it('skips what isn\'t an operation', () => {
    const { tools } = convertOpenApi(doc({ '/a': { get: 5, summary: 'x', trace: op('t') }, '/b': 'odd' }));
    expect(tools).toEqual([]);
  });

  it('says when there\'s nothing', () => {
    expect(convertOpenApi(doc({})).warnings).toEqual(['No operations were converted.']);
    expect(convertOpenApi({ openapi: '3.0.3' }).warnings).toEqual(['No operations were converted.']);
  });
});

describe('a document it can\'t use', () => {
  it.each([
    ['nothing', null, /OpenAPI document/],
    ['a list', [], /OpenAPI document/],
    ['Swagger 2.0', { swagger: '2.0' }, /Swagger 2.0/],
    ['OpenAPI 2', { openapi: '2.0.0' }, /Unsupported/],
    ['OpenAPI 4', { openapi: '4.0.0' }, /Unsupported/],
    ['no version', {}, /Unsupported/],
  ])('refuses %s, and says what to do', (_name, value, message) => {
    expect(() => convertOpenApi(value)).toThrow(message);
  });
});

describe('$refs', () => {
  const withBody = (schema: unknown) => ({ '/a': { post: op('a', { requestBody: { content: { 'application/json': { schema } } } }) } });
  const bodySchema = (tool: SurfaceTool) => schemaOf(tool).properties.body;

  it('inlines a local one', () => {
    expect(bodySchema(only(withBody({ $ref: '#/components/schemas/X' }), { components: { schemas: { X: { type: 'string' } } } }))).toEqual({ type: 'string' });
  });

  it('decodes a percent-encoded and an escaped pointer', () => {
    const components = { components: { schemas: { 'a/b': { type: 'string' }, 'c{d}': { type: 'number' }, 'e%': { type: 'boolean' } } } };
    expect(bodySchema(only(withBody({ $ref: '#/components/schemas/a~1b' }), components))).toEqual({ type: 'string' });
    expect(bodySchema(only(withBody({ $ref: '#/components/schemas/c%7Bd%7D' }), components))).toEqual({ type: 'number' });
    expect(bodySchema(only(withBody({ $ref: '#/components/schemas/e%' }), components))).toEqual({ type: 'boolean' });
  });

  it('keeps a description next to a $ref, as 3.1 allows', () => {
    const tool = only(withBody({ $ref: '#/components/schemas/X', description: 'Mine' }), { components: { schemas: { X: { type: 'string', description: 'Theirs' } } } });
    expect(bodySchema(tool)).toEqual({ type: 'string', description: 'Mine' });
  });

  it('cuts a cycle rather than looping', () => {
    const tool = only(withBody({ $ref: '#/components/schemas/Node' }), { components: { schemas: { Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } } } } });
    expect(bodySchema(tool)).toEqual({ type: 'object', properties: { next: { description: 'Recursive: see Node' } } });
  });

  // A document can't make us fetch anything.
  it('refuses an external one, and only skips that operation', () => {
    const { tools, warnings } = convertOpenApi(doc({ ...withBody({ $ref: 'https://evil.test/x.json' }), '/b': { get: op('b') } }));
    expect(tools.map((tool) => tool.name)).toEqual(['b']);
    expect(warnings[0]).toContain('External $ref');
  });

  it.each([
    ['one that points nowhere', '#/components/schemas/Missing'],
    ['one through something that isn\'t an object', '#/openapi/nope'],
    // Not a way to reach Object's own properties.
    ['one to a built-in', '#/constructor'],
  ])('skips an operation with %s', (_name, $ref) => {
    const { tools, warnings } = convertOpenApi(doc(withBody({ $ref })));
    expect(tools).toEqual([]);
    expect(warnings[0]).toContain('Unresolvable');
  });

  it('skips a circular parameter', () => {
    const { tools, warnings } = convertOpenApi(doc({ '/a': { get: op('a', { parameters: [{ $ref: '#/components/parameters/x' }] }) } }, { components: { parameters: { x: { $ref: '#/components/parameters/x' } } } }));
    expect(tools).toEqual([]);
    expect(warnings[0]).toContain('Circular');
  });

  it('follows a path item $ref, and skips a bad one', () => {
    const { tools, warnings } = convertOpenApi(doc({ '/a': { $ref: '#/components/pathItems/a' }, '/b': { $ref: '#/nope' } }, { components: { pathItems: { a: { get: op('a') } } } }));
    expect(tools.map((tool) => tool.name)).toEqual(['a']);
    expect(warnings[0]).toContain('/b');
  });
});

describe('schemas', () => {
  const context = (is30: boolean, mode: 'request' | 'param' = 'param') => ({ doc: {}, is30, mode, stack: [], depth: 0 });

  it('drops what JSON Schema doesn\'t know, and our own extensions', () => {
    expect(toJsonSchema({ type: 'string', xml: {}, discriminator: {}, 'x-custom': 1, $schema: 'x', $id: 'y', externalDocs: {} }, context(false))).toEqual({ type: 'string' });
  });

  it('turns example into examples', () => {
    expect(toJsonSchema({ type: 'string', example: 'a' }, context(false))).toEqual({ type: 'string', examples: ['a'] });
    expect(toJsonSchema({ example: 'a', examples: ['b'] }, context(false))).toEqual({ examples: ['b'] });
  });

  it('goes into nested schemas of every kind', () => {
    const inner = { type: 'string', 'x-drop': 1 };
    const clean = { type: 'string' };
    expect(toJsonSchema({ properties: { a: inner }, allOf: [inner], items: inner, additionalProperties: inner }, context(false))).toEqual({ properties: { a: clean }, allOf: [clean], items: clean, additionalProperties: clean });
  });

  it('keeps booleans, and treats junk as anything', () => {
    expect(toJsonSchema(true, context(false))).toBe(true);
    expect(toJsonSchema(false, context(false))).toBe(false);
    expect(toJsonSchema(null, context(false))).toEqual({});
    expect(toJsonSchema({ additionalProperties: false }, context(false))).toEqual({ additionalProperties: false });
  });

  describe('from OpenAPI 3.0', () => {
    it.each([
      ['a nullable type', { type: 'string', nullable: true }, { type: ['string', 'null'] }],
      ['a nullable enum', { type: 'string', enum: ['a'], nullable: true }, { type: ['string', 'null'], enum: ['a', null] }],
      ['a nullable enum already with null', { enum: ['a', null], nullable: true }, { enum: ['a', null] }],
      ['nullable with no type', { allOf: [{ type: 'string' }], nullable: true, description: 'd' }, { description: 'd', anyOf: [{ allOf: [{ type: 'string' }] }, { type: 'null' }] }],
      ['nullable with no type or description', { allOf: [], nullable: true }, { anyOf: [{ allOf: [] }, { type: 'null' }] }],
      ['nullable: false', { type: 'string', nullable: false }, { type: 'string' }],
      ['an exclusive minimum', { minimum: 1, exclusiveMinimum: true }, { exclusiveMinimum: 1 }],
      ['an exclusive maximum', { maximum: 1, exclusiveMaximum: true }, { exclusiveMaximum: 1 }],
      ['a false exclusive minimum', { minimum: 1, exclusiveMinimum: false }, { minimum: 1 }],
      ['a false exclusive maximum', { maximum: 1, exclusiveMaximum: false }, { maximum: 1 }],
    ])('converts %s', (_name, input, output) => {
      expect(toJsonSchema(input, context(true))).toEqual(output);
    });

    it('leaves those alone in 3.1', () => {
      expect(toJsonSchema({ exclusiveMinimum: 5 }, context(false))).toEqual({ exclusiveMinimum: 5 });
    });
  });
});

describe('the base URL', () => {
  it.each([
    ['one server', { servers: [{ url: 'https://api.test/v1/' }] }, 'https://api.test/v1'],
    ['variables', { servers: [{ url: 'https://{env}.test', variables: { env: { default: 'prod' } } }] }, 'https://prod.test'],
    ['a variable with no default', { servers: [{ url: 'https://x{env}.test', variables: { env: {} } }] }, 'https://x.test'],
    ['variables missing', { servers: [{ url: 'https://x{env}.test' }] }, 'https://x.test'],
  ])('reads %s', (_name, extra, url) => {
    expect(convertOpenApi(doc({}, extra)).baseUrl).toBe(url);
  });

  it.each([
    ['no servers', {}],
    ['a relative server', { servers: [{ url: '/v1' }] }],
    ['a junk server', { servers: [5] }],
  ])('has none with %s', (_name, extra) => {
    expect(convertOpenApi(doc({}, extra)).baseUrl).toBeUndefined();
  });
});
