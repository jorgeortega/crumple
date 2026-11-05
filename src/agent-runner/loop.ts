import { callResult, createBudget, createHttpTransport, openSession, type ListedTool, type Session } from '../mcp-client/client.js';
import type { ClaudeMessage, ClaudeTool, ContentBlock, Message, ModelClient, ModelRequest, ToolResultBlock } from './model.js';

// A task, a model and an MCP server: ask the model, run what it asks for, send back the results, and
// repeat until it finishes. It's for measuring, and it isn't a framework. It exists so C11, C12 and
// the parts of C2, C10 and C13 that need a real model have something to run on.

export const MAX_TOKENS = 8_000;
export const EFFORT = 'medium';
export const MAX_RESULT_CHARS = 100_000;
const CLIENT_NAME = 'crumple-mcp-agent';
const MAX_TOOL_PAGES = 10;

// Deliberately says nothing about errors or retrying. C10 asks whether Crumple's error messages tell
// an agent what to do next, and a prompt coaching it would make that look truer than it is.
const SYSTEM = 'You help by using the tools you\'re given. When you\'re done, say plainly what happened.';

const CLAUDE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

export type Stopped = 'done' | 'max_tokens' | 'model_refused' | 'unexpected_stop' | 'max_turns' | 'max_tool_calls' | 'deadline' | 'max_usd' | 'model_error' | 'mcp_unavailable';

export type ToolOutcome = 'ok' | 'tool_error' | 'refused' | 'unreachable';

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  outcome: ToolOutcome;
  ms: number;
}

export interface AgentLimits {
  maxTurns?: number;
  maxToolCalls?: number;
  deadlineMs?: number;
}

export interface AgentOptions {
  task: string;
  mcp: { url: string; token?: string };
  model: ModelClient;
  limits?: AgentLimits;
  /** Each answer, as it arrives. */
  onReply?: (message: ClaudeMessage) => void;
  /** Asked before each model attempt. */
  mayAttempt?: () => boolean;
  /** An attempt's answer was lost. */
  onLost?: () => void;
  /** Called with each request before it's sent. The money runs on this. */
  onRequest?: (request: ModelRequest) => void;
}

export interface AgentRun {
  stopped: Stopped;
  /** What the model said at the end, thinking left out. */
  text: string;
  toolCalls: ToolCallRecord[];
  turns: number;
  /** Things the run should say out loud, such as a tool it couldn't offer the model. */
  notes: string[];
  /** The model's reason for refusing, when it gave one. */
  refusalCategory?: string | null;
  /** The stop reason nobody expected. */
  unexpectedStop?: string | null;
  modelError?: { code: string; status?: number; requestId?: string };
}

function toClaudeTool(tool: ListedTool): ClaudeTool {
  return {
    name: tool.name,
    ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
    input_schema: typeof tool.inputSchema === 'object' && tool.inputSchema !== null ? tool.inputSchema : { type: 'object' },
  };
}

function offerableTools(listed: readonly ListedTool[], notes: string[]): ClaudeTool[] {
  const fits = listed.filter((tool) => CLAUDE_TOOL_NAME.test(tool.name));
  const left = listed.length - fits.length;
  if (left > 0) notes.push(`${String(left)} tools have names Claude won't accept, so the model wasn't offered them.`);
  // Sorted, so the same server gives the same request, which replay and caching both depend on.
  return fits.map(toClaudeTool).sort((a, b) => (a.name < b.name ? -1 : 1));
}

const isToolUse = (block: ContentBlock): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use';

const textOf = (message: ClaudeMessage): string =>
  message.content.flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n');

