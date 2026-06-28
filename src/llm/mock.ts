import type { ChatChunk, ChatRequest, GenerateRequest, LLMProvider } from './provider';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A scripted provider that needs no Ollama install. It streams a canned reply
 * token-by-token so the M0 chat surface (and the persona-runtime seam) can be
 * exercised in the browser and in CI. Tests pass `delayMs: 0` for speed.
 */
export class MockProvider implements LLMProvider {
  private readonly delayMs: number;

  constructor(opts: { delayMs?: number } = {}) {
    this.delayMs = opts.delayMs ?? 25;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const last = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    const reply = `mm, "${last}" — tell me more.`;
    for (const token of reply.match(/\S+\s*/g) ?? []) {
      if (this.delayMs) await sleep(this.delayMs);
      yield { token, done: false };
    }
    yield { token: '', done: true };
  }

  async generate(req: GenerateRequest): Promise<string> {
    return `mock(${req.model}): ${req.prompt.slice(0, 60)}`;
  }
}
