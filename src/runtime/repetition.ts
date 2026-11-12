// Turn guards (DESIGN §9 "small-model repetition"). Small local models sometimes
// parrot their own character prompt, repeat a line they already said, or step out
// of the fiction ("I'm not really Dex, just fine-tuned…"). Prompt instructions
// alone don't stop them, so the runtime checks each finalized reply mechanically
// and drops a bad turn instead of posting it — a beat of silence reads better than
// a stuck record or a broken illusion. All pure; the store orchestrates.

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

/**
 * Character-prompt priors for `isEcho`, split into *clauses* (on `: ; —` as well as
 * sentence ends). Comparing against whole sentences let a "You are Juno:" preamble
 * dilute the overlap — "chaotic-good hype energy, fast and playful here!" scored 0.70
 * against "You are Juno: chaotic-good hype energy, fast and playful" and slipped by.
 */
export function characterPriors(systemPrompt: string): string[] {
  return systemPrompt
    .split(/[.!?\n:;—]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const RECITE_N = 4;

/** Words long enough to carry meaning — an n-gram needs two of them to count. */
function isContentWord(w: string): boolean {
  return w.length >= 4;
}

/**
 * Verbatim recitation: does `candidate` contain any distinctive `n`-word run from the
 * character prompt? Catches partial parroting ("Chaotic-good hype energy here!")
 * that whole-clause overlap can't see. Runs made mostly of short glue words
 * ("in a friendly way") don't count, so ordinary phrasing isn't punished.
 */
export function recitesPrompt(candidate: string, systemPrompt: string, n = RECITE_N): boolean {
  const source = normalizeWords(systemPrompt);
  const grams = new Set<string>();
  for (let i = 0; i + n <= source.length; i++) {
    const run = source.slice(i, i + n);
    if (run.filter(isContentWord).length >= 2) grams.add(run.join(' '));
  }
  const words = normalizeWords(candidate);
  for (let i = 0; i + n <= words.length; i++) {
    if (grams.has(words.slice(i, i + n).join(' '))) return true;
  }
  return false;
}

/** Escaped alternation of a persona's name + aliases, for the patterns below. */
function namePattern(name: string, aliases: string[] = []): string {
  return [name, ...aliases].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

// Self-reference only. Ordinary chat must pass: "my programming setup" (Dex), "I was
// trained by my coach", "roleplaying as a paladin" (#arcade), "as an assistant
// librarian" (Mira) — each of those reads as a person, not a model.
const META_PATTERNS: RegExp[] = [
  /\bas an? (?:ai|artificial intelligence|(?:large )?language model|llm|chatbot|(?:ai|virtual) assistant)\b/i,
  /\bi(?:'m| am) (?:just |only |really |actually |merely )?(?:an? )?(?:ai|artificial intelligence|(?:large )?language model|llm|chatbot|bot|computer program|(?:ai|virtual) assistant)\b/i,
  /\b(?:i(?:'m| am| was)|just) (?:been )?fine-?tuned\b/i,
  /\b(?:my|the) (?:system prompt|training data)\b/i,
  /\b(?:out of character|break(?:ing)? character)\b/i,
  /\bi(?:'m| am) (?:just )?an? (?:persona|character) (?:in|for|created|designed|based|made)\b/i,
];

/**
 * True when the reply steps out of the fiction — talks about being an AI/model/bot,
 * its prompt or training, or denies being itself ("I'm not really Dex").
 */
export function breaksCharacter(text: string, persona: { name: string; aliases?: string[] }): boolean {
  if (META_PATTERNS.some((re) => re.test(text))) return true;
  const names = namePattern(persona.name, persona.aliases);
  return new RegExp(`\\bi(?:'m| am) not (?:really|actually) (?:${names})\\b`, 'i').test(text);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cut a reply where the model starts writing someone else's turn. Small models keep
 * going in transcript format — "…\nCaius: hey", a fake "(system)" line, or a fake
 * "* Mira has quit *". Everything from the first such line goes; a reply that opens
 * with a fake event leaves nothing, and the turn guard drops it.
 *
 * A label on the *first* line is kept: "Mira: totally" is how IRC addresses someone
 * (and how `/msg` writes), so only a label on a later line reads as a new turn. Run
 * this after `stripNamePrefix`, which removes a leading *own*-name label. A plain
 * reaction like "Dex has left already?" is kept too — only lines styled like room
 * events (starting `*`, `[`, or `(`) count as fakes.
 */
export function cutAtNextSpeaker(text: string, speakers: string[]): string {
  const names = [...speakers, 'system', 'user'].filter(Boolean).map(escapeRe).join('|');
  const speakerLine = new RegExp(`^\\s*(?:${names})\\s*:`, 'i');
  // "<Caius> hey" / "[Caius] hey" is transcript format, never addressing — so unlike
  // "Caius:", it counts on the first line too.
  const labelLine = new RegExp(`^\\s*[[<(]\\s*(?:${names})\\s*[\\]>)]`, 'i');
  const fakeSystem = /^\s*[([]\s*system\s*[)\]]/i;
  const fakeEvent = /^\s*[*[(]\s*\S+ (?:has (?:joined|quit|left)|was kicked)\b/i;
  const kept: string[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    const fake = labelLine.test(line) || fakeSystem.test(line) || fakeEvent.test(line);
    if ((i > 0 && speakerLine.test(line)) || fake) break;
    kept.push(line);
  }
  return kept.join('\n').trimEnd();
}

/** Strip a leading self-name label — "Juno: hi", "<Juno> hi", "[Juno] hi" → "hi".
 *  Small models add one despite the no-prefix instruction. */
export function stripNamePrefix(text: string, name: string): string {
  const n = escapeRe(name);
  return text.replace(new RegExp(`^\\s*(?:[[<(]\\s*${n}\\s*[\\]>)]\\s*[:,—-]?|${n}\\s*[:,—-])\\s*`, 'i'), '');
}
