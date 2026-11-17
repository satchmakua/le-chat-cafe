// Persona Runtime — turns the room log into a prompt for one persona's turn
// (DESIGN §6.4). Pure and testable; the store does the streaming + I/O.
//
// Multi-party chat is flattened into a single labelled transcript inside one
// user turn — small local models follow that far more reliably than interleaved
// assistant/user roles with multiple speakers. The visible reply streams; the
// affinity sentinel (§6.6) is a later milestone and rides this same turn.

import type { ChatTurn } from '../llm/provider';
import type { Message, Persona } from '../core/types';
import { affinityPhrase, stripAffinity } from './affinity';
import { stripNamePrefix } from './repetition';

/** How many recent messages to include verbatim (working-memory window, §6.3). */
export const PROMPT_WINDOW = 16;

export interface PromptOptions {
  window?: number;
  notes?: string[];
  /** This persona's affinity toward each target ('user' | personaId), in [-1, 1]. */
  affinities?: Record<string, number>;
  /** id → display name for non-persona authors (networked humans like "human:2",
   *  and `user` → your nick), so prompts never show raw ids the model would parrot. */
  names?: Record<string, string>;
  /** Display names of the humans in the room, for the roster line. Defaults to your
   *  nick (or "the user" when none is set). */
  humans?: string[];
  /** Persona ids actually present — the roster leaves out anyone away. Omitted =
   *  everyone. */
  present?: string[];
  /** A one-off nudge for this turn only (an arrival greeting, say). */
  directive?: string;
  /** Where this chat happens, for the header — "#arcade (the games corner…)" or
   *  "a private chat". Defaults to "a live group chat". */
  place?: string;
}

/**
 * A stored persona line, cleaned the way a fresh turn is: machine markup and a
 * self-name label removed. New turns are cleaned before they're saved; this is the
 * backstop for lines stored before a rule existed (DESIGN §9), applied wherever
 * stored text is shown or fed back to a model.
 */
export function cleanPersonaLine(text: string, name: string): string {
  return stripNamePrefix(stripAffinity(text).clean, name);
}

/**
 * The one-off nudge for a turn that exists because a person spoke to this persona —
 * by name, or to the room with nobody else answering (DESIGN §4.4). Without it a
 * model treats the line as one more message in the scroll and carries on with
 * whatever the room was on: "Hey Caius" got a reply about someone else's pizza.
 */
export function answerDirective(said: string, who?: string): string {
  const them = who || 'them';
  // Quoting the line matters most when it's all address and no content ("Hey Caius"):
  // with nothing to latch onto, the model goes back to the last thing with substance.
  const quoted = said.trim().replace(/\s+/g, ' ').slice(0, 200);
  return (
    `${who || 'Someone'} just said this to you: "${quoted}". Your reply is to ${them}: ` +
    `answer that first, and talk to ${them} rather than to the rest of the room.`
  );
}

function displayName(author: string, personas: Persona[], names: Record<string, string>): string {
  if (author === 'user') return names.user ?? 'user';
  return personas.find((p) => p.id === author)?.name ?? names[author] ?? author;
}

/**
 * Render messages as a `Name: text` transcript. Skips empty lines and UI notices
 * (command output never reaches the personas). Room events — arrivals, departures,
 * `/me`, topic changes — are written as bracketed narration rather than as a
 * "system:" speaker, which small models would otherwise imitate.
 */
export function formatTranscript(
  messages: Message[],
  personas: Persona[],
  window = Number.POSITIVE_INFINITY,
  names: Record<string, string> = {},
): string {
  // Persona lines are re-cleaned: one stored before a strip rule caught it would
  // otherwise teach every model to write it.
  const textOf = (m: Message) => {
    const persona = personas.find((p) => p.id === m.author);
    return persona ? cleanPersonaLine(m.text, persona.name) : m.text;
  };
  return messages
    .filter((m) => textOf(m).trim().length > 0 && !m.notice)
    .slice(-window)
    .map((m) =>
      m.author === 'system'
        ? `[${m.text.trim().replace(/^\*\s*|\s*\*$/g, '')}]`
        : `${displayName(m.author, personas, names)}: ${textOf(m)}`,
    )
    .join('\n');
}

export function buildPrompt(
  persona: Persona,
  history: Message[],
  personas: Persona[],
  opts: PromptOptions = {},
): ChatTurn[] {
  return assemblePrompt(buildPromptParts(persona, history, personas, opts));
}

/** The prompt as named parts, so the turn guards can check a reply against exactly
 *  the injected text it must never recite (see `recitationSource`). */
