import { describe, expect, it } from 'vitest';
import { createFaultApi, DEFAULT_CREDENTIAL, OPENAPI } from './index.js';

interface Operation {
  operationId: string;
  summary: string;
  description: string;
  parameters?: { name: string; in: string; description: string }[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
}

const operations = Object.entries(OPENAPI.paths).flatMap(([path, methods]) =>
  Object.entries(methods as Record<string, Operation>).map(([method, operation]) => ({ path, method, operation })),
);

describe('the OpenAPI document', () => {
  it('describes every operation for an agent to read', () => {
    expect(operations).toHaveLength(6);
    for (const { operation } of operations) {
      expect(operation.operationId).toMatch(/^[a-z][A-Za-z]+$/);
      expect(operation.summary.length).toBeGreaterThan(0);
      expect(operation.description.length).toBeGreaterThan(20);
      for (const parameter of operation.parameters ?? []) expect(parameter.description.length).toBeGreaterThan(0);
    }
  });

  it('has a unique operationId for each operation', () => {
    const ids = operations.map(({ operation }) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The document and the routes are written by hand, so nothing else keeps them equal.
  it.each(operations.map(({ path, method }) => [method.toUpperCase(), path]))('%s %s really exists', async (method, path) => {
    const api = createFaultApi();
    const url = `http://fault-api.test${(path).replace('{id}', (path).includes('payments') ? 'pay_1' : 'cus_1')}`;
    const response = await api.fetch(new Request(url, {
      method: method,
      headers: { authorization: `Bearer ${DEFAULT_CREDENTIAL}` },
      ...(method === 'POST' ? { body: '{}' } : {}),
    }));
    // A 400 or a 404 for a missing record is fine. A 405 or an unknown path isn't.
    expect(response.status).not.toBe(405);
    const body = (await response.json()) as { error?: { code: string } };
    expect(body.error?.code).not.toBe('unknown_path');
  });

  it('marks the idempotency key as optional on writes that create something', () => {
    const creators = operations.filter(({ method }) => method === 'post');
    expect(creators).toHaveLength(2);
    for (const { operation } of creators) {
      expect(operation.parameters?.map((parameter) => parameter.name)).toContain('Idempotency-Key');
    }
  });
});
