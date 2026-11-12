import { describe, it, expect } from 'vitest';
import { validateNick } from '../src/util/nick';
import type { Persona } from '../src/core/types';

const caius: Persona = {
  id: 'caius',
  name: 'Caius',
  aliases: ['Cai'],
  color: '#fff',
  systemPrompt: '',
  model: 'mock',
  params: { temperature: 0.8, topP: 0.9 },
  temperament: { talkativeness: 0.5, warmth: 0.5, pettiness: 0.2 },
  interests: [],
};

describe('validateNick', () => {
  it('accepts an ordinary nick and trims it', () => {
    expect(validateNick('  Satchel ', [caius])).toEqual({ ok: true, nick: 'Satchel' });
    expect(validateNick('night_owl-42', [caius])).toEqual({ ok: true, nick: 'night_owl-42' });
  });

  it('rejects empty, spaced, over-long, or symbol-laden nicks', () => {
    expect(validateNick('', [caius]).ok).toBe(false);
    expect(validateNick('two words', [caius]).ok).toBe(false);
    expect(validateNick('x'.repeat(21), [caius]).ok).toBe(false);
    expect(validateNick('§aff', [caius]).ok).toBe(false);
  });

  it('rejects reserved words and anything a persona already goes by', () => {
    expect(validateNick('user', [caius]).ok).toBe(false);
    expect(validateNick('System', [caius]).ok).toBe(false);
    expect(validateNick('caius', [caius]).ok).toBe(false); // name, case-insensitive
    expect(validateNick('CAI', [caius]).ok).toBe(false); // alias
  });
});