function capped(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[Cut by the agent: this result was ${String(text.length)} characters, and only the first ${String(MAX_RESULT_CHARS)} are here.]`;
}

interface Ran {
  block: ToolResultBlock;
  record: ToolCallRecord;
}

/** Every way a tool call can go ends up as something the model can read. It decides what's next. */
async function runTool(session: Session, call: Extract<ContentBlock, { type: 'tool_use' }>, remainingMs: () => number): Promise<Ran> {
  const result = callResult(await session.callTool(call.name, call.input, { timeoutMs: Math.max(remainingMs(), 1) }));
  const done = (outcome: ToolOutcome, text: string): Ran => ({
    block: { type: 'tool_result', tool_use_id: call.id, content: capped(text), ...(outcome === 'ok' ? {} : { is_error: true as const }) },
    record: { name: call.name, args: call.input, outcome, ms: result.ms },
  });

  switch (result.kind) {
    case 'result':
      return done(result.isError ? 'tool_error' : 'ok', result.text);
    case 'protocol_error':
      // Official clients raise this as an exception. Crashing here would hide the refusal from the model.
      return done('refused', typeof result.message === 'string' ? result.message : 'The server refused this call.');
    case 'http_error':
      return result.status === 401 || result.status === 403
        ? done('refused', `The server refused this call with HTTP ${String(result.status)}.`)
        : done('unreachable', `The server answered this call with HTTP ${String(result.status)}.`);
    default:
      return done('unreachable', `The tool gave no answer: ${result.why}.`);
  }
}

export async function runAgent(options: AgentOptions): Promise<AgentRun> {
  const { task, mcp, model, limits = {}, onReply, onRequest, mayAttempt = () => true, onLost = () => undefined } = options;
  const { maxTurns = 10, maxToolCalls = 30, deadlineMs = 120_000 } = limits;

  const deadline = AbortSignal.timeout(deadlineMs);
  const started = performance.now();
  const remainingMs = (): number => deadlineMs - (performance.now() - started);
  // The clock as well as the signal: a tool's own timeout can land just before the signal does.
  const expired = (): boolean => deadline.aborted || remainingMs() < 1;

  const run: AgentRun = { stopped: 'done', text: '', toolCalls: [], turns: 0, notes: [] };
  const finish = (stopped: Stopped, more: Partial<AgentRun> = {}): AgentRun => Object.assign(run, { stopped }, more);

  // Nothing has been spent yet, so a server that can't list its tools costs nothing.
  const opened = await openSession(
    createHttpTransport({ url: mcp.url, timeoutMs: Math.min(deadlineMs, 30_000), budget: createBudget(), userAgent: CLIENT_NAME, ...(mcp.token === undefined ? {} : { token: mcp.token }) }),
    { clientName: CLIENT_NAME },
  );
  if (!opened.ok) {
    run.notes.push(`Couldn't connect to the MCP server: ${opened.reason}.`);
    return finish('mcp_unavailable');
  }
  const { session } = opened;

  try {
    const { tools: listed, incomplete } = await session.listTools(MAX_TOOL_PAGES);
    if (incomplete && listed.length === 0) {
      run.notes.push('The MCP server listed no tools.');
      return finish('mcp_unavailable');
    }
    if (incomplete) run.notes.push('The tool list didn\'t finish, so the model was offered only part of it.');
    const tools = offerableTools(listed, run.notes);

    // Only ever added to. On current models, editing an earlier turn invalidates its thinking blocks.
    const messages: Message[] = [{ role: 'user', content: task }];

    for (;;) {
      if (run.turns >= maxTurns) return finish('max_turns');
      if (expired()) return finish('deadline');

      const request: ModelRequest = { model: model.name, max_tokens: MAX_TOKENS, system: SYSTEM, tools, messages, output_config: { effort: EFFORT } };
      onRequest?.(request);
      run.turns += 1;
      const reply = await model.complete(request, { signal: deadline, mayAttempt, onLost });

      if (!reply.ok) {
        if (reply.code === 'max_usd') return finish('max_usd');
        if (expired()) return finish('deadline');
        return finish('model_error', { modelError: { code: reply.code, ...(reply.status === undefined ? {} : { status: reply.status }), ...(reply.requestId === undefined ? {} : { requestId: reply.requestId }) } });
      }

      const { message } = reply;
      onReply?.(message);
      run.text = textOf(message);

      switch (message.stop_reason) {
        case 'end_turn':
          return finish('done');
        case 'tool_use':
          break;
        // A cut-off tool call may have cut-off arguments, so nothing from this turn gets run.
        case 'max_tokens':
          return finish('max_tokens');
        case 'refusal':
          return finish('model_refused', { refusalCategory: message.stop_details?.category ?? null });
        default:
          return finish('unexpected_stop', { unexpectedStop: message.stop_reason });
      }

      const calls = message.content.filter(isToolUse);
      if (run.toolCalls.length + calls.length > maxToolCalls) return finish('max_tool_calls');

      // All at once, and every result in one message, in the order asked. Anthropic's docs say that
      // splitting them teaches the model to stop calling tools in parallel.
      const ran = await Promise.all(calls.map((call) => runTool(session, call, remainingMs)));
      run.toolCalls.push(...ran.map(({ record }) => record));
      messages.push({ role: 'assistant', content: message.content }, { role: 'user', content: ran.map(({ block }) => block) });
    }
  } finally {
    await session.close();
  }
}
