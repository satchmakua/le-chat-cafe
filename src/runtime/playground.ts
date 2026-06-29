// Pure helpers for the Playground (DESIGN §6.7). The store orchestrates; these
// are the testable bits: persona override merging, timeline forking, regenerate
// targeting, and the A/B one-shot prompt.

import type { ChatTurn } from '../llm/provider';
import type { Message, Persona } from '../core/types';

/** Apply a (possibly partial) edit onto a base persona; nested objects merge. */
export function mergePersona(base: Persona, patch: Partial<Persona>): Persona {
  return {
    ...base,
    ...patch,
    params: { ...base.params, ...(patch.params ?? {}) },
    temperament: { ...base.temperament, ...(patch.temperament ?? {}) },
  };
}

/** Fork at a message: keep up to and including `id`, return the rest as removed. */
export function truncateAfter(
  messages: Message[],
  id: string,
): { kept: Message[]; removed: Message[] } {
  const i = messages.findIndex((m) => m.id === id);
  if (i < 0) return { kept: messages, removed: [] };
  return { kept: messages.slice(0, i + 1), removed: messages.slice(i + 1) };
}

/** The most recent persona (non-user, non-empty) message — the regenerate target. */
export function lastPersonaMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.author !== 'user' && m.text.trim().length > 0) return m;
  }
  return undefined;
}

/** One-shot prompt for an A/B comparison — no room transcript, just the prompt. */
export function buildABPrompt(persona: Persona, prompt: string): ChatTurn[] {
  return [
    {
      role: 'system',
      content: `${persona.systemPrompt}\n\nStay in character. Reply in 1–3 short sentences, no name prefix.`,
    },
    { role: 'user', content: prompt },
  ];
}
