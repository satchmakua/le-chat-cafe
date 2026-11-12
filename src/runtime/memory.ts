// Long-term memory (DESIGN §6.3) — the second tier beneath the verbatim
// working-memory window. When older history grows past a threshold, a cheap
// summarization pass distills it into per-persona bullet notes that are
// re-injected into that persona's system prompt (see buildPrompt). Keeps long
// sessions inside a small model's context window.
//
// The pure helpers here are unit-tested; the one I/O call (summarizeForPersona)
// goes through the LLMProvider port, so MockProvider exercises it in CI.

import type { LLMProvider } from '../llm/provider';
import type { Message, Persona } from '../core/types';

/** Messages kept verbatim in every prompt (must match PROMPT_WINDOW intent). */
export const KEEP_VERBATIM = 16;
/** Summarize once this many un-digested messages have aged out of the window. */
export const SUMMARY_TRIGGER = 30;
/** Cap on stored notes per persona (oldest dropped first). */
export const MAX_NOTES = 12;

/** The slice eligible for summarization: everything older than the window. */
export function olderThanWindow(messages: Message[], keep = KEEP_VERBATIM): Message[] {
  return messages.slice(0, Math.max(0, messages.length - keep));
}

/** True when enough new history has aged out of the window to be worth digesting. */
export function shouldSummarize(
  messageCount: number,
  summarizedCount: number,
  keep = KEEP_VERBATIM,
  trigger = SUMMARY_TRIGGER,
): boolean {
  const summarizable = Math.max(0, messageCount - keep);
  return summarizable - summarizedCount >= trigger;
}

/** Turn a model's bullet-ish output into clean note strings. */
export function parseNotes(raw: string, max = 3): string[] {
  return raw
    .split('\n')
    .map((line) => line.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, max);
}

/** Merge new notes onto existing ones, keeping the most recent MAX_NOTES. */
export function mergeNotes(existing: string[], incoming: string[], max = MAX_NOTES): string[] {
  return [...existing, ...incoming].slice(-max);
}

/**
 * A persona's memory is of *other people* — above all you. The first version asked for
 * "facts about the people and topics", and models dutifully wrote the persona's own
 * deeds in third person ("Mira has recently returned from a countryside trip") with
 * nothing about you at all.
 */
export function buildSummaryPrompt(persona: Persona, transcript: string, you = 'the user'): string {
  return (
    `You are ${persona.name}'s memory. Read this group-chat transcript and write down what ` +
    `${persona.name} would want to remember about the OTHER people in it — above all ` +
    `${you}: what they shared about their life, work, plans, tastes, and moods.\n\n` +
    `Transcript:\n${transcript}\n\n` +
    `Write up to 3 short, durable facts. Each one is about someone other than ` +
    `${persona.name}, names them, and is worth recalling days later. Skip greetings and ` +
    `small talk. One per line, each starting with "- ". Notes:`
  );
}

/** Drop notes about the persona itself (or written as "I…") — its memory is of others. */
export function keepNotesAboutOthers(notes: string[], persona: Persona): string[] {
  const self = new Set([persona.name, ...(persona.aliases ?? [])].map((n) => n.toLowerCase()));
  return notes.filter((n) => {
    const first = n.trim().split(/[\s,:'’]+/)[0]?.toLowerCase() ?? '';
    return !self.has(first) && !/^(?:i|i'm|i've|i'd|my|me)\b/i.test(n.trim());
  });
}

export async function summarizeForPersona(
  provider: LLMProvider,
  persona: Persona,
  transcript: string,
  model = persona.model, // caller may pass a resolved/installed tag
  you = 'the user', // your nick, when set
): Promise<string[]> {
  const raw = await provider.generate({
    model,
    prompt: buildSummaryPrompt(persona, transcript, you),
  });
  return keepNotesAboutOthers(parseNotes(raw), persona);
}
