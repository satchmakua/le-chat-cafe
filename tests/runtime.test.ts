import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../src/runtime/personaRuntime';
import type { Message, Persona } from '../src/core/types';

const caius: Persona = {
  id: 'caius',
  name: 'Caius',
  color: '#fff',
  systemPrompt: 'You are Caius.',
  model: 'llama3.2:3b',
  params: { temperature: 0.8, topP: 0.9 },
  temperament: { talkativeness: 0.7, warmth: 0.6, pettiness: 0.2 },
  interests: ['coffee'],
};
const mira: Persona = { ...caius, id: 'mira', name: 'Mira', systemPrompt: 'You are Mira.' };

const log: Message[] = [
  { id: '1', channelId: 'cafe', author: 'user', text: 'morning all', ts: 1 },
  { id: '2', channelId: 'cafe', author: 'mira', text: 'morning!', ts: 2 },
  { id: '3', channelId: 'cafe', author: 'pending', text: '', ts: 3 }, // empty → dropped
];

describe('buildPrompt', () => {
  it('builds a system turn (character + roster) and a labelled transcript user turn', () => {
    const [system, user] = buildPrompt(caius, log, [caius, mira]);

    expect(system.role).toBe('system');
    expect(system.content).toContain('You are Caius.');
    expect(system.content).toContain('Mira, and the user'); // roster excludes self

    expect(user.role).toBe('user');
    expect(user.content).toContain('user: morning all');
    expect(user.content).toContain('Mira: morning!');
    expect(user.content).not.toContain('pending:'); // empty messages filtered out
    expect(user.content.trim().endsWith('Respond as Caius:')).toBe(true);
  });

  it('honours the working-memory window', () => {
    const many: Message[] = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      channelId: 'cafe',
      author: 'user',
      text: `line ${i}`,
      ts: i,
    }));
    const [, user] = buildPrompt(caius, many, [caius, mira], 5);
    expect(user.content).toContain('line 29');
    expect(user.content).not.toContain('line 24'); // outside the last 5
  });
});
