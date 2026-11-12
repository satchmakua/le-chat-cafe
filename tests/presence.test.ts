import { describe, it, expect } from 'vitest';
import {
  MIN_ONLINE,
  nextPresenceDelay,
  onlineSet,
  planPresenceChange,
  presenceState,
  quitMessage,
  sociabilityOf,
} from '../src/core/presence';
import type { Message, Persona } from '../src/core/types';

function persona(id: string, sociability?: number, quits?: string[]): Persona {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    color: '#fff',
    systemPrompt: '',
    model: 'mock',
    params: { temperature: 0.8, topP: 0.9 },
    temperament: { talkativeness: 0.5, warmth: 0.5, pettiness: 0.2, sociability },
    interests: [],
    quits,
  };
}

let seq = 0;
const event = (who: string, state: 'join' | 'leave'): Message => ({
  id: `p${seq++}`,
  channelId: 'cafe',
  author: 'system',
  text: `* ${who} ${state} *`,
  ts: seq,
  presence: { who, state },
});
const chat = (author: string, text: string): Message => ({ id: `m${seq++}`, channelId: 'cafe', author, text, ts: seq });

const four = [persona('caius', 0.8), persona('mira', 0.75), persona('dex', 0.5), persona('juno', 0.65)];

describe('presenceState', () => {
  it('defaults everyone to online when the log has no presence events', () => {
    expect(presenceState([chat('user', 'hi')], ['caius', 'dex'])).toEqual({ caius: 'online', dex: 'online' });
  });

  it('lets the latest event per persona win and ignores unknown ids', () => {
    const log = [event('dex', 'leave'), chat('caius', 'later dex'), event('dex', 'join'), event('mira', 'leave'), event('ghost', 'leave')];
    expect(presenceState(log, ['caius', 'mira', 'dex'])).toEqual({ caius: 'online', mira: 'away', dex: 'online' });
  });

  it('onlineSet returns just the ids that are present', () => {
    expect([...onlineSet([event('dex', 'leave')], four)].sort()).toEqual(['caius', 'juno', 'mira']);
  });
});

describe('planPresenceChange', () => {
  const allOnline = new Set(four.map((p) => p.id));
  const none = new Set<string>();

  it('an rng of 0 lands on "nothing happens"', () => {
    expect(planPresenceChange(four, allOnline, none, () => 0)).toBeNull();
  });

  it('never drops the room below MIN_ONLINE', () => {
    const twoOnline = new Set(['caius', 'mira']);
    for (const r of [0.1, 0.3, 0.5, 0.7, 0.9, 0.999]) {
      const change = planPresenceChange(four, twoOnline, none, () => r);
      if (change) expect(change.state).toBe('join'); // only arrivals are allowed
    }
    expect(MIN_ONLINE).toBe(2);
  });

  it('never moves a blocked persona (mid-reply, or kicked)', () => {
    // Only dex is away and he is blocked (kicked); nobody may leave either (at min).
    const online = new Set(['caius', 'mira', 'juno']);
    for (const r of [0.05, 0.25, 0.5, 0.75, 0.95, 0.999]) {
      const change = planPresenceChange(four, online, new Set(['dex', 'caius', 'mira', 'juno']), () => r);
      expect(change).toBeNull();
    }
  });

  it('a persona who always stays (sociability 1) never leaves', () => {
    const homebodies = [persona('a', 1), persona('b', 1), persona('c', 1)];
    const online = new Set(['a', 'b', 'c']);
    for (const r of [0.2, 0.6, 0.999]) expect(planPresenceChange(homebodies, online, none, () => r)).toBeNull();
  });

  it('an away persona can come back', () => {
    const online = new Set(['caius', 'mira', 'juno']);
    const change = planPresenceChange(four, online, new Set(['caius', 'mira', 'juno']), () => 0.999);
    expect(change).toEqual({ who: 'dex', state: 'join' });
  });
});

describe('sociability, quits, and pacing', () => {
  it('sociability defaults to 0.7 and is clamped', () => {
    expect(sociabilityOf(persona('x'))).toBe(0.7);
    expect(sociabilityOf(persona('x', 3))).toBe(1);
  });

  it('quit messages come from the persona when it has some', () => {
    expect(quitMessage(persona('dex', 0.5, ['compiling. bye']), () => 0)).toBe('compiling. bye');
    expect(quitMessage(persona('dex'), () => 0)).toBe('Leaving'); // default pool
  });

  it('presence delay jitters ±40% and 0 disables it', () => {
    expect(nextPresenceDelay(0)).toBeNull();
    expect(nextPresenceDelay(100_000, () => 0)).toBe(60_000);
    expect(nextPresenceDelay(100_000, () => 1)).toBe(140_000);
  });
});
