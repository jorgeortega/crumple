import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  name: string;
  license: string;
  engines: Record<string, string>;
  dependencies?: Record<string, string>;
};

describe('the package', () => {
  it('uses the name reserved on npm', () => {
    expect(pkg.name).toBe('crumple-mcp');
  });

  it('declares the Node version the spec promises', () => {
    expect(pkg.engines).toEqual({ node: '>=22.13' });
  });

  it('is MIT licensed to October Moon LLC', () => {
    expect(pkg.license).toBe('MIT');
    expect(read('LICENSE')).toContain('Copyright (c) 2026 October Moon LLC');
  });

  // Runtime dependencies are capped because install size is the first impression
  // with npx. Adding a third is an owner decision, so it has to fail here first.
  it('has no runtime dependencies beyond the two the spec allows', () => {
    const allowed = ['@modelcontextprotocol/server', 'yaml'];
    const runtime = Object.keys(pkg.dependencies ?? {});
    expect(runtime.filter((name) => !allowed.includes(name))).toEqual([]);
  });
});
