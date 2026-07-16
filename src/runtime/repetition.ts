// Echo guard (DESIGN §9 "small-model repetition"). Small local models sometimes
// parrot their own character prompt or repeat a line they already said, turn
// after turn. Prompt instructions alone don't stop them, so the runtime checks
// each finalized reply mechanically: if it's mostly the same words as one of the
// persona's recent lines or a sentence of its system prompt, the turn is dropped
// instead of posted. All pure; the store orchestrates.

/** Lowercase, strip punctuation, collapse whitespace → comparable word list. */
export function normalizeWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

/**
 * Overlap of `a` relative to the *smaller* of the two word sets, in [0, 1].
 * Using the smaller set catches both "same line again" and "prior line plus a
 * few filler words" (containment), which plain Jaccard under-scores.
 */
export function overlapRatio(a: string, b: string): number {
  const wa = new Set(normalizeWords(a));
  const wb = new Set(normalizeWords(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

export const ECHO_THRESHOLD = 0.75;
/** Replies shorter than this many words are small talk — never flagged. */
export const ECHO_MIN_WORDS = 4;

/** Split prose into rough sentences (for comparing against a system prompt). */
export function sentences(text: string): string[] {
  return text
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True when `candidate` mostly restates any of `priors` (or a sentence of one). */
export function isEcho(candidate: string, priors: string[], threshold = ECHO_THRESHOLD): boolean {
  if (normalizeWords(candidate).length < ECHO_MIN_WORDS) return false;
  return priors.some(
    (prior) =>
      normalizeWords(prior).length >= ECHO_MIN_WORDS && overlapRatio(candidate, prior) >= threshold,
  );
}

/** Strip a leading self-name prefix ("Juno: hi" → "hi") — small models add one
 *  despite the no-prefix instruction. */
export function stripNamePrefix(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*${escaped}\\s*[:,—-]\\s*`, 'i'), '');
}
