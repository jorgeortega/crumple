import { replayOne, type Recording, type StartEvalTarget } from './run.js';
import type { Scenario } from './scenarios.js';

// What a real model did on the day a recording was made, replayed against today's server. It shows the
// run happened and that the server still says the same thing. It can't show how often a model gets it
// right: that's the live report's job, and a replay never quotes a rate.

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RecordedEvidence {
  id: string;
  /** Taken from the file. Only `live` says anything about what a real model does. */
  source: Recording['source'] | 'missing';
  model?: string;
  recordedAt?: string;
  status?: string;
  note?: string;
  toolOutcomes: string[];
  providerUsage: Tokens;
  reportedUsage: Tokens;
  costUsd: number | null;
}

const NONE: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Straight from the provider's replies, with none of the agent's own adding up in between. */
function fromReplies(recording: Pick<Recording, 'exchanges'>): Tokens {
  const total = { ...NONE };
  for (const { reply } of recording.exchanges) {
    if (!reply.ok) continue;
    const { usage } = reply.message;
    total.input += usage.input_tokens ?? 0;
    total.output += usage.output_tokens ?? 0;
    total.cacheRead += usage.cache_read_input_tokens ?? 0;
    total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  }
  return total;
}

/** One at a time, like every other check here. */
export async function replayRecordings(found: readonly { scenario: Scenario; recording: Recording | undefined }[], start: StartEvalTarget): Promise<RecordedEvidence[]> {
  const evidence: RecordedEvidence[] = [];
  for (const { scenario, recording } of found) {
    if (!recording) {
      evidence.push({ id: scenario.id, source: 'missing', toolOutcomes: [], providerUsage: NONE, reportedUsage: NONE, costUsd: null });
      continue;
    }
    const row = await replayOne(scenario, recording, start);
    evidence.push({
      id: scenario.id,
      source: recording.source,
      model: recording.model,
      recordedAt: recording.recordedAt,
      status: row.status,
      ...(row.note === undefined ? {} : { note: row.note }),
      toolOutcomes: row.toolCalls.map((call) => call.outcome),
      providerUsage: fromReplies(recording),
      reportedUsage: row.usage,
      costUsd: row.costUsd,
    });
  }
  return evidence;
}
