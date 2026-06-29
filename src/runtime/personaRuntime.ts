// Persona Runtime — turns the room log into a prompt for one persona's turn
// (DESIGN §6.4). Pure and testable; the store does the streaming + I/O.
//
// Multi-party chat is flattened into a single labelled transcript inside one
// user turn — small local models follow that far more reliably than interleaved
// assistant/user roles with multiple speakers. The visible reply streams; the
// affinity sentinel (§6.6) is a later milestone and rides this same turn.

import type { ChatTurn } from '../llm/provider';
import type { Message, Persona } from '../core/types';
import { affinityPhrase } from './affinity';

/** How many recent messages to include verbatim (working-memory window, §6.3). */
export const PROMPT_WINDOW = 16;

export interface PromptOptions {
  window?: number;
  notes?: string[];
  /** This persona's affinity toward each target ('user' | personaId), in [-1, 1]. */
  affinities?: Record<string, number>;
}

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
  opts: PromptOptions = {},
): ChatTurn[] {
  const { window = PROMPT_WINDOW, notes = [], affinities = {} } = opts;

  const others = personas.filter((p) => p.id !== persona.id).map((p) => p.name);
  const roster = others.length > 0 ? `${others.join(', ')}, and the user` : 'the user';

  // Feelings (DESIGN §6.6): always state how they feel about the user; mention a
  // peer only when the feeling is notably non-neutral, to keep the prompt tight.
  const feelings: string[] = [];
  if (affinities.user !== undefined) feelings.push(affinityPhrase(affinities.user, 'the user'));
  for (const p of personas) {
    if (p.id === persona.id) continue;
    const a = affinities[p.id];
    if (a !== undefined && Math.abs(a) >= 0.3) feelings.push(affinityPhrase(a, p.name));
  }
  const feelingsBlock = feelings.length > 0 ? `\n\nHow you feel right now:\n${feelings.join(' ')}` : '';

  const memory =
    notes.length > 0 ? `\n\nWhat you remember:\n${notes.map((n) => `- ${n}`).join('\n')}` : '';

  const sentinel =
    `\n\nAfter your reply, if your feelings toward anyone shifted this turn, add exactly ` +
    `one final line in this format and nothing after it:\n` +
    `§aff {"user": 0.05}§\n` +
    `Use values between -0.15 and 0.15; keys are "user" or a person's lowercased name. ` +
    `Omit the line entirely if nothing changed. Never mention or explain this line.`;

  const system =
    `${persona.systemPrompt}\n\n` +
    `You are "${persona.name}" in a live group chat with ${roster}. ` +
    `Stay fully in character. Keep replies short — 1 to 3 sentences, casual chat style. ` +
    `Reply with only your message: no name prefix, no quotation marks, no narration. ` +
    `Don't repeat what you or others just said.` +
    feelingsBlock +
    memory +
    sentinel;

  const user = `${formatTranscript(history, personas, window)}\n\nRespond as ${persona.name}:`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
