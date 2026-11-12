// Channels & DMs (DESIGN §12.4) — pure helpers. A channel's id rides on every
// message (`channelId`), so a per-channel log is just a filter of the one log. Public
// channels are data (src/channels/*.json); membership comes from each persona's
// `channels` list. A DM is a private channel `dm:<personaId>` with one persona in it.

import type { Channel, Message, Persona } from './types';

/** The home channel: where everyone hangs out, and the one shared multiplayer room. */
export const HOME = 'cafe';
const DM_PREFIX = 'dm:';

export function isDm(channelId: string): boolean {
  return channelId.startsWith(DM_PREFIX);
}

export function dmId(personaId: string): string {
  return `${DM_PREFIX}${personaId}`;
}

/** The persona a DM is with, or null for a public channel. */
export function dmPersonaId(channelId: string): string | null {
  return isDm(channelId) ? channelId.slice(DM_PREFIX.length) : null;
}

/** Who's in a channel: a DM's one persona, else everyone who lists it (default home). */
export function membersOf(channelId: string, personas: Persona[]): Persona[] {
  const dm = dmPersonaId(channelId);
  if (dm) return personas.filter((p) => p.id === dm);
  return personas.filter((p) => (p.channels ?? [HOME]).includes(channelId));
}

/** How a channel is written: "#arcade", or "@Mira" for a DM. */
export function channelLabel(channelId: string, personas: Persona[]): string {
  const dm = dmPersonaId(channelId);
  if (dm) return `@${personas.find((p) => p.id === dm)?.name ?? dm}`;
  return `#${channelId}`;
}

/** Resolve what you typed after /join: "#Arcade", "arcade". */
export function findChannel(raw: string | undefined, channels: Channel[]): Channel | undefined {
  const id = (raw ?? '').trim().replace(/^#/, '').toLowerCase();
  return id ? channels.find((c) => c.id === id) : undefined;
}

/** Group one ordered log by channel, keeping order within each. */
export function splitLogs(messages: Message[]): Record<string, Message[]> {
  const logs: Record<string, Message[]> = {};
  for (const m of messages) (logs[m.channelId] ??= []).push(m);
  return logs;
}

/** How much a persona must like you before they'll DM you first. */
export const DM_AFFINITY = 0.4;
/** Per idle tick, once the time gap allows it — keeps first DMs a surprise. */
export const DM_CHANCE = 0.25;

/**
 * Who, if anyone, DMs you first right now (§12.4). Eligible: personas who like you
 * (≥ DM_AFFINITY), aren't busy or kicked (`blocked`), and whose DM isn't the window
 * you're already looking at. `chance` gates the whole draw so it stays rare; among
 * the eligible, the warmer they feel the likelier they are to write.
 */
export function pickDmSender(
  personas: Persona[],
  affinityToYou: (personaId: string) => number,
  blocked: ReadonlySet<string>,
  activeChannel: string,
  rng: () => number,
  chance = DM_CHANCE,
): Persona | null {
  const eligible = personas.filter(
    (p) => !blocked.has(p.id) && dmId(p.id) !== activeChannel && affinityToYou(p.id) >= DM_AFFINITY,
  );
  if (eligible.length === 0 || rng() >= chance) return null;
  const weights = eligible.map((p) => affinityToYou(p.id));
  let roll = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < eligible.length; i++) {
    roll -= weights[i];
    if (roll < 0) return eligible[i];
  }
  return eligible.at(-1) ?? null;
}
