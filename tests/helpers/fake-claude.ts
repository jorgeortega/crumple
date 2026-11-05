import type { ClaudeMessage, ContentBlock, ModelCallOptions, ModelClient, ModelReply, ModelRequest } from '../../src/agent-runner/model.js';
import { serveOnNode } from '../../src/node.js';

// A model that does what its script says. These are test fixtures, never presented as a real run:
// a real recording has a date, a commit and came from the API.

const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

export const reply = (content: ContentBlock[], stopReason: string, more: Partial<ClaudeMessage> = {}): ClaudeMessage => ({
  role: 'assistant',
  content,
  stop_reason: stopReason,
  usage,
  ...more,
});

export const toolUse = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name, input });

export const finished = (text = 'All done.'): ClaudeMessage => reply([{ type: 'text', text }], 'end_turn');

export const calling = (...blocks: ContentBlock[]): ClaudeMessage => reply(blocks, 'tool_use');

export type ScriptStep = ClaudeMessage | ModelReply | ((request: ModelRequest, options: ModelCallOptions) => Promise<ClaudeMessage | ModelReply>);

export interface ScriptedModel extends ModelClient {
  /** Each request, copied when it was made, so a later change can't hide what was sent. */
  requests: ModelRequest[];
}

const isReply = (value: ClaudeMessage | ModelReply): value is ModelReply => 'ok' in value;

export function scriptedModel(steps: ScriptStep[], name = 'claude-haiku-5-5'): ScriptedModel {
  const requests: ModelRequest[] = [];
  let next = 0;
  return {
    name,
    requests,
    async complete(request, options) {
      requests.push(JSON.parse(JSON.stringify(request)) as ModelRequest);
      const step = steps[next];
      next += 1;
      if (step === undefined) throw new Error('The script ran out: the loop asked the model more often than expected.');
      const value = typeof step === 'function' ? await step(request, options) : step;
      return isReply(value) ? value : { ok: true, message: value };
    },
  };
}

// The API's side, on a real socket, for testing what the adapter does with each way it can answer.

export type ApiStep =
  | { status?: number; body?: unknown; headers?: Record<string, string> }
  | { rawBody: string; status?: number }
  /** Starts answering, then the connection goes. The call may have been billed by then. */
  | 'drop'
  /** Never answers. */
  | 'hang';

export interface FakeApi {
  url: string;
  requests: { path: string; headers: Record<string, string>; body: string }[];
  close(): Promise<void>;
}

export async function fakeClaudeApi(steps: ApiStep[], fallback: ApiStep = { body: finished() }): Promise<FakeApi> {
  const requests: FakeApi['requests'] = [];
  let next = 0;
  const server = await serveOnNode(async (request) => {
    requests.push({ path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body: await request.text() });
    const step = steps[next] ?? fallback;
    next += 1;
    if (step === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { reject(new Error('The caller left.')); });
      });
    }
    if (step === 'drop') {
      let sent = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode('{"role":'));
            return;
          }
          controller.error(new Error('Dropped.'));
        },
      }), { headers: { 'content-type': 'application/json' } });
    }
    if ('rawBody' in step) return new Response(step.rawBody, { status: step.status ?? 200 });
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200, headers: { 'content-type': 'application/json', ...step.headers } });
  });
  return { url: server.url, requests, close: () => server.close() };
}
