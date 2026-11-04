import { isBlockedHeader, type Operation, type OperationParam } from '../executor/index.js';
import { expectsJson, isIdempotencyParam, isJsonType, isWrite, retryPolicy } from './facts.js';

// OpenAPI 3.0 and 3.1 become MCP tools. Each operation is one tool, whose input is its path,
// query and header parameters plus a `body`, as one JSON Schema 2020-12 object. Pure: document
// in, tools out. Only local $refs, so a document can't make us fetch a URL.
//
// Copied from openapi-agentify/src/openapi/convert.ts (MIT, October Moon LLC). Agentify's
// enabled, scope and price are gone, because access-control decides who may use what: every
// operation becomes a tool, and writes stay invisible without a grant.

type Json = Record<string, unknown>;

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

export interface SurfaceTool {
  name: string;
  /** The policy reads this. Listing a tool isn't permission to use it. */
  writes: boolean;
  title?: string;
  description: string;
  inputSchema: Json;
  annotations: ToolAnnotations;
  operation: Operation;
}

export interface ConvertOptions {
  /** Only operations whose name, operationId or a tag is listed. */
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface Conversion {
  tools: SurfaceTool[];
  /** The document's first server, for when no upstream is configured. */
  baseUrl?: string;
  warnings: string[];
}

interface SchemaContext {
  doc: Json;
  is30: boolean;
  /** Request bodies drop readOnly properties, since the server sets those. */
  mode: 'request' | 'param';
  stack: string[];
  depth: number;
}

const METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete'] as const;
const MAX_DEPTH = 24;
const MAX_DESCRIPTION = 1_200;
const MAX_TITLE = 80;
const MAX_NAME = 64;
const KEY_ARG = 'idempotencyKey';

// The executor's own limit, and what tells the model when this argument is for.
const KEY_SCHEMA = {
  type: 'string',
  maxLength: 255,
  description: 'Leave this out on a first attempt. Use it only to repeat a call that came back with outcome_unknown and a key, passing that key, so the write is not applied twice.',
};

const SUBSCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const;
const SUBSCHEMA_ARRAYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;
const SUBSCHEMA_SINGLE = ['additionalProperties', 'items', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems'] as const;
const DROPPED = new Set(['discriminator', 'xml', 'externalDocs', 'example', 'nullable', '$schema', '$id']);

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);
const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** One segment of a $ref's JSON pointer: percent-decoded first, since a $ref is a URI fragment, then ~1 and ~0. */
function pointerSegment(segment: string): string {
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    // A stray % stays as it is.
  }
  return text.replace(/~1/g, '/').replace(/~0/g, '~');
}

function followPointer(ref: string, doc: Json): unknown {
  if (!ref.startsWith('#')) throw new Error(`External $ref not supported: ${ref}. Bundle the document first`);
  let current: unknown = doc;
  for (const part of ref.slice(1).split('/').slice(1).map(pointerSegment)) {
    if (!isObject(current) && !Array.isArray(current)) throw new Error(`Unresolvable $ref: ${ref}`);
    if (!Object.hasOwn(current as object, part)) throw new Error(`Unresolvable $ref: ${ref}`);
    current = (current as Json)[part];
  }
  return current;
}

/** Follows a chain of $refs on something that isn't a schema: a parameter, a body, a response or a path. */
function deref(value: unknown, doc: Json): unknown {
  const seen = new Set<string>();
  let current = value;
  while (isObject(current) && typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) throw new Error(`Circular $ref: ${current.$ref}`);
    seen.add(current.$ref);
    current = followPointer(current.$ref, doc);
  }
  return current;
}

function convert30Bounds(source: Json, out: Json): void {
  if (source.exclusiveMinimum === true && typeof source.minimum === 'number') {
    out.exclusiveMinimum = source.minimum;
    delete out.minimum;
  } else if (typeof source.exclusiveMinimum === 'boolean') {
    delete out.exclusiveMinimum;
  }
  if (source.exclusiveMaximum === true && typeof source.maximum === 'number') {
    out.exclusiveMaximum = source.maximum;
    delete out.maximum;
  } else if (typeof source.exclusiveMaximum === 'boolean') {
    delete out.exclusiveMaximum;
  }
}

