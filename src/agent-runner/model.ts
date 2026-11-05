// The line between the loop and a model. Replay sits exactly here, which is why it's this small.
//
// The shapes are Claude's Messages API, because that's the one adapter there is. A second provider
// would translate to and from these.

export type ContentBlock =
  | { type: 'text'; text: string; [key: string]: unknown }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; [key: string]: unknown }
  // Thinking blocks and anything newer. These go back exactly as they came.
  | { type: string; [key: string]: unknown };

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: true;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | readonly (ContentBlock | ToolResultBlock)[];
}

export interface ClaudeTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface ModelRequest {
  model: string;
  max_tokens: number;
  system: string;
  tools: ClaudeTool[];
  messages: Message[];
  output_config: { effort: string };
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeMessage {
  role: 'assistant';
  content: ContentBlock[];
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  usage: Usage;
}

export type ModelErrorCode = 'auth' | 'bad_request' | 'rate_limited' | 'overloaded' | 'server_error' | 'timeout' | 'unreachable' | 'invalid_response' | 'max_usd' | 'stale';

export type ModelReply =
  | { ok: true; message: ClaudeMessage }
  | { ok: false; code: ModelErrorCode; status?: number; requestId?: string; detail?: string };

export interface ModelCallOptions {
  signal: AbortSignal;
  /** Asked before each attempt, retries included. No means the money has run out. */
  mayAttempt(): boolean;
  /** An attempt's answer was lost, so what it cost can't be known. */
  onLost(): void;
}

export interface ModelClient {
  readonly name: string;
  complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelReply>;
}
