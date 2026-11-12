// Presence — personas come and go (DESIGN §12.2). PURE, like the Conductor.
//
// Presence is derived from the message log: a presence event is an ordinary
// system message carrying `presence: { who, state }`, and the latest event per
// persona wins (no event = online). Riding the log means persistence and
// multiplayer sync come free — the host broadcasts presence lines like any other
// message and every client derives the same state from them.

import type { Message, Persona, PresenceChange } from './types';

export type PresenceStatus = 'online' | 'away';

/** Never let the room empty out. */
export const MIN_ONLINE = 2;
export const DEFAULT_SOCIABILITY = 0.7;
/** Weight of "nothing happens this tick", so comings and goings stay occasional. */
export const STAY_WEIGHT = 1;

const DEFAULT_QUITS = [
  'Leaving',
  'Ping timeout: 240 seconds',
  'Read error: Connection reset by peer',
  'brb',
];

/** Latest presence event per persona wins; personas with no event are online. */
export function presenceState(messages: Message[], ids: string[]): Record<string, PresenceStatus> {
  const state: Record<string, PresenceStatus> = {};
  for (const id of ids) state[id] = 'online';
  for (const m of messages) {
    if (m.presence && m.presence.who in state) {
      state[m.presence.who] = m.presence.state === 'join' ? 'online' : 'away';
    }
  }
  return state;
}

/** The set of persona ids currently online. */
export function onlineSet(messages: Message[], personas: Persona[]): Set<string> {
  const state = presenceState(
    messages,
    personas.map((p) => p.id),
  );
  return new Set(Object.keys(state).filter((id) => state[id] === 'online'));
}

export function sociabilityOf(persona: Persona): number {
  const s = persona.temperament.sociability ?? DEFAULT_SOCIABILITY;
  return Math.max(0, Math.min(1, s));
}

/**
 * Decide at most one presence change. Online personas may leave (weight
 * 1 − sociability) as long as more than `minOnline` remain; away personas may
 * return (weight sociability); "nothing happens" carries `STAY_WEIGHT`. `blocked`
 * personas can't change — mid-reply ones can't leave, kicked ones can't return.
 */
export function planPresenceChange(
  personas: Persona[],
  online: ReadonlySet<string>,
  blocked: ReadonlySet<string>,
  rng: () => number,
  minOnline = MIN_ONLINE,
): PresenceChange | null {
  const onlineCount = personas.filter((p) => online.has(p.id)).length;
  const options: { change: PresenceChange | null; weight: number }[] = [
    { change: null, weight: STAY_WEIGHT },
  ];
  for (const p of personas) {
    if (blocked.has(p.id)) continue;
    const s = sociabilityOf(p);
    if (online.has(p.id)) {
      if (onlineCount > minOnline) options.push({ change: { who: p.id, state: 'leave' }, weight: 1 - s });
    } else {
      options.push({ change: { who: p.id, state: 'join' }, weight: s });
    }
  }
  const total = options.reduce((sum, o) => sum + o.weight, 0);
  let r = rng() * total;
  for (const o of options) {
    r -= o.weight;
    if (r < 0) return o.change;
  }
  return null;
}

/** An IRC-style quit message, persona-flavoured when the persona defines some. */
export function quitMessage(persona: Persona, rng: () => number): string {
  const pool = persona.quits && persona.quits.length > 0 ? persona.quits : DEFAULT_QUITS;
  return pool[Math.floor(rng() * pool.length)] ?? 'Leaving';
}

/** Delay before the next presence tick: ±40% jitter around the mean; 0 disables. */
export function nextPresenceDelay(meanMs: number, rng: () => number = Math.random): number | null {
  if (meanMs <= 0) return null;
  return Math.round(meanMs * (0.6 + rng() * 0.8));
}
