// Canonical data models (DESIGN §6). Kept in one place so the Room, Conductor,
// runtime, and UI share one vocabulary. Some of these aren't used until later
// milestones (Relationship, PersonaMemory, the Conductor types) but they're the
// spec — a fresh session should see the whole shape here.

export interface Persona {
  id: string;
  name: string; // nick shown in the room
  aliases?: string[]; // extra mention triggers ("Cai" for "Caius")
  color: string; // nick color (hex)
  avatar?: string; // emoji or data-URI (optional)
  systemPrompt: string; // the character
  model: string; // ollama tag, e.g. "qwen3:8b" — or "mock" for the MockProvider
  params: { temperature: number; topP: number };
  temperament: {
    talkativeness: number; // 0..1 → idle weighting + cooldown length
    warmth: number; // baseline friendliness (starting affinity toward user)
    pettiness: number; // how hard affinity swings on slights
  };
  interests: string[]; // topic-match keywords for the Conductor
}

export interface Message {
  id: string;
  channelId: string;
  author: string; // personaId | "user"
  text: string;
  ts: number;
  replyTo?: string; // for forks / threading
  pending?: boolean; // true while tokens are still streaming in
}

export interface Channel {
  id: string;
  name: string;
  participants: string[]; // personaIds + "user"
  topic?: string;
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
  idleMs: number; // 12000
  maxConcurrent: number; // 2
  minScore: number; // 25
  monologueCap: number; // 3 of last 5
  chattinessWeight: number; // 15
  jitterMax: number; // 10
}
