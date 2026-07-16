// Model-tag resolution: personas name a model tag as data, but the tags actually
// installed vary per machine — and Ollama 404s on an uninstalled tag. Instead of
// failing every turn, resolve the requested tag against what's installed:
// exact match → same family (llama3.2:3b → llama3.1:8b) → anything installed.

/** Leading letters of a tag: "llama3.2:3b" → "llama", "qwen2.5:7b-instruct" → "qwen". */
export function modelFamily(tag: string): string {
  const m = tag.toLowerCase().match(/^[a-z]+/);
  return m ? m[0] : tag.toLowerCase();
}

/**
 * Pick the model to actually run. An empty `available` list means we don't know
 * what's installed (MockProvider / probe failed) — trust the requested tag.
 */
export function resolveModel(requested: string, available: string[]): string {
  if (available.length === 0) return requested;
  if (available.includes(requested)) return requested;
  const kin = available.find((tag) => modelFamily(tag) === modelFamily(requested));
  return kin ?? available[0];
}
