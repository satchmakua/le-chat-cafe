// Distinctness metrics for the persona eval harness (DESIGN §6.8). Pure +
// unit-tested; the runnable harness (eval/run.ts) samples each persona and feeds
// their replies through these to answer "are the personas actually different?".

/** Lowercased word tokens (letters + apostrophes). */
export function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z']+/g) ?? []);
}

/** Jaccard similarity of two token sets, in [0, 1] (1 = identical vocab). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Average word count across replies. */
export function avgWords(texts: string[]): number {
  if (texts.length === 0) return 0;
  const total = texts.reduce((s, t) => s + (t.trim() ? t.trim().split(/\s+/).length : 0), 0);
  return total / texts.length;
}

/** Mean pairwise Jaccard overlap across a set of vocabularies (lower = more distinct). */
export function meanPairwiseOverlap(sets: Set<string>[]): number {
  if (sets.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      sum += jaccard(sets[i], sets[j]);
      pairs++;
    }
  }
  return pairs === 0 ? 0 : sum / pairs;
}