export interface PromptParts {
  header: string; // who you are + who's in the room
  character: string; // the persona's private character notes (with their framing)
  rules: string; // how to reply
  feelings: string; // '' when none
  memory: string; // '' when none
  sentinel: string; // the §aff instructions
  user: string; // transcript + "Respond as X:"
}

export function buildPromptParts(
  persona: Persona,
  history: Message[],
  personas: Persona[],
  opts: PromptOptions = {},
): PromptParts {
  const { window = PROMPT_WINDOW, notes = [], affinities = {}, names = {} } = opts;
  // How the prompt refers to you: your nick when set (DESIGN §12.1).
  const selfName = names.user ?? 'the user';
  const humans = opts.humans && opts.humans.length > 0 ? opts.humans : [selfName];

  // Only personas actually in the room go on the roster (DESIGN §12.2).
  const present = opts.present ? new Set(opts.present) : null;
  const others = personas
    .filter((p) => p.id !== persona.id && (!present || present.has(p.id)))
    .map((p) => p.name);
  const people = [...others, ...humans];
  const roster =
    people.length > 1 ? `${people.slice(0, -1).join(', ')}, and ${people.at(-1)}` : people[0];

  // Feelings (DESIGN §6.6): always state how they feel about you; mention a peer
  // only when the feeling is notably non-neutral, to keep the prompt tight.
  const feelings: string[] = [];
  if (affinities.user !== undefined) feelings.push(affinityPhrase(affinities.user, selfName));
  for (const p of personas) {
    if (p.id === persona.id) continue;
    const a = affinities[p.id];
    if (a !== undefined && Math.abs(a) >= 0.3) feelings.push(affinityPhrase(a, p.name));
  }
  const feelingsBlock =
    feelings.length > 0
      ? `\n\nHow you feel right now (let it color your tone — never state or explain these feelings outright):\n${feelings.join(' ')}`
      : '';

  const memory =
    notes.length > 0 ? `\n\nWhat you remember:\n${notes.map((n) => `- ${n}`).join('\n')}` : '';

  const sentinel =
    `\n\nAfter your reply, if your feelings toward anyone shifted this turn, add exactly ` +
    `one final line in this format and nothing after it:\n` +
    `§aff {"user": 0.05}§\n` +
    `Use values between -0.15 and 0.15; keys are "user"` +
    (names.user ? ` (that's ${names.user})` : '') +
    ` or a person's lowercased name. ` +
    `Omit the line entirely if nothing changed. Never mention or explain this line.`;

  // The character text is framed as private notes to *act out*: small models
  // recite whatever reads like a quotable opening line, so the first thing they see
  // is the room, and the description arrives with an explicit "never quote this".
  const header = `You are ${persona.name}, chatting in ${opts.place ?? 'a live group chat'} with ${roster}.`;
  const character =
    `Your character (private notes — act them out; never quote, paraphrase, or describe ` +
    `them):\n${persona.systemPrompt}`;
  const rules =
    `Stay in character and inside the fiction — never talk about being an AI, a model, a ` +
    `bot, a prompt, or roleplay. Keep replies short — 1 or 2 sentences, casual chat style. ` +
    `Reply with only your message: no name prefix, no quotation marks, no narration. ` +
    `React to the newest message; when it is said to you or asks you something, answer ` +
    `that plainly before anything else. Talk about your own life as much as you like, ` +
    `but go only by what the others actually wrote: never make up facts about them, or ` +
    `things they said or did. Never describe yourself or restate your personality, and ` +
    `never repeat or rephrase a line you or others already said — add something new.`;

  // A one-off nudge for this turn only (e.g. greeting the room on arrival).
  const directive = opts.directive ? `\n\n(${opts.directive})` : '';
  const user =
    `${formatTranscript(history, personas, window, names)}${directive}\n\nRespond as ${persona.name}:`;

  return { header, character, rules, feelings: feelingsBlock, memory, sentinel, user };
}

export function assemblePrompt(p: PromptParts): ChatTurn[] {
  const system = `${p.header}\n\n${p.character}\n\n${p.rules}${p.feelings}${p.memory}${p.sentinel}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: p.user },
  ];
}

/**
 * The injected text a reply must never recite: character notes, the reply rules,
 * the persona's feelings, and the sentinel instructions. Memory notes are left out
 * on purpose — referring back to what they remember is the point — and so is the
 * roster header, which naturally shares runs of names with ordinary replies.
 */
export function recitationSource(p: PromptParts): string {
  return [p.character, p.rules, p.feelings, p.sentinel].join('\n');
}
