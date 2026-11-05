import type { ClaudeMessage, ContentBlock, ModelCallOptions, ModelClient, ModelReply, ModelRequest } from '../../src/agent-runner/model.js';

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
