// The Conductor — the domain-critical turn-taking core (DESIGN §4).
//
// This module is PURE: given the current log, the roster, who's already
// generating, the trigger, and an RNG, it returns who should speak now. It owns
// no timers and no I/O — the store drives ticks and runs the chosen personas.
// Purity is what makes the social dynamics unit-testable with a pinned RNG.

import type { ConductorConfig, Message, Persona, Reason, TurnCandidate } from './types';

export type Trigger = 'message' | 'idle';

/** Base priority by reason — the dominant term in a candidate's score (§4.2). */
export const BASE: Record<Reason, number> = {
  mention: 100, // their nick (or alias) appears in the latest message
  question: 60, // latest message is a question AND matches their interests
  event: 40, // a topic they care about surfaced in the latest message
  idle: 20, // the room has been quiet past idleMs
};

export const DEFAULT_CONDUCTOR_CONFIG: ConductorConfig = {
  idleMs: 12_000,
  maxConcurrent: 2,
  minScore: 25,
  monologueCap: 3, // of the last MONOLOGUE_WINDOW messages
  chattinessWeight: 15,
  jitterMax: 10,
};

const MONOLOGUE_WINDOW = 5;

const WH_QUESTION =
  /^(what|why|how|who|whom|whose|where|when|which|can|could|would|will|do|does|did|is|are|am|should|shall|may|might)\b/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Pure predicates (exported for testing) ---

/** Whole-word, case-insensitive match of the persona's name or any alias. */
export function mentionsPersona(text: string, persona: Persona): boolean {
  const names = [persona.name, ...(persona.aliases ?? [])];
  return names.some((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`, 'i').test(text));
}

/** Heuristic: ends with '?' or opens with a wh-/aux question word. */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  return t.endsWith('?') || WH_QUESTION.test(t);
}

/** Any of the persona's interest keywords appears as a whole word. */
export function matchesInterest(text: string, persona: Persona): boolean {
  return persona.interests.some((k) =>
    new RegExp(`\\b${escapeRegExp(k)}\\b`, 'i').test(text),
  );
}

/** How many messages have been appended since this persona last spoke (∞ if never). */
export function messagesSinceLastSpoke(messages: Message[], personaId: string): number {
  for (let i = messages.length - 1, n = 0; i >= 0; i--, n++) {
    if (messages[i].author === personaId) return n;
  }
  return Number.POSITIVE_INFINITY;
}

/** Cooldown length in turns: talkative → 2, reserved → 6 (§4.4). */
export function cooldownTurns(persona: Persona): number {
  return Math.round(2 + (1 - persona.temperament.talkativeness) * 4);
}

function onCooldown(messages: Message[], persona: Persona): boolean {
  return messagesSinceLastSpoke(messages, persona.id) < cooldownTurns(persona);
}

/** Count this persona's messages within the recent window. */
export function recentAuthorCount(
  messages: Message[],
  personaId: string,
  window = MONOLOGUE_WINDOW,
): number {
  return messages.slice(-window).filter((m) => m.author === personaId).length;
}

function monologuing(messages: Message[], personaId: string, config: ConductorConfig): boolean {
  return recentAuthorCount(messages, personaId) >= config.monologueCap;
}

// --- Candidate generation + selection ---

export interface SelectContext {
  personas: Persona[];
  messages: Message[];
  trigger: Trigger;
  generating: ReadonlySet<string>;
  config: ConductorConfig;
  /** Injectable for deterministic tests; defaults to Math.random. */
  rng?: () => number;
}

/** The single best candidate for one persona, or null if it has no reason to speak. */
export function candidateFor(
  persona: Persona,
  ctx: SelectContext,
  rng: () => number,
): TurnCandidate | null {
  let reason: Reason | null = null;

  if (ctx.trigger === 'idle') {
    reason = 'idle';
  } else {
    const latest = ctx.messages.at(-1);
    // Never react to your own message (also enforced by cooldown).
    if (latest && latest.author !== persona.id) {
      if (mentionsPersona(latest.text, persona)) reason = 'mention';
      else if (isQuestion(latest.text) && matchesInterest(latest.text, persona)) reason = 'question';
      else if (matchesInterest(latest.text, persona)) reason = 'event';
    }
  }

  if (!reason) return null;

  const score =
    BASE[reason] +
    persona.temperament.talkativeness * ctx.config.chattinessWeight +
    rng() * ctx.config.jitterMax;

  return { personaId: persona.id, reason, score };
}

/**
 * Decide who speaks this tick (§4.4): generate + score candidates, drop those
 * on cooldown / monologuing / below minScore, sort by score, and return up to
 * the available concurrency slots — exactly one on an idle tick.
 */
export function selectSpeakers(ctx: SelectContext): TurnCandidate[] {
  const rng = ctx.rng ?? Math.random;
  const slots = ctx.config.maxConcurrent - ctx.generating.size;
  if (slots <= 0) return [];

  const candidates: TurnCandidate[] = [];
  for (const persona of ctx.personas) {
    if (ctx.generating.has(persona.id)) continue;
    if (onCooldown(ctx.messages, persona)) continue;
    if (monologuing(ctx.messages, persona.id, ctx.config)) continue;

    const candidate = candidateFor(persona, ctx, rng);
    if (candidate && candidate.score >= ctx.config.minScore) candidates.push(candidate);
  }

  candidates.sort((a, b) => b.score - a.score);

  const limit = ctx.trigger === 'idle' ? 1 : slots;
  return candidates.slice(0, Math.min(limit, slots));
}
