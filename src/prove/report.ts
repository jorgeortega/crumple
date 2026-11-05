import { countChecks, type CheckOutcome, type Counts } from './checks.js';
import type { ClaimOutcome, ClaimState } from './claims.js';

// What a run found, turned into words. Pure, so a table of inputs can test exactly what comes out.
//
// A report gets shared, so what's in it has to be safe for whoever reads it. Nothing here comes from
// a server under test except tool names, and those go through safeName. A server can't put a link,
// an image or terminal codes in front of a reader.

export interface Environment {
  version: string;
  commit?: string;
  dirty?: boolean;
  os: string;
  cpu: string;
  memoryGb: number;
  node: string;
}

export interface ToolCost {
  name: string;
  tokens: number;
}

export interface ToolSummary {
  count: number;
  totalTokens: number;
  perTool: ToolCost[];
  /** The list didn't finish, so the totals are a lower bound. */
  incomplete: boolean;
}

export interface ProveReport {
  kind: 'self' | 'server';
  target: string;
  startedAt: string;
  durationMs: number;
  environment: Environment;
  checks: CheckOutcome[];
  claims?: ClaimOutcome[];
  protocol?: string;
  tools?: ToolSummary;
  requests?: { used: number; max: number };
  notes?: string[];
  /** What can't be seen from outside, each with why. Listed every time. */
  outOfReach?: { claim: string; text: string }[];
}

const MAX_NAME = 64;

export const FIX_GUIDE = 'https://github.com/jorgeortega/crumple/blob/main/docs/fixing-prove-failures.md';
export const CONFORMANCE_HINT = 'Protocol conformance isn\'t checked here. For that: npx @modelcontextprotocol/conformance';
export const NOT_AN_AUDIT = 'This checks a few things from outside. It isn\'t a security audit, and a clean report doesn\'t mean the server is secure.';

const CREDIT_MARKDOWN = 'Made with [crumple-mcp](https://github.com/jorgeortega/crumple), open source from [Latitude 10](https://latitude10.tech/platform/mcp), which also hosts MCP servers.';

/** A tool name, safe to show anyone. MCP's spec limits names to these characters, though only with a SHOULD. */
export function safeName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, '?');
  return safe.length > MAX_NAME ? `${safe.slice(0, MAX_NAME)}...` : safe;
}

/** Keys often go in a query string, and a report gets shared. */
export function safeTarget(target: string): string {
  try {
    const url = new URL(target);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'a local process';
  }
}

const LABEL: Record<CheckOutcome['state'], string> = { pass: 'pass', fail: 'FAIL', not_run: 'not run' };
const CLAIM_LABEL: Record<ClaimState, string> = { pass: 'pass', partly: 'partly checked', fail: 'FAIL', not_run: 'not run' };

const summary = (counts: Counts): string => `${String(counts.passed)} passed, ${String(counts.failed)} failed, ${String(counts.notRun)} not run`;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

function toolsLine(tools: ToolSummary): string {
  const count = tools.count === 1 ? '1 tool' : `${String(tools.count)} tools`;
  return `${count}${tools.incomplete ? ' or more' : ''}, about ${String(tools.totalTokens)} tokens per turn (estimate)`;
}

function environmentLine(environment: Environment): string {
  const { version, commit, dirty, os, cpu, memoryGb, node } = environment;
  const source = commit ? `commit ${commit}${dirty ? ' with uncommitted changes' : ''}` : `version ${version}`;
  return `${source}. ${os}, ${cpu}, ${String(memoryGb)} GB, Node ${node}.`;
}

