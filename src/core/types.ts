// Canonical data models (DESIGN §6, §12). Kept in one place so the Room, Conductor,
// runtime, and UI share one vocabulary — the whole shape is readable here.

export interface Persona {
  id: string;
  name: string; // nick shown in the room
  aliases?: string[]; // extra mention triggers ("Cai" for "Caius")
  color: string; // nick color (hex)
  avatar?: string; // emoji or data-URI (optional)
  bio?: string; // one line for the profile card (§12.3)
  systemPrompt: string; // the character
  model: string; // ollama tag, e.g. "qwen3:8b" — or "mock" for the MockProvider
  params: { temperature: number; topP: number };
  temperament: {
    talkativeness: number; // 0..1 → idle weighting + cooldown length
    warmth: number; // baseline friendliness (starting affinity toward user)
    pettiness: number; // how hard affinity swings on slights
    sociability?: number; // 0..1 → how much of the time they're around (§12.2; default 0.7)
  };
  interests: string[]; // topic-match keywords for the Conductor
  quits?: string[]; // IRC quit messages in their voice (§12.2)
  channels?: string[]; // channel ids they hang out in (§12.4; default ["cafe"])
}

/** A persona arriving or leaving (DESIGN §12.2). */
export interface PresenceChange {
  who: string; // personaId
  state: 'join' | 'leave';
}

export interface Message {
  id: string;
  channelId: string;
  author: string; // personaId | "user"
  text: string;
  ts: number;
  replyTo?: string; // for forks / threading
  pending?: boolean; // true while tokens are still streaming in
  presence?: PresenceChange; // set on presence events (system lines); §12.2
  /** A UI notice (command output, errors, the welcome) — shown to you, never to the
   *  personas. System lines without it are room events and do reach prompts. */
  notice?: boolean;
}

/** A public channel (DESIGN §12.4) — data in src/channels/*.json. Members aren't
 *  listed here: personas say where they hang out (`Persona.channels`). */
export interface Channel {
  id: string; // shown as #id
  topic: string; // default topic (/topic overrides it per browser)
  about: string; // what the room is for — goes into the prompt header
}

export interface Relationship {
  from: string; // personaId
  to: string; // personaId | "user"
  affinity: number; // -1..1
  notes: string[];
}

export interface PersonaMemory {
  personaId: string;
  notes: string[]; // distilled long-term bullets
  lastSummarizedTs: number;
}

// --- Conductor (DESIGN §4); formalized in M1 ---

export type Reason = 'mention' | 'question' | 'event' | 'idle';

export interface TurnCandidate {
  personaId: string;
  reason: Reason;
  score: number;
}

export interface ConductorConfig {
  /** Idle pacing is bursty: gaps start at min and back off toward max (§4.1). */
  idleMsMin: number; // 4000 — gap between turns while the room is "hot"
  idleMsMax: number; // 60000 — the deepest lull between bursts
  idleBackoff: number; // 2 — each consecutive idle turn multiplies the gap
  maxConcurrent: number; // 2
  minScore: number; // 25
  monologueCap: number; // 3 of last 5
  chattinessWeight: number; // 15
  jitterMax: number; // 10
  /** Mean gap between presence ticks (comings & goings, §12.2); 0 disables. */
  presenceMs: number; // 90000
  /** Minimum gap between persona-initiated DMs (§12.4); 0 disables them. */
  dmGapMs: number; // 600000
}
