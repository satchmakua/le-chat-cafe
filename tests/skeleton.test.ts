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
  it('streams tokens that reassemble into the reply and ends with a done frame', async () => {
    const provider = new MockProvider({ delayMs: 0 });
    const chunks: ChatChunk[] = [];

    for await (const chunk of provider.chat({
      model: 'mock',
      messages: [{ role: 'user', content: 'hello there' }],
    })) {
      chunks.push(chunk);
    }

    const text = chunks.map((c) => c.token).join('');
    expect(text).toContain('hello there');
    expect(chunks.at(-1)?.done).toBe(true);
    expect(chunks.filter((c) => c.done)).toHaveLength(1);
  });
});