function dropReadOnly(out: Json): void {
  if (!isObject(out.properties)) return;
  const properties = out.properties;
  const readOnly = Object.keys(properties).filter((key) => isObject(properties[key]) && properties[key].readOnly === true);
  for (const key of readOnly) Reflect.deleteProperty(properties, key);
  if (Array.isArray(out.required)) {
    const required = (out.required as string[]).filter((key) => !readOnly.includes(key));
    if (required.length === 0) delete out.required;
    else out.required = required;
  }
}

/** One OpenAPI schema becomes JSON Schema 2020-12, with local refs inlined and cycles cut. */
export function toJsonSchema(schema: unknown, context: SchemaContext): Json {
  if (schema === true || schema === false) return schema as unknown as Json;
  if (!isObject(schema)) return {};

  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    // A tree node that contains nodes, or a very deep schema: stop inlining and accept any
    // value there. Validation stays correct above it.
    if (context.stack.includes(ref) || context.depth > MAX_DEPTH) {
      return { description: `Recursive: see ${ref.split('/').pop() ?? ref}` };
    }
    const siblings = { ...schema };
    delete siblings.$ref;
    const resolved = toJsonSchema(followPointer(ref, context.doc), { ...context, stack: [...context.stack, ref], depth: context.depth + 1 });
    // 3.1 allows keywords next to $ref, such as a description override.
    return Object.keys(siblings).length > 0 ? { ...resolved, ...toJsonSchema(siblings, context) } : resolved;
  }

  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!DROPPED.has(key) && !key.startsWith('x-')) out[key] = value;
  }

  const next = { ...context, depth: context.depth + 1 };
  for (const key of SUBSCHEMA_MAPS) {
    const map = out[key];
    if (isObject(map)) out[key] = Object.fromEntries(Object.entries(map).map(([name, sub]) => [name, toJsonSchema(sub, next)]));
  }
  for (const key of SUBSCHEMA_ARRAYS) {
    const list = out[key];
    if (Array.isArray(list)) out[key] = (list as unknown[]).map((sub) => toJsonSchema(sub, next));
  }
  for (const key of SUBSCHEMA_SINGLE) {
    const single = out[key];
    if (isObject(single)) out[key] = toJsonSchema(single, next);
  }

  if (schema.example !== undefined && out.examples === undefined) out.examples = [schema.example];

  if (context.is30) {
    convert30Bounds(schema, out);
    if (schema.nullable === true) {
      if (typeof out.type === 'string') out.type = [out.type, 'null'];
      if (Array.isArray(out.enum) && !(out.enum as unknown[]).includes(null)) out.enum = [...(out.enum as unknown[]), null];
      if (out.type === undefined && out.enum === undefined) {
        // nullable with no type, such as on allOf: allow null alongside.
        const { description, ...rest } = out;
        return { ...(description === undefined ? {} : { description }), anyOf: [rest, { type: 'null' }] };
      }
    }
  }

  if (context.mode === 'request') dropReadOnly(out);
  return out;
}

function toolName(operation: Json, method: string, path: string): string {
  const raw = asText(operation.operationId) || `${method.toLowerCase()}_${path}`;
  const cleaned = raw
    .replace(/[{}]/g, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  return (cleaned || method.toLowerCase()).slice(0, MAX_NAME);
}

function describe(operation: Json, method: string, path: string): { title?: string; description: string } {
  const summary = asText(operation.summary);
  const long = asText(operation.description);
  const parts = [summary, long === summary ? '' : long].filter(Boolean);
  let description = parts.join('\n\n') || `${method} ${path}`;
  if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;
  return { ...(summary && summary.length <= MAX_TITLE ? { title: summary } : {}), description };
}

function matches(filter: readonly string[], name: string, operation: Json): boolean {
  const keys = [name, operation.operationId, ...asArray(operation.tags)];
  return keys.some((key) => typeof key === 'string' && filter.includes(key));
}

/** The first server, with its variables filled in. A relative one is no use without a base. */
function serverUrl(doc: Json): string | undefined {
  const server = asArray(doc.servers)[0];
  if (!isObject(server) || typeof server.url !== 'string') return undefined;
  const variables = isObject(server.variables) ? server.variables : {};
  const url = server.url.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const variable = variables[name];
    return isObject(variable) && typeof variable.default === 'string' ? variable.default : '';
  });
  return /^https?:\/\//.test(url) ? url.replace(/\/+$/, '') : undefined;
}

