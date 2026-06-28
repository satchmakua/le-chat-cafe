import { describe, it, expect } from 'vitest';
import { formatTimestamp } from '../src/util/format';
import { MockProvider } from '../src/llm/mock';
import type { ChatChunk } from '../src/llm/provider';

describe('formatTimestamp', () => {
  it('formats a fixed time as zero-padded [HH:MM]', () => {
    const ts = new Date(2026, 5, 27, 9, 5).getTime(); // local 09:05
    expect(formatTimestamp(ts)).toBe('[09:05]');
  });
});

describe('MockProvider (the LLMProvider seam)', () => {
  async function drain(provider: MockProvider): Promise<ChatChunk[]> {
    const chunks: ChatChunk[] = [];
    for await (const chunk of provider.chat({
      model: 'mock',
      messages: [{ role: 'user', content: 'hello there' }],
    })) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it('streams tokens that reassemble into a non-empty line ending with one done frame', async () => {
    const chunks = await drain(new MockProvider({ delayMs: 0, rng: () => 0 }));
    const text = chunks.map((c) => c.token).join('');
    expect(text.length).toBeGreaterThan(0);
    expect(chunks.at(-1)?.done).toBe(true);
    expect(chunks.filter((c) => c.done)).toHaveLength(1);
  });

  it('is deterministic for a pinned rng', async () => {
    const a = (await drain(new MockProvider({ delayMs: 0, rng: () => 0 }))).map((c) => c.token).join('');
    const b = (await drain(new MockProvider({ delayMs: 0, rng: () => 0 }))).map((c) => c.token).join('');
    expect(a).toBe(b);
  });
});
