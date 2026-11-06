import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The case study and launch drafts quote the README's generated blocks, so their
// numbers come from the same reports. Each block must equal the README's, and any
// other measured number fails, as it does in the README.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const readme = read('README.md');

function readmeBlock(name: string): string {
  // The headline is the first line of the claims block, which is too long to quote whole.
  const source = name === 'claims-headline' ? 'claims' : name;
  const body = new RegExp(`<!-- generated:${source} -->\\n([\\s\\S]*?)\\n<!-- /generated -->`).exec(readme)?.[1];
  if (body === undefined) throw new Error(`The README has no block called ${source}.`);
  return name === 'claims-headline' ? (body.split('\n')[0] ?? '') : body;
}

const QUOTING = ['docs/case-study.md', ...readdirSync(join(ROOT, 'docs/launch')).map((name) => `docs/launch/${name}`)];
const CHECKED = [...QUOTING, 'docs/comparison.md'];

describe.each(CHECKED)('%s', (path) => {
  const text = read(path);

  it('quotes the README\'s generated blocks exactly', () => {
    for (const [, name, body] of text.matchAll(/<!-- generated:([a-z-]+) -->\n([\s\S]*?)\n<!-- \/generated -->/g)) {
      expect(body).toBe(readmeBlock(name ?? ''));
    }
  });

  it('states no measured number outside a block', () => {
    const prose = text.replace(/<!-- generated:[\s\S]*?<!-- \/generated -->/g, '').replace(/```[\s\S]*?```/g, '');
    expect(prose.match(/\$\d[\d.]*|\b\d[\d,.]* ?(?:ms|tokens?|calls\/s)\b|\b\d+ of \d+\b|\b\d+(?:\.\d+)?%/g)).toBeNull();
  });

  it('never calls the project production-proven or battle-tested', () => {
    expect(text).not.toMatch(/battle-tested/i);
    expect(text.replace(/(isn't|not) production-proven/gi, '').replace(/any production use/i, '')).not.toMatch(/production-proven/i);
  });
});

describe('what the outward-facing writing must say', () => {
  it.each(QUOTING.filter((path) => path !== 'docs/launch/directories.md'))('%s says who wrote the code, and that it isn\'t production-proven', (path) => {
    const text = read(path).replace(/\*\*/g, '');
    expect(text).toMatch(/Claude Code/);
    expect(text).toMatch(/isn't production-proven/i);
  });

  it('the directory drafts say so too', () => {
    expect(read('docs/launch/directories.md')).toMatch(/Not production-proven/);
  });

  it('every link in the comparison goes to where a statement was read, or to this repo', () => {
    const text = read('docs/comparison.md');
    expect(text).toMatch(/read, on \d{4}-\d{2}-\d{2}/);
    const links = [...text.matchAll(/\]\((https?:[^)]+)\)/g)].map((match) => match[1] ?? '');
    expect(links.length).toBeGreaterThan(15);
    for (const name of ['agentgateway', 'litellm', 'konghq', 'gofastmcp', 'modelcontextprotocol']) {
      expect(links.some((link) => link.includes(name))).toBe(true);
    }
  });
});
