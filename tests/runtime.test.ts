import { describe, it, expect } from 'vitest';
import {
  buildPrompt,
  buildPromptParts,
  formatTranscript,
  recitationSource,
} from '../src/runtime/personaRuntime';
import { recitesPrompt } from '../src/runtime/repetition';
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
    expect(system.content).toContain('§aff'); // always teaches the affinity sentinel

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
    const [, user] = buildPrompt(caius, many, [caius, mira], { window: 5 });
    expect(user.content).toContain('line 29');
    expect(user.content).not.toContain('line 24'); // outside the last 5
  });

  it('names you by your nick: transcript label, roster, feelings, sentinel key', () => {
    const youSaid: Message[] = [{ id: 'u', channelId: 'cafe', author: 'user', text: 'evening!', ts: 1 }];
    const [system, user] = buildPrompt(caius, youSaid, [caius, mira], {
      names: { user: 'Satchel' },
      affinities: { user: 0.7 },
    });
    expect(user.content).toContain('Satchel: evening!');
    expect(user.content).not.toContain('user: evening!');
    expect(system.content).toContain('Mira, and Satchel');
    expect(system.content).toContain('warmly and fondly toward Satchel');
    expect(system.content).toContain(`"user" (that's Satchel)`);
  });

  it('frames the character text as private notes and keeps replies inside the fiction', () => {
    const [system] = buildPrompt(caius, log, [caius, mira]);
    expect(system.content.startsWith('You are Caius, chatting')).toBe(true); // room first
    expect(system.content).toContain('private notes');
    expect(system.content).toContain('never talk about being an AI');
  });

  it('recitation source covers injected feelings but leaves memory quotable', () => {
    const parts = buildPromptParts(caius, log, [caius, mira], {
      names: { user: 'Satchel' },
      affinities: { user: 0 },
      notes: ['Satchel works long shifts at the hospital'],
    });
    const source = recitationSource(parts);
    // Verbatim from a live run: Juno emoted her own injected feelings line.
    expect(recitesPrompt('* I feel neutral toward Satchel.*', source)).toBe(true);
    // Referring back to a remembered fact is the point of memory — never dropped.
    expect(recitesPrompt('long shifts at the hospital again tonight?', source)).toBe(false);
  });

  it('roster lists only personas present, and a directive rides the user turn', () => {
    const [system, user] = buildPrompt(caius, log, [caius, mira], {
      present: ['caius'],
      directive: 'You just walked in — say hi.',
    });
    expect(system.content).not.toContain('Mira, and');
    expect(user.content).toContain('(You just walked in — say hi.)');
    expect(user.content.trim().endsWith('Respond as Caius:')).toBe(true);
  });

  it('lists every human in a shared room', () => {
    const [system] = buildPrompt(caius, log, [caius, mira], { humans: ['Ann', 'Bob'] });
    expect(system.content).toContain('Mira, Ann, and Bob');
  });

  it('injects notes and feelings when provided', () => {
    const [system] = buildPrompt(caius, log, [caius, mira], {
      notes: ['user is a dad to Atlas'],
      affinities: { user: 0.7, mira: -0.5 },
    });
    expect(system.content).toContain('What you remember:');
    expect(system.content).toContain('user is a dad to Atlas');
    expect(system.content).toContain('warmly and fondly toward the user'); // 0.7 band
    expect(system.content).toContain('Mira'); // peer feeling shown (|−0.5| ≥ 0.3)
  });
});

describe('formatTranscript', () => {
  const sys = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
    id,
    channelId: 'cafe',
    author: 'system',
    text,
    ts: Number(id),
    ...extra,
  });

  it('writes room events as bracketed narration, never as a "system:" speaker', () => {
    const out = formatTranscript(
      [
        sys('1', '* Mira has joined #cafe *', { presence: { who: 'mira', state: 'join' } }),
        { id: '2', channelId: 'cafe', author: 'mira', text: 'hi all', ts: 2 },
        sys('3', '* Satchel waves *'),
      ],
      [caius, mira],
    );
    expect(out).toBe('[Mira has joined #cafe]\nMira: hi all\n[Satchel waves]');
    expect(out).not.toContain('system:');
  });

  it('re-strips stored persona lines so leaked markup is never re-taught', () => {
    const out = formatTranscript(
      [
        { id: '1', channelId: 'cafe', author: 'mira', text: '§{"user": 0.15}', ts: 1 },
        { id: '2', channelId: 'cafe', author: 'mira', text: 'so true §aff {"user": 0.1}§', ts: 2 },
        { id: '3', channelId: 'cafe', author: 'user', text: 'what does § mean?', ts: 3 },
      ],
      [caius, mira],
    );
    expect(out).toBe('Mira: so true\nuser: what does § mean?'); // humans are quoted as typed
  });

  it('leaves UI notices (command output, the welcome) out of the prompt', () => {
    const out = formatTranscript(
      [sys('1', '* welcome to le-chat-cafe *', { notice: true }), sys('2', '* unknown command: /x *', { notice: true })],
      [caius, mira],
    );
    expect(out).toBe('');
  });
});
