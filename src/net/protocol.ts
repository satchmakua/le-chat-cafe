// Wire protocol shared by the browser client and the Node relay (DESIGN §11).
// Tiny JSON envelopes; the relay is the single source of message order (seq).

import type { Message } from '../core/types';

export interface Participant {
  id: string; // 'human:<x>' | personaId
  name: string;
  kind: 'human' | 'persona';
  isHost?: boolean;
}

export type ClientMsg =
  | { t: 'hello'; room: string; name: string; canHost: boolean }
  | { t: 'say'; message: Message } // a human turn (or, from the host, a final persona turn)
  | { t: 'stream'; message: Message }; // host → live token updates for a persona turn (ephemeral)

export type ServerMsg =
  | { t: 'welcome'; you: string; hostId: string; participants: Participant[]; log: Message[] }
  | { t: 'presence'; participants: Participant[] }
  | { t: 'message'; seq: number; message: Message } // canonical, ordered, stored in the log
  | { t: 'stream'; message: Message }; // live token update, not stored (M6.2)

/** Default relay port (overridable via PORT). */
export const DEFAULT_RELAY_PORT = 8787;

/** Parse a JSON frame, returning null on anything malformed (never throws). */
export function parseFrame<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
