// Persona Runtime — turns the room log into a prompt for one persona's turn
// (DESIGN §6.4). Pure and testable; the store does the streaming + I/O.
//
// Multi-party chat is flattened into a single labelled transcript inside one
// user turn — small local models follow that far more reliably than interleaved
// assistant/user roles with multiple speakers. The visible reply streams; the
// affinity sentinel (§6.6) is a later milestone and rides this same turn.

import type { ChatTurn } from '../llm/provider';
import type { Message, Persona } from '../core/types';

/** How many recent messages to include verbatim (working-memory window, §6.3). */
export const PROMPT_WINDOW = 16;

function displayName(author: string, personas: Persona[]): string {
  return author === 'user' ? 'user' : (personas.find((p) => p.id === author)?.name ?? author);
}

/** Render messages as a `Name: text` transcript (skips empty/pending lines). */
export function formatTranscript(
  messages: Message[],
  personas: Persona[],
  window = Number.POSITIVE_INFINITY,
): string {
  return messages
    .filter((m) => m.text.trim().length > 0)
    .slice(-window)
    .map((m) => `${displayName(m.author, personas)}: ${m.text}`)
    .join('\n');
}

export function buildPrompt(
  persona: Persona,
  history: Message[],
  personas: Persona[],
  window = PROMPT_WINDOW,
  notes: string[] = [],
): ChatTurn[] {
  const others = personas.filter((p) => p.id !== persona.id).map((p) => p.name);
  const roster = others.length > 0 ? `${others.join(', ')}, and the user` : 'the user';

  const memory =
    notes.length > 0 ? `\n\nWhat you remember:\n${notes.map((n) => `- ${n}`).join('\n')}` : '';

  const system =
    `${persona.systemPrompt}\n\n` +
    `You are "${persona.name}" in a live group chat with ${roster}. ` +
    `Stay fully in character. Keep replies short — 1 to 3 sentences, casual chat style. ` +
    `Reply with only your message: no name prefix, no quotation marks, no narration. ` +
    `Don't repeat what you or others just said.` +
    memory;

  const user = `${formatTranscript(history, personas, window)}\n\nRespond as ${persona.name}:`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
