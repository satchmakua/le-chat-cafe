// The LLMProvider port (DESIGN §6.5). The persona runtime talks to models only
// through this interface, so Ollama is one implementation among potential others
// (a MockProvider for tests; a cloud adapter post-v1). Nothing above this layer
// knows an LLM exists.

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatChunk {
  /** A piece of the streamed reply. Empty string is valid (e.g. the final done frame). */
  token: string;
  /** True on the terminal frame of the stream. */
  done: boolean;
}

export interface ChatRequest {
  model: string;
  messages: ChatTurn[];
  options?: { temperature?: number; top_p?: number };
}

export interface GenerateRequest {
  model: string;
  prompt: string;
  /** JSON schema for Ollama structured outputs. NOTE: structured output is
   *  one-shot only — it cannot be combined with streaming (DESIGN §6.4). */
  format?: object;
}

export interface LLMProvider {
  /** Streaming reply for a visible chat turn. */
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  /** One-shot, non-streamed call — used for summarization and (optional) affinity. */
  generate(req: GenerateRequest): Promise<string>;
}
