import type { Message, ModelCallOptions, ModelClient, ModelReply, ModelRequest } from './model.js';

// Live runs cost money and answer differently each time, and a check anyone can run for free has to
// be neither. So a run can be recorded, and replayed with no key and no network.
//
// Only the model is replayed. The tools really run, so a replay still catches a server that behaves
// differently. Each request has to match its recording byte for byte, and anything else is `stale`.
// It says something changed. It can't say what today's model would do about it.

export interface Exchange {
  request: ModelRequest;
  reply: ModelReply;
}

/** Sits in front of a real client, and keeps what passes through. Keys travel in headers, so they aren't here. */
export interface Recorder extends ModelClient {
  readonly exchanges: readonly Exchange[];
}

export function recorder(inner: ModelClient): Recorder {
  const exchanges: Exchange[] = [];
  return {
    name: inner.name,
    exchanges,
    async complete(request: ModelRequest, options: ModelCallOptions) {
      // A copy, because the loop goes on adding to its history.
      const sent = JSON.parse(JSON.stringify(request)) as ModelRequest;
      const reply = await inner.complete(request, options);
      exchanges.push({ request: sent, reply });
      return reply;
    },
  };
}

const roleAndShape = (message: Message | undefined): string => (message ? `message ${message.role}` : 'nothing');

/** Where two requests first differ, in our own words. Never what they said, since that isn't ours to repeat. */
export function firstDifference(recorded: ModelRequest, actual: ModelRequest): string {
  if (recorded.model !== actual.model) return 'the model';
  if (recorded.system !== actual.system) return 'the system prompt';
  if (JSON.stringify(recorded.tools) !== JSON.stringify(actual.tools)) {
    const index = recorded.tools.findIndex((tool, i) => JSON.stringify(tool) !== JSON.stringify(actual.tools[i]));
    return index === -1 ? 'the list of tools, which has grown' : `the definition of tool ${String(index + 1)} of ${String(recorded.tools.length)}`;
  }
  const count = Math.max(recorded.messages.length, actual.messages.length);
  for (let i = 0; i < count; i += 1) {
    if (JSON.stringify(recorded.messages[i]) !== JSON.stringify(actual.messages[i])) {
      return `message ${String(i + 1)} (recorded: ${roleAndShape(recorded.messages[i])}, now: ${roleAndShape(actual.messages[i])})`;
    }
  }
  return 'the request\'s other settings';
}

export interface Replayer extends ModelClient {
  /** How many recorded exchanges the run never asked for. Anything over 0 means it went differently. */
  unused(): number;
}

export function replayer(recording: { model: string; exchanges: readonly Exchange[] }): Replayer {
  const { model, exchanges } = recording;
  let next = 0;
  return {
    name: model,
    unused: () => exchanges.length - next,
    complete(request) {
      const turn = next + 1;
      const exchange = exchanges[next];
      if (!exchange) return Promise.resolve({ ok: false, code: 'stale', detail: `Turn ${String(turn)} asked the model something, and the recording stops at turn ${String(exchanges.length)}.` });
      if (JSON.stringify(request) !== JSON.stringify(exchange.request)) {
        return Promise.resolve({ ok: false, code: 'stale', detail: `Turn ${String(turn)} doesn't match its recording: ${firstDifference(exchange.request, request)} differs.` });
      }
      next += 1;
      return Promise.resolve(exchange.reply);
    },
  };
}

