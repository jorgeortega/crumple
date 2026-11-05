import { callResult, createBudget, createHttpTransport, openSession, type ListedTool, type Session } from '../mcp-client/client.js';
import { createTelemetry, type Attributes, type Span, type Telemetry } from '../telemetry/index.js';
import type { ClaudeMessage, ClaudeTool, ContentBlock, Message, ModelClient, ModelRequest, ToolResultBlock } from './model.js';
import { costOfCall, hasPrice } from './prices.js';
import { createMeter, type UsageTotals } from './usage.js';

// A task, a model and an MCP server: ask the model, run what it asks for, send back the results, and
// repeat until it finishes. It's for measuring, and it isn't a framework. It exists so C11, C12 and
// the parts of C2, C10 and C13 that need a real model have something to run on.

export const MAX_TOKENS = 8_000;
export const EFFORT = 'medium';
export const MAX_RESULT_CHARS = 100_000;
export const DEFAULT_MAX_USD = 0.25;
const CLIENT_NAME = 'crumple-mcp-agent';
const MAX_TOOL_PAGES = 10;

// Deliberately says nothing about errors or retrying. C10 asks whether Crumple's error messages tell
// an agent what to do next, and a prompt coaching it would make that look truer than it is.
const SYSTEM = 'You help by using the tools you\'re given. When you\'re done, say plainly what happened.';

const CLAUDE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

export type Stopped = 'done' | 'max_tokens' | 'model_refused' | 'unexpected_stop' | 'max_turns' | 'max_tool_calls' | 'deadline' | 'max_usd' | 'model_error' | 'mcp_unavailable' | 'no_price' | 'stale';

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
  maxUsd?: number;
}

export interface AgentOptions {
  task: string;
  mcp: { url: string; token?: string };
  model: ModelClient;
  limits?: AgentLimits;
  /** Where the run's spans go. None means they're made and dropped, so the trace id still exists. */
  telemetry?: Telemetry;
}

export interface AgentRun {
  stopped: Stopped;
  /** The server's spans join this, through traceparent in each call's _meta. */
  traceId: string;
  /** What the model said at the end, thinking left out. */
  text: string;
  toolCalls: ToolCallRecord[];
  turns: number;
  usage: UsageTotals['usage'];
  /** Null when it can't be known. Never 0 for "unknown". */
  costUsd: number | null;
  /** An answer was lost, so its worst case is in costUsd, and the real figure may be lower. */
  costIsAtMost: boolean;
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
async function runTool(session: Session, call: Extract<ContentBlock, { type: 'tool_use' }>, remainingMs: () => number, root: Span): Promise<Ran> {
  const span = root.child(`tools/call ${call.name}`, {
    kind: 'client',
    attributes: { 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': call.name, 'gen_ai.operation.name': 'execute_tool' },
  });
  // This is C11: it's what lets the server's spans join this trace. Arguments never go in a span.
  const result = callResult(await session.callTool(call.name, call.input, { timeoutMs: Math.max(remainingMs(), 1) }, { traceparent: span.traceparent() }));
  const done = (outcome: ToolOutcome, text: string): Ran => {
    span.end(outcome === 'ok' ? {} : { errorType: outcome });
    return ran(outcome, text);
  };
  const ran = (outcome: ToolOutcome, text: string): Ran => ({
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
  const { task, mcp, model, limits = {}, telemetry = createTelemetry() } = options;
  const { maxTurns = 10, maxToolCalls = 30, deadlineMs = 120_000, maxUsd = DEFAULT_MAX_USD } = limits;

  const deadline = AbortSignal.timeout(deadlineMs);
  const started = performance.now();
  const remainingMs = (): number => deadlineMs - (performance.now() - started);
  // The clock as well as the signal: a tool's own timeout can land just before the signal does.
  const expired = (): boolean => deadline.aborted || remainingMs() < 1;

  const modelAttributes: Attributes = { 'gen_ai.provider.name': 'anthropic', 'gen_ai.request.model': model.name };
  const root = telemetry.startSpan('invoke_agent', { attributes: { ...modelAttributes, 'gen_ai.operation.name': 'invoke_agent' } });

  const meter = createMeter({ model: model.name, maxUsd });
  const run: AgentRun = { stopped: 'done', traceId: root.context.traceId, text: '', toolCalls: [], turns: 0, notes: [], ...meter.result() };
  const finish = (stopped: Stopped, more: Partial<AgentRun> = {}): AgentRun => {
    Object.assign(run, { stopped }, meter.result(), more);
    root.end({
      attributes: {
        'gen_ai.usage.input_tokens': run.usage.input,
        'gen_ai.usage.output_tokens': run.usage.output,
        ...(run.costUsd === null ? {} : { 'crumple.cost_usd': run.costUsd }),
      },
      ...(stopped === 'done' ? {} : { errorType: stopped }),
    });
    return run;
  };

  // A cap needs a price, so a model we have no price for doesn't get to spend anything.
  if (!hasPrice(model.name)) {
    run.notes.push(`There's no price for ${model.name}, so its spending couldn't be capped.`);
    return finish('no_price');
  }

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
      meter.onRequest(request);
      run.turns += 1;
      const chat = root.child(`chat ${model.name}`, { kind: 'client', attributes: { ...modelAttributes, 'gen_ai.operation.name': 'chat' } });
      const reply = await model.complete(request, { signal: deadline, mayAttempt: meter.mayAttempt, onLost: meter.onLost });

      if (!reply.ok) {
        chat.end({ errorType: reply.code });
        if (reply.code === 'max_usd') return finish('max_usd');
        if (reply.code === 'stale') {
          run.notes.push(reply.detail ?? 'This doesn\'t match its recording.');
          return finish('stale');
        }
        if (expired()) return finish('deadline');
        return finish('model_error', { modelError: { code: reply.code, ...(reply.status === undefined ? {} : { status: reply.status }), ...(reply.requestId === undefined ? {} : { requestId: reply.requestId }) } });
      }

      const { message } = reply;
      meter.onReply(message);
      // Tokens live on the chat span, because an MCP server never sees them (C12).
      const { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } = message.usage;
      const cost = costOfCall(model.name, message.usage);
      chat.end({
        attributes: {
          ...(input === undefined ? {} : { 'gen_ai.usage.input_tokens': input }),
          ...(output === undefined ? {} : { 'gen_ai.usage.output_tokens': output }),
          ...(cacheRead === undefined ? {} : { 'gen_ai.usage.cache_read.input_tokens': cacheRead }),
          ...(cacheWrite === undefined ? {} : { 'gen_ai.usage.cache_write.input_tokens': cacheWrite }),
          ...(cost === null ? {} : { 'crumple.cost_usd': cost }),
        },
      });
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
      const results = await Promise.all(calls.map((call) => runTool(session, call, remainingMs, root)));
      run.toolCalls.push(...results.map(({ record }) => record));
      messages.push({ role: 'assistant', content: message.content }, { role: 'user', content: results.map(({ block }) => block) });
    }
  } finally {
    // Only still open if something threw, and ending twice does nothing.
    root.end({ errorType: 'crashed' });
    await session.close();
  }
}
