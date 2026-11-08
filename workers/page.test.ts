import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHARGE_KEY, READ_KEY } from './surface.js';
import { SCENARIOS } from './try.js';

const read = (name: string): string => readFileSync(new URL(`public/${name}`, import.meta.url), 'utf8');
const html = read('index.html');
const script = read('page.js');
const headers = read('_headers');

describe('the page', () => {
  it('has a button for every scenario, and none for anything else', () => {
    const shown = [...html.matchAll(/data-scenario="([^"]+)"/g)].map((match) => match[1]);
    expect(shown).toEqual([...SCENARIOS]);
  });

  it('prints the keys that really work', () => {
    expect(html).toContain(READ_KEY);
    expect(html).toContain(CHARGE_KEY);
  });

  it('loads nothing from anywhere else, and links only to Crumple and Latitude 10', () => {
    for (const [, url] of html.matchAll(/<(?:script|link|img|source|video|iframe)\b[^>]*(?:src|href)="([^"]+)"/g)) expect(url).toMatch(/^\//);
    for (const [, url] of html.matchAll(/<a\b[^>]*href="([^"]+)"/g)) expect(url).toMatch(/^(\/|#|https:\/\/latitude10\.tech\/|https:\/\/github\.com\/jorgeortega\/crumple\b|https:\/\/www\.npmjs\.com\/package\/crumple-mcp\b)/);
    expect(script).not.toMatch(/https?:\/\//);
  });

  it('tells Cloudflare not to edit it, because the zone\'s analytics would add a script the page says it doesn\'t have', () => {
    expect(headers).toMatch(/Cache-Control: .*no-transform/);
  });

  it('never puts a response in as HTML', () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  it('uses no cookies or storage', () => {
    expect(script).not.toMatch(/cookie|localStorage|sessionStorage/);
  });

  it('links to the repo, now that it\'s public', () => {
    expect(html).toContain('href="https://github.com/jorgeortega/crumple"');
  });

  it('asks each button\'s question on the button itself', () => {
    const cards = [...html.matchAll(/<button[^>]*data-scenario="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)];
    expect(cards).toHaveLength(SCENARIOS.length);
    for (const [, , inside] of cards) expect(inside).toMatch(/\?\s*</);
  });

  it('offers a command to copy that uses the key the server accepts', () => {
    expect(html).toContain(`--header "Authorization: Bearer ${READ_KEY}"`);
    expect(html).toMatch(/data-copy="[^"]+"/);
    expect(script).toContain('navigator.clipboard');
  });

  it('says where its numbers come from', () => {
    expect(script).toContain('from one laptop, not from this server');
  });

  it('has a strict policy, with nothing inline', () => {
    expect(headers).toContain("default-src 'none'");
    expect(headers).toContain("script-src 'self'");
    expect(headers).not.toContain('unsafe');
    expect(html).not.toMatch(/<script(?![^>]*src=)|<style|\sstyle="|\son[a-z]+="/);
  });
});
