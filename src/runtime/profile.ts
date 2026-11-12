// Profiles — `/whois` (DESIGN §12.3). A read-out of state the friendship sim already
// keeps: how a persona feels about you and the others, what it remembers, whether
// it's here. Pure; no model call, and nothing is written to the log.

import type { Message, Persona } from '../core/types';

export type AffinityLabel = 'fond' | 'friendly' | 'neutral' | 'guarded' | 'cold';
export type ProfileStatus = 'here' | 'away' | 'kicked';

/** Same bands as `affinityPhrase`, as a single word for the card. */
export function affinityLabel(a: number): AffinityLabel {
  if (a >= 0.6) return 'fond';
  if (a >= 0.2) return 'friendly';
  if (a > -0.2) return 'neutral';
  if (a > -0.6) return 'guarded';
  return 'cold';
}

export interface Feeling {
  id: string;
  name: string;
  color: string;
  value: number;
  label: AffinityLabel;
}

export interface Profile {
  id: string;
  name: string;
  color: string;
  bio: string;
  interests: string[];
  model: string;
  status: ProfileStatus;
  towardYou: { value: number; label: AffinityLabel };
  /** Their strongest feelings about the other personas, strongest first. */
  peers: Feeling[];
  /** Most recent long-term notes, newest last. */
  remembers: string[];
  /** When they last said something, if ever. */
  lastSpokeTs: number | null;
}

export interface ProfileContext {
  personas: Persona[];
  messages: Message[];
  online: ReadonlySet<string>;
  muted: string[];
  notes: string[];
  /** The model tag actually used for them (after install fallback). */
  model: string;
  affinityOf: (from: string, to: string) => number;
}

export const PEER_LIMIT = 3;
export const NOTE_LIMIT = 5;

export function buildProfile(persona: Persona, ctx: ProfileContext): Profile {
  const status: ProfileStatus = ctx.muted.includes(persona.id)
    ? 'kicked'
    : ctx.online.has(persona.id)
      ? 'here'
      : 'away';

  const toYou = ctx.affinityOf(persona.id, 'user');
  const peers = ctx.personas
    .filter((p) => p.id !== persona.id)
    .map((p) => {
      const value = ctx.affinityOf(persona.id, p.id);
      return { id: p.id, name: p.name, color: p.color, value, label: affinityLabel(value) };
    })
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, PEER_LIMIT);

  let lastSpokeTs: number | null = null;
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i];
    if (m.author === persona.id && !m.pending) {
      lastSpokeTs = m.ts;
      break;
    }
  }

  return {
    id: persona.id,
    name: persona.name,
    color: persona.color,
    bio: persona.bio ?? '',
    interests: persona.interests,
    model: ctx.model,
    status,
    towardYou: { value: toYou, label: affinityLabel(toYou) },
    peers,
    remembers: ctx.notes.slice(-NOTE_LIMIT),
    lastSpokeTs,
  };
}

/** "just now", "4m ago", "2h ago", "3d ago". */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
