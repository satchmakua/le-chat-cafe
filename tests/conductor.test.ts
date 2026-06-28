import { describe, it, expect } from 'vitest';
import {
  BASE,
  DEFAULT_CONDUCTOR_CONFIG,
  candidateFor,
  cooldownTurns,
  isQuestion,
  matchesInterest,
  mentionsPersona,
  messagesSinceLastSpoke,
  recentAuthorCount,
  selectSpeakers,
  type SelectContext,
} from '../src/core/conductor';
import type { Message, Persona } from '../src/core/types';

// --- fixtures ---

function persona(over: Partial<Persona> & { id: string }): Persona {
  return {
    name: over.id[0].toUpperCase() + over.id.slice(1),
    color: '#fff',
    systemPrompt: '',
    model: 'mock',
    params: { temperature: 0.8, topP: 0.9 },
    temperament: { talkativeness: 0.5, warmth: 0.5, pettiness: 0.2 },
    interests: [],
    ...over,
  };
}

let seq = 0;
function msg(author: string, text: string): Message {
  return { id: `m${seq++}`, channelId: 'cafe', author, text, ts: seq };
}

const ZERO = () => 0; // pin jitter to 0 for deterministic scores

function ctx(over: Partial<SelectContext>): SelectContext {
  return {
    personas: [],
    messages: [],
    trigger: 'message',
    generating: new Set(),
    config: DEFAULT_CONDUCTOR_CONFIG,
    rng: ZERO,
    ...over,
  };
}

// --- pure predicates ---

describe('predicates', () => {
  const caius = persona({ id: 'caius', name: 'Caius', aliases: ['Cai'], interests: ['coffee', 'art'] });

  it('mentionsPersona matches name and aliases as whole words, case-insensitively', () => {
    expect(mentionsPersona('hey caius!', caius)).toBe(true);
    expect(mentionsPersona('yo Cai', caius)).toBe(true);
    expect(mentionsPersona('caiusing around', caius)).toBe(false); // not a whole word
    expect(mentionsPersona('nobody here', caius)).toBe(false);
  });

  it('isQuestion detects "?" and leading question words', () => {
    expect(isQuestion('what is good coffee')).toBe(true);
    expect(isQuestion('you ok?')).toBe(true);
    expect(isQuestion('the coffee is good')).toBe(false);
  });

  it('matchesInterest uses word boundaries (no "art" inside "start")', () => {
    expect(matchesInterest('i love coffee', caius)).toBe(true);
    expect(matchesInterest('let us start', caius)).toBe(false);
  });

  it('messagesSinceLastSpoke / recentAuthorCount count correctly', () => {
    const log = [msg('caius', 'a'), msg('user', 'b'), msg('mira', 'c')];
    expect(messagesSinceLastSpoke(log, 'caius')).toBe(2);
    expect(messagesSinceLastSpoke(log, 'mira')).toBe(0);
    expect(messagesSinceLastSpoke(log, 'ghost')).toBe(Number.POSITIVE_INFINITY);
    expect(recentAuthorCount(log, 'caius')).toBe(1);
  });

  it('cooldownTurns: talkative=2, reserved=6', () => {
    expect(cooldownTurns(persona({ id: 'a', temperament: { talkativeness: 1, warmth: 0.5, pettiness: 0 } }))).toBe(2);
    expect(cooldownTurns(persona({ id: 'b', temperament: { talkativeness: 0, warmth: 0.5, pettiness: 0 } }))).toBe(6);
  });
});

// --- candidate reasons (priority tiers) ---

describe('candidateFor reason priority', () => {
  const p = persona({ id: 'caius', name: 'Caius', interests: ['coffee'], temperament: { talkativeness: 0, warmth: 0.5, pettiness: 0 } });

  it('mention beats question beats event', () => {
    const mention = candidateFor(p, ctx({ messages: [msg('user', 'hey Caius, coffee?')] }), ZERO);
    expect(mention?.reason).toBe('mention');
    expect(mention?.score).toBe(BASE.mention); // talkativeness 0, jitter 0

    const question = candidateFor(p, ctx({ messages: [msg('user', 'best coffee?')] }), ZERO);
    expect(question?.reason).toBe('question');

    const event = candidateFor(p, ctx({ messages: [msg('user', 'i love coffee')] }), ZERO);
    expect(event?.reason).toBe('event');
  });

  it('returns null when nothing matches on a message trigger', () => {
    expect(candidateFor(p, ctx({ messages: [msg('user', 'hello world')] }), ZERO)).toBeNull();
  });

  it('never reacts to its own message', () => {
    expect(candidateFor(p, ctx({ messages: [msg('caius', 'coffee?')] }), ZERO)).toBeNull();
  });

  it('idle trigger yields an idle candidate regardless of content', () => {
    const c = candidateFor(p, ctx({ trigger: 'idle', messages: [msg('user', 'hello world')] }), ZERO);
    expect(c?.reason).toBe('idle');
  });
});

