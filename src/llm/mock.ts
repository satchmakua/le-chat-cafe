import type { ChatChunk, ChatRequest, GenerateRequest, LLMProvider } from './provider';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A small pool of generic chat lines so a no-Ollama run still *shows* the
// Conductor taking turns (different personas saying different things). With
// Ollama connected these are never used. Tests pin `rng` for determinism.
const LINES = [
  'ha, fair enough.',
  'wait, say more about that.',
  'honestly? same here.',
  "hmm, i'm not so sure.",
  'oh, that reminds me of something.',
  'lol okay okay.',
  'the café feels alive tonight.',
  'anyone else need more coffee?',
];

/**
 * A scripted provider that needs no Ollama install. Streams a canned line
 * token-by-token so the M0/M1 chat surface and the persona-runtime seam can be
 * exercised in the browser and in CI. Tests pass `{ delayMs: 0, rng }`.
 */
export class MockProvider implements LLMProvider {
  private readonly delayMs: number;
  private readonly rng: () => number;

  constructor(opts: { delayMs?: number; rng?: () => number } = {}) {
    this.delayMs = opts.delayMs ?? 25;
    this.rng = opts.rng ?? Math.random;
  }

  async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
    const line = LINES[Math.floor(this.rng() * LINES.length)] ?? LINES[0];
    for (const token of line.match(/\S+\s*/g) ?? []) {
      if (this.delayMs) await sleep(this.delayMs);
      yield { token, done: false };
    }
    yield { token: '', done: true };
  }

  async generate(req: GenerateRequest): Promise<string> {
    return `mock(${req.model}): ${req.prompt.slice(0, 60)}`;
  }
}
