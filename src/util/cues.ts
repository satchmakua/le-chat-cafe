// Room alerts (DESIGN §12.5) — the pure half. Which just-finished lines are news,
// which sound each deserves, and what the tab title says while you're away. The
// browser half (Web Audio, document.title) lives in src/ui/ and only acts on these.

import type { Message } from '../core/types';
import { containsToken } from '../core/conductor';
import { isDm } from '../core/channels';

export type Cue = 'door-open' | 'door-close' | 'chime';

/** One sound per update, the most important: being addressed beats comings and goings. */
const PRIORITY: Cue[] = ['chime', 'door-open', 'door-close'];

/**
 * A live update finishes a line or two at a time. More than this in one update is a
 * bulk load — hydrating from IndexedDB, a relay snapshot — which is history, not news.
 */
export const LIVE_BATCH = 2;

/** Lines that just finished: present in `next` and done, but absent or still
 *  streaming in `prev`. A persona turn counts when it finalizes, not when it starts. */
export function newlyFinal(prev: Message[], next: Message[]): Message[] {
  if (prev === next) return [];
  const before = new Map(prev.map((m) => [m.id, m]));
  return next.filter((m) => {
    const was = before.get(m.id);
    return !m.pending && (!was || !!was.pending); // most lines never carry `pending` at all
  });
}

export interface CueContext {
  /** Your display name ('' when unset) — a line that says it is a mention. */
  me: string;
  /** True for authors that are you (single-player "user", or your relay ids). */
  mine: (author: string) => boolean;
}

/** The sound a just-finished line deserves, if any: a door for arrivals and
 *  departures, a chime when someone DMs you or says your name. */
export function cueFor(m: Message, ctx: CueContext): Cue | null {
  if (m.presence) return m.presence.state === 'join' ? 'door-open' : 'door-close';
  if (m.author === 'system' || ctx.mine(m.author) || !m.text.trim()) return null;
  if (isDm(m.channelId)) return 'chime';
  if (ctx.me && containsToken(m.text, ctx.me)) return 'chime';
  return null;
}

export function pickCue(cues: (Cue | null)[]): Cue | null {
  return PRIORITY.find((c) => cues.includes(c)) ?? null;
}

/** Does a finished line bump the hidden-tab count? Someone else saying something. */
export function countsAsUnread(m: Message, mine: (author: string) => boolean): boolean {
  return m.author !== 'system' && !mine(m.author) && m.text.trim().length > 0;
}

/** The tab title: `(3) le-chat-cafe` while lines arrive behind your back. */
export function titleFor(unread: number, base = 'le-chat-cafe'): string {
  return unread > 0 ? `(${unread}) ${base}` : base;
}
