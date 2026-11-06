import type { ListedTool } from '../mcp-client/client.js';
import type { ToolSummary } from './report.js';
import { safeName } from './report.js';

// What a server's tool definitions cost and whether they're well formed. Pure, and it needs nothing
// but the list, so it can't disturb anything.

const CHARS_PER_TOKEN = 4;
const MAX_NAME_LENGTH = 128;
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_LISTED = 3;

/**
 * A rough rule, and labelled as an estimate everywhere it shows. Each model and client counts and
 * wraps tools differently, so a tokenizer would only add false precision about one of them. It runs
 * low: on Haiku 5.5 and Sonnet 5.5, Anthropic's count was 1.6 times this (npm run tokens, 2026-11-06).
 */
export function estimateTokens(tool: Pick<ListedTool, 'name' | 'description' | 'inputSchema'>): number {
  const text = JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function summariseTools(tools: readonly ListedTool[], incomplete: boolean): ToolSummary {
  const perTool = tools
    .map((tool) => ({ name: tool.name, tokens: estimateTokens(tool) }))
    .sort((a, b) => b.tokens - a.tokens);
  return { count: tools.length, totalTokens: perTool.reduce((sum, tool) => sum + tool.tokens, 0), perTool, incomplete };
}

const listed = (names: string[]): string => {
  const shown = names.slice(0, MAX_LISTED).map(safeName).join(', ');
  return names.length > MAX_LISTED ? `${shown} and ${String(names.length - MAX_LISTED)} more` : shown;
};

const isObjectSchema = (schema: unknown): boolean => typeof schema === 'object' && schema !== null && (schema as { type?: unknown }).type === 'object';

/** What's wrong with a list of definitions, as sentences built only from our words and escaped names. */
export function definitionProblems(tools: readonly ListedTool[]): string[] {
  const problems: string[] = [];
  const names = tools.map((tool) => tool.name);

  const badNames = names.filter((name) => !NAME_PATTERN.test(name) || name.length > MAX_NAME_LENGTH);
  if (badNames.length > 0) problems.push(`Names MCP advises against: ${listed(badNames)}.`);

  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  if (repeated.length > 0) problems.push(`Names used twice: ${listed([...new Set(repeated)])}.`);

  const undescribed = tools.filter((tool) => typeof tool.description !== 'string' || tool.description.trim() === '').map((tool) => tool.name);
  if (undescribed.length > 0) problems.push(`No description, which is what a model chooses by: ${listed(undescribed)}.`);

  const noSchema = tools.filter((tool) => !isObjectSchema(tool.inputSchema)).map((tool) => tool.name);
  if (noSchema.length > 0) problems.push(`Input schema isn't an object: ${listed(noSchema)}.`);

  return problems;
}