export function renderTerminal(report: ProveReport): string {
  const counts = countChecks(report.checks);
  const width = Math.max(...report.checks.map((check) => check.id.length), 0);
  const lines = [`crumple-mcp prove  ${report.kind === 'self' ? 'Crumple itself, on this machine' : safeTarget(report.target)}`];

  if (report.protocol) lines.push(`  Protocol ${report.protocol}`);
  if (report.tools) lines.push(`  ${toolsLine(report.tools)}`);
  lines.push('');
  for (const check of report.checks) {
    lines.push(`  ${LABEL[check.state].padEnd(8)} ${check.id.padEnd(width)}  ${check.detail}`);
  }
  for (const note of report.notes ?? []) lines.push('', `  Note: ${note}`);
  lines.push('', `  ${summary(counts)}.${report.requests ? ` ${String(report.requests.used)} of ${String(report.requests.max)} requests used.` : ` ${seconds(report.durationMs)}.`}`);

  if (report.outOfReach?.length) lines.push(`  Can't be checked from outside: ${report.outOfReach.map((item) => item.claim).join(', ')}. The Markdown report says why.`);
  if (counts.failed > 0) lines.push(`  How to fix these: ${FIX_GUIDE}`);
  if (report.kind === 'server') lines.push(`  ${CONFORMANCE_HINT}`);
  return lines.join('\n');
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderMarkdown(report: ProveReport): string {
  const counts = countChecks(report.checks);
  const lines: string[] = [
    `# crumple-mcp prove: ${report.kind === 'self' ? 'Crumple itself' : `\`${safeTarget(report.target)}\``}`,
    '',
    `**${summary(counts)}.**${report.requests ? ` ${String(report.requests.used)} of ${String(report.requests.max)} requests used.` : ''}`,
    '',
    `Run ${report.startedAt}, taking ${seconds(report.durationMs)}, with crumple-mcp ${report.environment.version}: ${environmentLine(report.environment)}`,
    '',
  ];

  if (report.kind === 'self') {
    lines.push('Measured on one machine, with failures caused on purpose. It says nothing about production load.', '');
  } else {
    lines.push(`${NOT_AN_AUDIT} ${CONFORMANCE_HINT}.`, '');
  }
  if (report.protocol) lines.push(`Protocol: ${report.protocol}.`, '');
  for (const note of report.notes ?? []) lines.push(`Note: ${note}`, '');

  if (report.claims) {
    lines.push('## Claims', '', '| Claim | | Result | Not checked here |', '|---|---|---|---|');
    for (const claim of report.claims) lines.push(`| ${claim.id} | ${cell(claim.text)} | ${CLAIM_LABEL[claim.state]} | ${cell(claim.pending ?? '')} |`);
    lines.push('');
  }

  lines.push('## Checks', '', '| Check | Result | What happened |', '|---|---|---|');
  for (const check of report.checks) {
    lines.push(`| \`${check.id}\` ${cell(check.title)} | ${LABEL[check.state]} | ${cell(check.detail)} |`);
  }
  lines.push('');

  if (report.tools) {
    lines.push(
      '## What the tool definitions cost',
      '',
      'A tool\'s definition goes to the model on every turn, whether or not the tool is used. These are **estimates**: characters in the JSON divided by 4. Each model and client counts differently.',
      '',
      `${toolsLine(report.tools)}.`,
      '',
      '| Tool | Estimated tokens |',
      '|---|---|',
    );
    for (const tool of report.tools.perTool) lines.push(`| \`${safeName(tool.name)}\` | ${String(tool.tokens)} |`);
    lines.push('');
  }

  if (report.outOfReach?.length) {
    lines.push(
      '## Not checked, and can\'t be from outside',
      '',
      'These need control of the API behind the server, or a view of what reaches it. No result here means nothing either way.',
      '',
    );
    for (const item of report.outOfReach) lines.push(`- **${item.claim}:** ${item.text}`);
    lines.push('');
  }

  if (counts.failed > 0) lines.push(`How to fix these: [fixing prove failures](${FIX_GUIDE}).`, '');
  lines.push('---', '', CREDIT_MARKDOWN, '');
  return lines.join('\n');
}

export function renderJson(report: ProveReport): string {
  const safe: ProveReport = {
    ...report,
    target: report.kind === 'self' ? report.target : safeTarget(report.target),
    ...(report.tools ? { tools: { ...report.tools, perTool: report.tools.perTool.map((tool) => ({ ...tool, name: safeName(tool.name) })) } } : {}),
  };
  return `${JSON.stringify({ counts: countChecks(report.checks), ...safe }, null, 2)}\n`;
}

const BADGE_LABEL = 'crumple prove';
const CHAR_WIDTH = 6.6;
const PADDING = 12;

/**
 * Says how many of each, never just "passing", so what didn't run stays visible. It's a file and not
 * a hosted service, because a hosted badge would mean a request to someone's server each time a
 * README loads. Anyone could edit it, so it's only as good as the JSON beside it.
 */
export function renderBadge(counts: Counts): string {
  const value = `${String(counts.passed)} passed · ${String(counts.failed)} failed · ${String(counts.notRun)} not run`;
  const left = Math.round(BADGE_LABEL.length * CHAR_WIDTH + PADDING);
  const right = Math.round(value.length * CHAR_WIDTH + PADDING);
  const total = left + right;
  let colour = '#6e7781';
  if (counts.failed > 0) colour = '#cf222e';
  else if (counts.passed > 0) colour = '#1a7f37';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(total)}" height="20" role="img" aria-label="${BADGE_LABEL}: ${value}">`,
    `<title>${BADGE_LABEL}: ${value}</title>`,
    `<rect width="${String(left)}" height="20" fill="#24292f"/>`,
    `<rect x="${String(left)}" width="${String(right)}" height="20" fill="${colour}"/>`,
    '<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">',
    `<text x="${String(left / 2)}" y="14">${BADGE_LABEL}</text>`,
    `<text x="${String(left + right / 2)}" y="14">${value}</text>`,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}
