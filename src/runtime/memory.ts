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

export function buildSummaryPrompt(persona: Persona, transcript: string): string {
  return (
    `You keep private memory notes for "${persona.name}", a character in a group chat.\n\n` +
    `Transcript to digest:\n${transcript}\n\n` +
    `List up to 3 short, durable facts worth remembering about the people and topics — ` +
    `not small talk. One per line, each starting with "- ". Notes:`
  );
}

export async function summarizeForPersona(
  provider: LLMProvider,
  persona: Persona,
  transcript: string,
): Promise<string[]> {
  const raw = await provider.generate({
    model: persona.model,
    prompt: buildSummaryPrompt(persona, transcript),
  });
  return parseNotes(raw);
}
