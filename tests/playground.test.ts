import { describe, it, expect } from 'vitest';
import {
  buildABPrompt,
  lastPersonaMessage,
  mergePersona,
  truncateAfter,
} from '../src/runtime/playground';
import type { Message, Persona } from '../src/core/types';

const base: Persona = {
  id: 'caius',
  name: 'Caius',
  color: '#fff',
  systemPrompt: 'You are Caius.',
  model: 'llama3.2:3b',
  params: { temperature: 0.8, topP: 0.9 },
  temperament: { talkativeness: 0.7, warmth: 0.6, pettiness: 0.2 },
  interests: ['coffee'],
};

let seq = 0;
const msg = (author: string, text: string): Message => ({
  id: `m${seq++}`,
  channelId: 'cafe',
  author,
  text,
  ts: seq,
});

describe('mergePersona', () => {
  it('overrides top-level and nested fields without mutating the base', () => {
    const edited = mergePersona(base, { systemPrompt: 'New.', params: { temperature: 0.2, topP: 0.9 } });
    expect(edited.systemPrompt).toBe('New.');
    expect(edited.params.temperature).toBe(0.2);
    expect(edited.model).toBe('llama3.2:3b'); // untouched
    expect(base.systemPrompt).toBe('You are Caius.'); // base intact
  });
});

describe('truncateAfter', () => {
  it('keeps up to and including the id, removing the rest', () => {
    const log = [msg('user', 'a'), msg('caius', 'b'), msg('mira', 'c')];
    const { kept, removed } = truncateAfter(log, log[1].id);
    expect(kept.map((m) => m.text)).toEqual(['a', 'b']);
    expect(removed.map((m) => m.text)).toEqual(['c']);
  });

  it('is a no-op for an unknown id', () => {
    const log = [msg('user', 'a')];
    const { kept, removed } = truncateAfter(log, 'nope');
    expect(kept).toHaveLength(1);
    expect(removed).toHaveLength(0);
  });
});

describe('lastPersonaMessage', () => {
  it('returns the most recent non-user, non-empty message', () => {
    const log = [msg('caius', 'old'), msg('mira', 'newest'), msg('user', 'hi'), msg('dex', '')];
    expect(lastPersonaMessage(log)?.text).toBe('newest');
  });

  it('returns undefined when only user/empty messages exist', () => {
    expect(lastPersonaMessage([msg('user', 'hi')])).toBeUndefined();
  });
});

describe('buildABPrompt', () => {
  it('uses the persona system prompt and the raw user prompt', () => {
    const [system, user] = buildABPrompt(base, 'pitch me a coffee');
    expect(system.role).toBe('system');
    expect(system.content).toContain('You are Caius.');
    expect(user).toEqual({ role: 'user', content: 'pitch me a coffee' });
  });
});
