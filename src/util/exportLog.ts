// `/export` (DESIGN §12.5): a channel as a plain IRC-style text log, the kind you'd
// grep years later. Pure; the store hands the result to a browser download.

import type { Message, Persona } from '../core/types';
import { cleanPersonaLine } from '../runtime/personaRuntime';
import { formatTimestamp } from './format';

const pad = (n: number) => String(n).padStart(2, '0');

/** "Sat Nov 15 2026" in local time. */
function dayOf(ts: number): string {
  return new Date(ts).toDateString();
}

/** `le-chat-cafe-arcade-2026-11-15.log` (a DM is named for the persona). */
export function logFilename(channelId: string, now: number): string {
  const slug = channelId.replace(/^dm:/, '').replace(/[^a-z0-9_-]+/gi, '-');
  const d = new Date(now);
  return `le-chat-cafe-${slug}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`;
}

export interface LogOptions {
  /** How the channel is written: "#cafe", "@Mira". */
  label: string;
  personas: Persona[];
  /** Display name for a non-persona author (you, a networked human). */
  nameOf: (author: string) => string;
  /** Export time, for the header. */
  now: number;
}

/**
 * The log: a header, a "Day changed" line whenever the date turns over, then
 * `[HH:MM] <Nick> text` per line and `[HH:MM] * event` for room events. UI notices
 * (command output) and unfinished lines are left out, and persona text gets the same
 * backstop cleaning as the log view, so no machine markup is ever written out.
 */
export function formatLog(messages: Message[], opts: LogOptions): string {
  const d = new Date(opts.now);
  const out = [`--- le-chat-cafe · ${opts.label} · exported ${dayOf(opts.now)} ${pad(d.getHours())}:${pad(d.getMinutes())}`];
  let day = '';
  for (const m of messages) {
    if (m.pending || m.notice) continue;
    const persona = opts.personas.find((p) => p.id === m.author);
    const text = persona ? cleanPersonaLine(m.text, persona.name) : m.text.trim();
    if (!text) continue;
    if (dayOf(m.ts) !== day) {
      day = dayOf(m.ts);
      out.push(`--- Day changed ${day}`);
    }
    const ts = formatTimestamp(m.ts);
    if (m.author === 'system') {
      out.push(`${ts} * ${text.replace(/^\*\s*|\s*\*$/g, '')}`);
      continue;
    }
    const nick = persona?.name ?? opts.nameOf(m.author);
    for (const line of text.split('\n')) out.push(`${ts} <${nick}> ${line}`);
  }
  return `${out.join('\n')}\n`;
}