// --- selection: cooldown, monologue, concurrency, min-score ---

describe('selectSpeakers', () => {
  const caius = persona({ id: 'caius', name: 'Caius', interests: ['coffee'], temperament: { talkativeness: 0.7, warmth: 0.5, pettiness: 0 } });
  const mira = persona({ id: 'mira', name: 'Mira', interests: ['coffee'], temperament: { talkativeness: 0.6, warmth: 0.8, pettiness: 0 } });

  it('a directly-mentioned persona is chosen first', () => {
    const chosen = selectSpeakers(ctx({ personas: [caius, mira], messages: [msg('user', 'Mira, you around?')] }));
    expect(chosen[0]?.personaId).toBe('mira');
    expect(chosen[0]?.reason).toBe('mention');
  });

  it('excludes a persona on cooldown while an eligible one still answers', () => {
    // Latest "best coffee?" qualifies both (question + interest), but caius spoke
    // one message ago (cooldown 3) so only mira — never on cooldown — is chosen.
    const log = [msg('caius', 'hey'), msg('user', 'best coffee?')];
    const chosen = selectSpeakers(ctx({ personas: [caius, mira], messages: log }));
    expect(chosen.map((c) => c.personaId)).not.toContain('caius');
    expect(chosen.map((c) => c.personaId)).toContain('mira');
  });

  it('excludes a persona monologuing (≥3 of last 5)', () => {
    const log = [msg('caius', '1'), msg('user', 'x'), msg('caius', '2'), msg('user', 'coffee?'), msg('caius', '3')];
    // caius authored 3 of the last 5 → excluded even though "coffee?" matches.
    // (also on cooldown here; mira should still be eligible on the question)
    const chosen = selectSpeakers(ctx({ personas: [caius, mira], messages: log }));
    expect(chosen.map((c) => c.personaId)).not.toContain('caius');
  });

  it('respects the concurrency cap (maxConcurrent − generating)', () => {
    const log = [msg('user', 'coffee everyone?')];
    const full = selectSpeakers(ctx({ personas: [caius, mira], messages: log, generating: new Set(['dex', 'x']) }));
    expect(full).toHaveLength(0); // 2 already generating, cap is 2
    const one = selectSpeakers(ctx({ personas: [caius, mira], messages: log, generating: new Set(['dex']) }));
    expect(one).toHaveLength(1); // one slot left
  });

  it('idle picks exactly one, and drops sub-threshold reserved personas', () => {
    const reserved = persona({ id: 'quiet', name: 'Quiet', temperament: { talkativeness: 0, warmth: 0.5, pettiness: 0 } });
    // idle score for reserved = 20 + 0 + 0 = 20 < minScore(25) → not selected.
    const chosen = selectSpeakers(ctx({ personas: [reserved], trigger: 'idle', messages: [msg('user', 'hi')] }));
    expect(chosen).toHaveLength(0);

    // a talkative persona breaks the silence (20 + 0.7*15 = 30.5 ≥ 25).
    const chosen2 = selectSpeakers(ctx({ personas: [reserved, caius], trigger: 'idle', messages: [msg('user', 'hi')] }));
    expect(chosen2).toHaveLength(1);
    expect(chosen2[0].personaId).toBe('caius');
  });

  it('sorts by score so higher-priority reasons win ties of availability', () => {
    // caius mentioned (100-tier), mira only topic-event (40-tier) → caius first.
    const chosen = selectSpeakers(ctx({ personas: [caius, mira], messages: [msg('user', 'Caius likes coffee')] }));
    expect(chosen[0].personaId).toBe('caius');
  });
});
