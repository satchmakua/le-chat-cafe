// Your display name (DESIGN §12.1). Pure validation so the command handler stays thin.

import type { Persona } from '../core/types';

const NICK_RE = /^[A-Za-z0-9_-]{1,20}$/;
/** Words that already mean something to the app or the prompts. */
const RESERVED = new Set(['user', 'system', 'you', 'me', 'host']);

export type NickResult = { ok: true; nick: string } | { ok: false; reason: string };

export function validateNick(raw: string, personas: Persona[]): NickResult {
  const nick = raw.trim();
  if (!NICK_RE.test(nick)) return { ok: false, reason: 'use 1–20 letters, digits, _ or -' };
  const lower = nick.toLowerCase();
  if (RESERVED.has(lower)) return { ok: false, reason: `"${nick}" is reserved` };
  const clash = personas.find(
    (p) =>
      p.id.toLowerCase() === lower ||
      p.name.toLowerCase() === lower ||
      (p.aliases ?? []).some((a) => a.toLowerCase() === lower),
  );
  if (clash) return { ok: false, reason: `${clash.name} already goes by that` };
  return { ok: true, nick };
}
