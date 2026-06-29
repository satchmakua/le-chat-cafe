// Affinity — the friendship-sim core (DESIGN §6.6). All pure, so it's fully
// unit-tested. Personas optionally end a turn with a hidden machine line:
//
//     §aff {"user": 0.05, "mira": -0.02}§
//
// The runtime strips it before display (streaming-safe — see visibleText), clamps
// each delta to ±0.15/turn, applies it, and persists. Affinity decays toward 0 on
// each session load so relationships don't spiral. This rides the *streamed* turn
// because structured outputs can't combine with streaming (DESIGN §6.4).

import type { Persona } from '../core/types';

export const MAX_DELTA = 0.15;
export const DECAY_FACTOR = 0.98;
export const SENTINEL_MARKER = '§aff';

// Global so we can collect/strip every sentinel in the text, not just one.
const SENTINEL = /\s*§aff\s*(\{[\s\S]*?\})\s*§/g;

/** Extract affinity deltas and return the text with all sentinels removed. */
export function stripAffinity(text: string): { clean: string; deltas: Record<string, number> } {
  const deltas: Record<string, number> = {};
  const re = new RegExp(SENTINEL); // fresh lastIndex
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(match[1]) as Record<string, unknown>;
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'number' && Number.isFinite(value)) deltas[key] = value;
      }
    } catch {
      /* ignore a malformed sentinel rather than leak it */
    }
  }
  return { clean: text.replace(SENTINEL, '').trimEnd(), deltas };
}

/** What to show mid-stream: everything before the sentinel marker appears, so it
 *  never flashes on screen (even a partial sentinel) while tokens stream in. */
export function visibleText(raw: string): string {
  const i = raw.indexOf(SENTINEL_MARKER);
  return (i >= 0 ? raw.slice(0, i) : raw).trimEnd();
}

export function clampDelta(delta: number, max = MAX_DELTA): number {
  return Math.max(-max, Math.min(max, delta));
}

/** Apply a (clamped) delta to a current affinity, keeping the result in [-1, 1]. */
export function applyDelta(current: number, delta: number): number {
  return Math.max(-1, Math.min(1, current + clampDelta(delta)));
}

export function decay(affinity: number, factor = DECAY_FACTOR): number {
  return affinity * factor;
}

/** Starting affinity before any interaction: warmth-derived toward the user
 *  (warm personas start fond, cold ones start guarded), neutral toward peers. */
export function baselineAffinity(persona: Persona | undefined, to: string): number {
  if (!persona) return 0;
  return to === 'user' ? persona.temperament.warmth - 0.5 : 0;
}

export function affinityPhrase(affinity: number, name: string): string {
  if (affinity >= 0.6) return `You feel warmly and fondly toward ${name}.`;
  if (affinity >= 0.2) return `You feel friendly toward ${name}.`;
  if (affinity > -0.2) return `You feel neutral toward ${name}.`;
  if (affinity > -0.6) return `You feel cool and guarded toward ${name}.`;
  return `You feel cold, even hostile, toward ${name}.`;
}

/** Resolve a sentinel key to 'user' or a known persona id (by id or name). */
export function resolveTarget(key: string, personas: Persona[]): string | null {
  const k = key.trim().toLowerCase();
  if (k === 'user') return 'user';
  const match = personas.find((p) => p.id.toLowerCase() === k || p.name.toLowerCase() === k);
  return match ? match.id : null;
}