// Path-level parameters, overridden by operation-level ones with the same place and name.
function mergedParams(item: Json, operation: Json, doc: Json): Json[] {
  const merged = new Map<string, Json>();
  for (const raw of [...asArray(item.parameters), ...asArray(operation.parameters)]) {
    const param = deref(raw, doc);
    if (isObject(param) && typeof param.name === 'string' && typeof param.in === 'string') merged.set(`${param.in}:${param.name}`, param);
  }
  return [...merged.values()];
}

function successTypes(operation: Json, doc: Json): string[] {
  if (!isObject(operation.responses)) return [];
  return Object.entries(operation.responses)
    .filter(([status]) => /^2/.test(status))
    .flatMap(([, raw]) => {
      const response = deref(raw, doc);
      return isObject(response) && isObject(response.content) ? Object.keys(response.content) : [];
    });
}

class Skip extends Error {}

function toTool(path: string, item: Json, verb: (typeof METHODS)[number], operation: Json, doc: Json, name: string, warnings: string[]): Omit<SurfaceTool, 'name'> {
  const method = verb.toUpperCase();
  const label = `${method} ${path}`;
  const is30 = (doc.openapi as string).startsWith('3.0');
  const declared = mergedParams(item, operation, doc);

  const retry = retryPolicy(method, {
    markedSafe: operation['x-crumple-safe-to-retry'] === true,
    params: declared.map((param) => ({ in: param.in as string, name: param.name as string })),
  });
  const usesKey = retry === 'with_key';

  const properties: Json = {};
  const required: string[] = [];
  const params: OperationParam[] = [];

  const takeArg = (want: string, where: string): string => {
    const taken = (arg: string): boolean => arg === 'body' || Object.hasOwn(properties, arg) || (usesKey && arg === KEY_ARG);
    if (!taken(want)) return want;
    let arg = `${where}_${want}`;
    for (let i = 2; taken(arg); i += 1) arg = `${where}_${want}_${i}`;
    return arg;
  };

  for (const param of declared) {
    const where = param.in as string;
    const paramName = param.name as string;

    if (where === 'cookie') {
      warnings.push(`${label}: cookie parameter "${paramName}" skipped`);
    } else if (where === 'header' && isBlockedHeader(paramName)) {
      warnings.push(`${label}: header "${paramName}" is set by Crumple or its credential, not the model`);
    } else if (usesKey && isIdempotencyParam({ in: where, name: paramName })) {
      // Optional even when the API requires the header, because the executor makes one when it's missing.
      properties[KEY_ARG] = KEY_SCHEMA;
      params.push({ name: paramName, arg: KEY_ARG, in: 'header' });
    } else if (where === 'path' || where === 'query' || where === 'header') {
      const content = isObject(param.content) ? param.content['application/json'] : undefined;
      const raw = param.schema ?? (isObject(content) ? content.schema : undefined) ?? { type: 'string' };
      const schema = toJsonSchema(raw, { doc, is30, mode: 'param', stack: [], depth: 0 });
      if (typeof param.description === 'string' && schema.description === undefined) schema.description = param.description;
      const arg = takeArg(paramName, where);
      properties[arg] = schema;
      if (where === 'path' || param.required === true) required.push(arg);
      params.push({
        name: paramName,
        arg,
        in: where,
        ...(param.style === 'deepObject' ? { style: 'deepObject' } : {}),
        ...(param.explode === false ? { explode: false } : {}),
      });
    }
  }

  for (const [, placeholder] of path.matchAll(/\{([^}]+)\}/g)) {
    if (!params.some((param) => param.in === 'path' && param.name === placeholder)) {
      throw new Skip(`${label}: path parameter {${placeholder ?? ''}} is not declared, skipped operation`);
    }
  }

  let body: Operation['body'];
  if (operation.requestBody) {
    const requestBody = deref(operation.requestBody, doc);
    const declaredBody = isObject(requestBody) ? requestBody : {};
    const content = isObject(declaredBody.content) ? declaredBody.content : {};
    const type = Object.keys(content).find(isJsonType);
    if (type === undefined) {
      const types = Object.keys(content).join(', ') || 'none';
      if (declaredBody.required === true) throw new Skip(`${label}: request body is ${types}; only JSON bodies are supported, skipped operation`);
      warnings.push(`${label}: optional ${types} request body dropped, because only JSON is supported`);
    } else {
      const media = content[type];
      const schema = toJsonSchema(isObject(media) ? media.schema : undefined, { doc, is30, mode: 'request', stack: [], depth: 0 });
      if (typeof declaredBody.description === 'string' && schema.description === undefined) schema.description = declaredBody.description;
      properties.body = schema;
      if (declaredBody.required === true) required.push('body');
      body = { arg: 'body', contentType: type.split(';')[0]?.trim() ?? type };
    }
  }

  const writes = isWrite(method);
  return {
    writes,
    ...describe(operation, method, path),
    inputSchema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false },
    annotations: {
      readOnlyHint: !writes,
      destructiveHint: method === 'DELETE' || method === 'PUT',
      idempotentHint: retry === 'safe',
    },
    operation: {
      name,
      method,
      path,
      params,
      ...(body ? { body } : {}),
      retry,
      ...(expectsJson(successTypes(operation, doc)) ? { expectsJson: true } : {}),
    },
  };
}

