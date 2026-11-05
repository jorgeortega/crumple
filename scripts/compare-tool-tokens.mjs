#!/usr/bin/env node
// npm run tokens: how good is prove's estimate of what tool definitions cost? It counts the same
// request with and without Crumple's tools, using Anthropic's token counting, which is free but
// needs your key in ANTHROPIC_API_KEY. It sends the tool definitions and nothing else of yours.
//
// Anthropic's docs call their count an estimate too, but a far better one than characters / 4.

const BUILT = {
  agent: '../dist/agent-runner/index.js',
  faultApi: '../dist/fault-api/index.js',
  surface: '../dist/mcp-surface/index.js',
  definitions: '../dist/prove/definitions.js',
};
const { API_VERSION } = /** @type {typeof import('../src/agent-runner/index.js')} */ (await import(BUILT.agent));
const { OPENAPI } = /** @type {typeof import('../src/fault-api/index.js')} */ (await import(BUILT.faultApi));
const { convertOpenApi } = /** @type {typeof import('../src/mcp-surface/index.js')} */ (await import(BUILT.surface));
const { estimateTokens } = /** @type {typeof import('../src/prove/definitions.js')} */ (await import(BUILT.definitions));

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('This needs your key in ANTHROPIC_API_KEY. Nothing was sent.');
  process.exit(2);
}

const MODEL = process.argv[2] ?? 'claude-haiku-5-5';
// With tool_choice auto, per the tool use overview, read on 2026-11-05. Our estimate leaves it out.
const TOOL_SYSTEM_PROMPT = 286;

/** @param {Record<string, unknown>} extra */
async function count(extra) {
  const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey ?? '', 'anthropic-version': API_VERSION },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello.' }], ...extra }),
  });
  if (!response.ok) {
    console.error(`Token counting answered with HTTP ${String(response.status)}.`);
    process.exit(1);
  }
  const { input_tokens: tokens } = /** @type {{ input_tokens: number }} */ (await response.json());
  return tokens;
}

const listed = convertOpenApi(OPENAPI).tools;
const tools = listed.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema }));
const estimate = listed.reduce((sum, tool) => sum + estimateTokens(tool), 0);

const without = await count({});
const withTools = await count({ tools });
const definitions = withTools - without - TOOL_SYSTEM_PROMPT;

console.log(`Model:                     ${MODEL}, ${String(tools.length)} tools`);
console.log(`Counted, with tools:       ${String(withTools)}`);
console.log(`Counted, without:          ${String(without)}`);
console.log(`Tool system prompt:        ${String(TOOL_SYSTEM_PROMPT)} (from the docs)`);
console.log(`So the definitions cost:   ${String(definitions)}`);
console.log(`prove's estimate:          ${String(estimate)}`);
console.log(`Estimate / counted:        ${(estimate / definitions).toFixed(2)}`);
