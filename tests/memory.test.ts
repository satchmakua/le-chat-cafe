import { describe, it, expect } from 'vitest';
import {
  buildSummaryPrompt,
  mergeNotes,
  olderThanWindow,
  parseNotes,
  shouldSummarize,
  summarizeForPersona,
} from '../src/runtime/memory';
import { MockProvider } from '../src/llm/mock';
import type { Message, Persona } from '../src/core/types';

const persona: Persona = {
  id: 'caius',
  name: 'Caius',
  color: '#fff',
  systemPrompt: '',
  model: 'mock',
  params: { temperature: 0.8, topP: 0.9 },
  temperament: { talkativeness: 0.5, warmth: 0.5, pettiness: 0.2 },
  interests: [],
};

const mkMsgs = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), channelId: 'cafe', author: 'user', text: `line ${i}`, ts: i }));

describe('memory helpers', () => {
  it('olderThanWindow returns everything past the verbatim window', () => {
    expect(olderThanWindow(mkMsgs(20), 16)).toHaveLength(4);
    expect(olderThanWindow(mkMsgs(10), 16)).toHaveLength(0);
  });

  it('shouldSummarize triggers only once enough history ages out', () => {
    expect(shouldSummarize(16 + 30, 0)).toBe(true);
    expect(shouldSummarize(16 + 29, 0)).toBe(false);
    expect(shouldSummarize(16 + 30, 30)).toBe(false); // already summarized
  });

  it('parseNotes strips bullets/numbering, drops blanks, and caps', () => {
    expect(parseNotes('- a\n* b\n1. c\n\n   \n- d')).toEqual(['a', 'b', 'c']);
  });

  it('mergeNotes keeps the most recent MAX_NOTES', () => {
    const existing = Array.from({ length: 11 }, (_, i) => `n${i}`);
    const merged = mergeNotes(existing, ['x', 'y', 'z']);
    expect(merged).toHaveLength(12);
    expect(merged[0]).toBe('n2'); // oldest two dropped
    expect(merged.at(-1)).toBe('z');
  });

  it('buildSummaryPrompt embeds the persona name and transcript', () => {
    const prompt = buildSummaryPrompt(persona, 'user: hi');
    expect(prompt).toContain('Caius');
    expect(prompt).toContain('user: hi');
  });

  it('summarizeForPersona returns parsed notes via the provider port', async () => {
    const notes = await summarizeForPersona(new MockProvider({ delayMs: 0 }), persona, 'user: i love coffee');
    expect(Array.isArray(notes)).toBe(true);
    expect(notes.length).toBeGreaterThan(0);
  });
});
