import type { ChatChunk, ChatRequest, GenerateRequest, LLMProvider } from './provider';

export interface OllamaOptions {
  /** Defaults to Ollama's local default. */
  baseUrl?: string;
}

/**
 * Real local-LLM provider. Talks straight to the Ollama HTTP API from the
 * browser. NOTE (DESIGN §9): browser → localhost:11434 is CORS-blocked unless
 * Ollama is started with OLLAMA_ORIGINS allowing the dev origin.
 *
 * The chat endpoint streams NDJSON (one JSON object per line); we parse line by
 * line and yield content tokens. Structured output (`generate` with `format`)
 * is one-shot only and must not be combined with streaming (DESIGN §6.4).
 */
export class OllamaProvider implements LLMProvider {
  private readonly baseUrl: string;

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
        options: req.options,
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(
        `Ollama chat failed (${res.status} ${res.statusText}). Is Ollama running, ` +
          `the model pulled, and OLLAMA_ORIGINS set for the browser origin?`,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        const frame = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        const token = frame.message?.content ?? '';
        if (token) yield { token, done: false };
        if (frame.done) {
          yield { token: '', done: true };
          return;
        }
      }
    }
    yield { token: '', done: true };
  }

  async generate(req: GenerateRequest): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        stream: false,
        format: req.format,
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama generate failed (${res.status} ${res.statusText}).`);
    }
    const data = (await res.json()) as { response?: string };
    return data.response ?? '';
  }
}