export function convertOpenApi(document: unknown, options: ConvertOptions = {}): Conversion {
  if (!isObject(document)) throw new Error('This isn\'t an OpenAPI document: it should be a JSON or YAML object.');
  if (typeof document.swagger === 'string') throw new Error('Swagger 2.0 isn\'t supported. Convert it to OpenAPI 3 first, for example at https://converter.swagger.io.');
  if (typeof document.openapi !== 'string' || !/^3\.[01]\./.test(document.openapi)) {
    throw new Error(`Unsupported OpenAPI version: ${String(document.openapi)}. Use 3.0.x or 3.1.x.`);
  }

  const { include = [], exclude = [] } = options;
  const warnings: string[] = [];
  const tools: SurfaceTool[] = [];
  const names = new Set<string>();

  for (const [path, rawItem] of Object.entries(isObject(document.paths) ? document.paths : {})) {
    let item: unknown;
    try {
      item = deref(rawItem, document);
    } catch (error) {
      warnings.push(`${path}: ${(error as Error).message}, skipped path`);
      continue;
    }
    if (!isObject(item)) continue;

    for (const verb of METHODS) {
      const operation = item[verb];
      if (!isObject(operation)) continue;

      const method = verb.toUpperCase();
      const label = `${method} ${path}`;
      let name = toolName(operation, method, path);

      if (operation['x-crumple-exclude'] === true) continue;
      if (include.length > 0 && !matches(include, name, operation)) continue;
      if (matches(exclude, name, operation)) continue;
      if (operation.deprecated === true) {
        warnings.push(`${label}: deprecated, skipped`);
        continue;
      }

      const base = name;
      for (let i = 2; names.has(name); i += 1) name = `${base.slice(0, MAX_NAME - 4)}_${i}`;

      try {
        tools.push({ name, ...toTool(path, item, verb, operation, document, name, warnings) });
        names.add(name);
      } catch (error) {
        warnings.push(error instanceof Skip ? error.message : `${label}: ${(error as Error).message}, skipped operation`);
      }
    }
  }

  if (tools.length === 0) warnings.push('No operations were converted.');
  const baseUrl = serverUrl(document);
  return { tools, ...(baseUrl === undefined ? {} : { baseUrl }), warnings };
}
