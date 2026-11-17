// Model-tag resolution: personas name a model tag as data, but the tags actually
// installed vary per machine — and Ollama 404s on an uninstalled tag. Instead of
// failing every turn, resolve the requested tag against what's installed:
// exact match → largest of the same family (llama3.2:3b → llama3.1:8b) → largest installed.

/** Leading letters of a tag: "llama3.2:3b" → "llama", "qwen2.5:7b-instruct" → "qwen". */
export function modelFamily(tag: string): string {
  const m = tag.toLowerCase().match(/^[a-z]+/);
  return m ? m[0] : tag.toLowerCase();
}

/** Parameter count in billions, read off the tag ("qwen2.5:1.5b-instruct" → 1.5).
 *  A tag that doesn't say ("llama3.1:latest") counts as mid-sized. */
export function modelSize(tag: string): number {
  const m = tag.toLowerCase().match(/(\d+(?:\.\d+)?)b(?![a-z])/);
  return m ? Number(m[1]) : 7;
}

/**
 * Pick the model to actually run. An empty `available` list means we don't know
 * what's installed (MockProvider / probe failed) — trust the requested tag.
 * Among substitutes the largest wins: a 1.5B model holds a persona's voice but can't
 * follow a conversation, so it must never be the fallback just for sorting first.
 */
export function resolveModel(requested: string, available: string[]): string {
  if (available.length === 0) return requested;
  if (available.includes(requested)) return requested;
  const largest = (tags: string[]) => [...tags].sort((x, y) => modelSize(y) - modelSize(x))[0];
  const kin = available.filter((tag) => modelFamily(tag) === modelFamily(requested));
  return largest(kin.length > 0 ? kin : available);
}
