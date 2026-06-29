import { create } from 'zustand';
import type { ChatRequest, LLMProvider } from '../llm/provider';
import { MockProvider } from '../llm/mock';
import { OllamaProvider } from '../llm/ollama';
import type { ConductorConfig, Message, Persona, PersonaMemory, Relationship } from '../core/types';
import type { Trigger } from '../core/conductor';
import { DEFAULT_CONDUCTOR_CONFIG, selectSpeakers } from '../core/conductor';
import { buildPrompt, formatTranscript } from '../runtime/personaRuntime';
import {
  KEEP_VERBATIM,
  mergeNotes,
  olderThanWindow,
  shouldSummarize,
  summarizeForPersona,
} from '../runtime/memory';
import {
  applyDelta,
  baselineAffinity,
  decay,
  resolveTarget,
  stripAffinity,
  visibleText,
} from '../runtime/affinity';
import { buildABPrompt, lastPersonaMessage, mergePersona, truncateAfter } from '../runtime/playground';
import { personas as basePersonas } from '../personas';
import * as db from '../persist/db';

const CHANNEL_ID = 'cafe';
const OLLAMA_URL = 'http://localhost:11434';
const KV_SUMMARIZED = 'summarizedCount';
const KV_OVERRIDES = 'personaOverrides';
const KV_CONFIG = 'conductorConfig';

export type ProviderKind = 'mock' | 'ollama';

export interface ABSlot {
  personaId: string;
  text: string;
  pending: boolean;
}
export interface ABState {
  prompt: string;
  a: ABSlot | null;
  b: ABSlot | null;
  running: boolean;
}

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function welcomeMessage(): Message {
  return {
    id: uid(),
    channelId: CHANNEL_ID,
    author: basePersonas[0]?.id ?? 'system',
    text: '* welcome to le-chat-cafe — say hi *',
    ts: Date.now(),
  };
}

function derivePersonas(overrides: Record<string, Partial<Persona>>): Persona[] {
  return basePersonas.map((p) => mergePersona(p, overrides[p.id] ?? {}));
}

interface RoomState {
  personas: Persona[];
  messages: Message[];
  provider: LLMProvider;
  providerKind: ProviderKind;
  /** personaIds currently streaming (concurrency cap lives in the Conductor). */
  generating: string[];
  config: ConductorConfig;
  /** Per-persona long-term notes (DESIGN §6.3), keyed by personaId. */
  memory: Record<string, PersonaMemory>;
  /** How many of the oldest messages have already been folded into notes. */
  summarizedCount: number;
  /** Affinity relationships (DESIGN §6.6), keyed by `${from}:${to}`. */
  relationships: Record<string, Relationship>;
  /** Playground persona edits (DESIGN §6.7), merged onto the JSON base. */
  personaOverrides: Record<string, Partial<Persona>>;
  /** A/B comparison scratch state. */
  ab: ABState;

  init: () => Promise<void>;
  sendUserMessage: (text: string) => void;
  tick: (trigger: Trigger) => void;
  startGeneration: (persona: Persona) => Promise<void>;
  maybeSummarize: () => Promise<void>;
  affinityOf: (from: string, to: string) => number;
  applyAffinityDeltas: (from: string, deltas: Record<string, number>) => void;

  // --- Playground (M4) ---
  updatePersona: (id: string, patch: Partial<Persona>) => void;
  updateConfig: (patch: Partial<ConductorConfig>) => void;
  regenerateLast: () => void;
  forkAt: (id: string) => void;
  runAB: (prompt: string, aId: string, bId: string) => Promise<void>;
}

// Module-scope I/O state (timers/flags), not domain state.
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;
let summarizing = false;

export const useRoom = create<RoomState>((set, get) => ({
  personas: basePersonas,
  messages: [welcomeMessage()],
  provider: new MockProvider(),
  providerKind: 'mock',
  generating: [],
  config: DEFAULT_CONDUCTOR_CONFIG,
  memory: {},
  summarizedCount: 0,
  relationships: {},
  personaOverrides: {},
  ab: { prompt: '', a: null, b: null, running: false },

  async init() {
    if (initialized) return; // guard against React StrictMode double-invoke
    initialized = true;

    // Probe Ollama; this fetch also doubles as the CORS check (DESIGN §9).
    // Fall back to the MockProvider so the app always runs.
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET' });
      if (res.ok) {
        set({ provider: new OllamaProvider({ baseUrl: OLLAMA_URL }), providerKind: 'ollama' });
      }
    } catch {
      // stay on MockProvider
    }

    // Hydrate everything persisted (DESIGN §6.2). If nothing's stored, persist
    // the seed welcome so the next reload restores it.
    try {
      const [saved, mems, rels, summarized, overrides, savedConfig] = await Promise.all([
        db.loadMessages(),
        db.loadMemory(),
        db.loadRelationships(),
        db.getKV<number>(KV_SUMMARIZED),
        db.getKV<Record<string, Partial<Persona>>>(KV_OVERRIDES),
        db.getKV<Partial<ConductorConfig>>(KV_CONFIG),
      ]);
      if (saved.length > 0) {
        set({ messages: saved });
      } else {
        await db.saveMessage(get().messages[0]);
      }
      const memory: Record<string, PersonaMemory> = {};
      for (const m of mems) memory[m.personaId] = m;

      // Decay affinities toward 0 on each session load so they don't spiral (§6.6).
      const relationships: Record<string, Relationship> = {};
      for (const r of rels) {
        const decayed: Relationship = { ...r, affinity: decay(r.affinity) };
        relationships[`${r.from}:${r.to}`] = decayed;
        void db.saveRelationship(decayed).catch(() => {});
      }

      const personaOverrides = overrides ?? {};
      set({
        memory,
        summarizedCount: summarized ?? 0,
        relationships,
        personaOverrides,
        personas: derivePersonas(personaOverrides),
        config: { ...DEFAULT_CONDUCTOR_CONFIG, ...(savedConfig ?? {}) },
      });
    } catch {
      // no IndexedDB (private mode / unsupported) → in-memory session only
    }

    // Dev affordances for testing (not the M5 /commands feature).
    (globalThis as { __cafe?: unknown }).__cafe = {
      clearHistory: async () => {
        try {
          await db.clearAll();
        } catch {
          /* ignore */
        }
        const welcome = welcomeMessage();
        try {
          await db.saveMessage(welcome);
        } catch {
          /* ignore */
        }
        set({
          messages: [welcome],
          memory: {},
          summarizedCount: 0,
          relationships: {},
          personaOverrides: {},
          personas: derivePersonas({}),
          config: DEFAULT_CONDUCTOR_CONFIG,
        });
      },
      bumpAffinity: (from: string, delta: number, to = 'user') =>
        get().applyAffinityDeltas(from, { [to]: delta }),
    };

    scheduleIdle(); // let the room come alive on its own
  },

  sendUserMessage(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    clearIdle();
    const msg: Message = {
      id: uid(),
      channelId: CHANNEL_ID,
      author: 'user',
      text: trimmed,
      ts: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
    void db.saveMessage(msg).catch(() => {});
    get().tick('message');
  },

  tick(trigger) {
    const { personas, messages, generating, config } = get();
    const chosen = selectSpeakers({
      personas,
      messages,
      trigger,
      generating: new Set(generating),
      config,
    });

    if (chosen.length === 0) {
      if (generating.length === 0) scheduleIdle(); // settled → arm the idle timer
      return;
    }

    for (const candidate of chosen) {
      const persona = personas.find((p) => p.id === candidate.personaId);
      if (persona) void get().startGeneration(persona);
    }
  },

  async startGeneration(persona) {
    clearIdle();
    const replyId = uid();
    const pending: Message = {
      id: replyId,
      channelId: CHANNEL_ID,
      author: persona.id,
      text: '',
      ts: Date.now(),
      pending: true,
    };
    // Reserve the concurrency slot + show the pending line synchronously, before
    // any await, so concurrent ticks see an accurate `generating` set.
    set((s) => ({ generating: [...s.generating, persona.id], messages: [...s.messages, pending] }));

    const { provider, messages, personas, memory } = get();
    const history = messages.filter((m) => m.id !== replyId);
    const notes = memory[persona.id]?.notes ?? [];
    const affinities: Record<string, number> = { user: get().affinityOf(persona.id, 'user') };
    for (const other of personas) {
      if (other.id !== persona.id) affinities[other.id] = get().affinityOf(persona.id, other.id);
    }
    const req: ChatRequest = {
      model: persona.model,
      messages: buildPrompt(persona, history, personas, { notes, affinities }),
      options: { temperature: persona.params.temperature, top_p: persona.params.topP },
    };

    // Accumulate the raw stream (which may carry the §aff sentinel at the end) but
    // only ever display the text before the sentinel — so it never flashes (§6.6).
    let raw = '';
    try {
      for await (const chunk of provider.chat(req)) {
        if (!chunk.token) continue;
        raw += chunk.token;
        const shown = visibleText(raw);
        set((s) => ({
          messages: s.messages.map((m) => (m.id === replyId ? { ...m, text: shown } : m)),
        }));
      }
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      if (!raw) raw = `(couldn't reach the model — ${note})`;
    } finally {
      const { clean, deltas } = stripAffinity(raw);
      set((s) => ({
        messages: s.messages.map((m) => (m.id === replyId ? { ...m, text: clean, pending: false } : m)),
        generating: s.generating.filter((id) => id !== persona.id),
      }));
      get().applyAffinityDeltas(persona.id, deltas);
      const finalized = get().messages.find((m) => m.id === replyId);
      if (finalized) void db.saveMessage(finalized).catch(() => {});
      void get().maybeSummarize();
      get().tick('message'); // a new line landed — let others react / fill freed slots
    }
  },

  async maybeSummarize() {
    if (summarizing) return;
    const { messages, summarizedCount, provider, personas } = get();
    if (!shouldSummarize(messages.length, summarizedCount)) return;

    summarizing = true;
    try {
      const older = olderThanWindow(messages);
      const transcript = formatTranscript(older, personas);
      // Sequential to be gentle on a single GPU (DESIGN §9 latency-stacking).
      for (const persona of personas) {
        const incoming = await summarizeForPersona(provider, persona, transcript);
        if (incoming.length === 0) continue;
        const prev = get().memory[persona.id]?.notes ?? [];
        const updated: PersonaMemory = {
          personaId: persona.id,
          notes: mergeNotes(prev, incoming),
          lastSummarizedTs: Date.now(),
        };
        set((s) => ({ memory: { ...s.memory, [persona.id]: updated } }));
        void db.saveMemory(updated).catch(() => {});
      }
      const newCount = Math.max(0, get().messages.length - KEEP_VERBATIM);
      set({ summarizedCount: newCount });
      void db.setKV(KV_SUMMARIZED, newCount).catch(() => {});
    } finally {
      summarizing = false;
    }
  },

  affinityOf(from, to) {
    const { relationships, personas } = get();
    const existing = relationships[`${from}:${to}`];
    if (existing) return existing.affinity;
    return baselineAffinity(
      personas.find((p) => p.id === from),
      to,
    );
  },

  applyAffinityDeltas(from, deltas) {
    const { personas } = get();
    const updates: Relationship[] = [];
    for (const [rawKey, value] of Object.entries(deltas)) {
      const to = resolveTarget(rawKey, personas);
      if (!to || to === from) continue;
      const key = `${from}:${to}`;
      const current = get().affinityOf(from, to);
      const next = applyDelta(current, value);
      updates.push({ from, to, affinity: next, notes: get().relationships[key]?.notes ?? [] });
    }
    if (updates.length === 0) return;
    set((s) => {
      const relationships = { ...s.relationships };
      for (const u of updates) relationships[`${u.from}:${u.to}`] = u;
      return { relationships };
    });
    for (const u of updates) void db.saveRelationship(u).catch(() => {});
  },

  // --- Playground (M4) ---

  updatePersona(id, patch) {
    const overrides = { ...get().personaOverrides, [id]: { ...get().personaOverrides[id], ...patch } };
    set({ personaOverrides: overrides, personas: derivePersonas(overrides) });
    void db.setKV(KV_OVERRIDES, overrides).catch(() => {});
  },

  updateConfig(patch) {
    const config = { ...get().config, ...patch };
    set({ config });
    void db.setKV(KV_CONFIG, config).catch(() => {});
  },

  regenerateLast() {
    const { messages, personas, generating } = get();
    if (generating.length > 0) return;
    const target = lastPersonaMessage(messages);
    if (!target) return;
    const persona = personas.find((p) => p.id === target.author);
    if (!persona) return;
    set({ messages: messages.filter((m) => m.id !== target.id) });
    void db.deleteMessage(target.id).catch(() => {});
    void get().startGeneration(persona);
  },

  forkAt(id) {
    const { kept, removed } = truncateAfter(get().messages, id);
    if (removed.length === 0) return;
    set({ messages: kept });
    for (const m of removed) void db.deleteMessage(m.id).catch(() => {});
  },

  async runAB(prompt, aId, bId) {
    const trimmed = prompt.trim();
    if (!trimmed || get().ab.running) return;
    const { provider, personas } = get();
    const pa = personas.find((p) => p.id === aId);
    const pb = personas.find((p) => p.id === bId);
    if (!pa || !pb) return;

    set({
      ab: {
        prompt: trimmed,
        running: true,
        a: { personaId: aId, text: '', pending: true },
        b: { personaId: bId, text: '', pending: true },
      },
    });

    const setSlot = (slot: 'a' | 'b', patch: Partial<ABSlot>) =>
      set((s) => {
        const cur = slot === 'a' ? s.ab.a : s.ab.b;
        if (!cur) return {};
        const updated = { ...cur, ...patch };
        return { ab: { ...s.ab, ...(slot === 'a' ? { a: updated } : { b: updated }) } };
      });

    const stream = async (persona: Persona, slot: 'a' | 'b') => {
      let raw = '';
      try {
        for await (const chunk of provider.chat({
          model: persona.model,
          messages: buildABPrompt(persona, trimmed),
          options: { temperature: persona.params.temperature, top_p: persona.params.topP },
        })) {
          if (!chunk.token) continue;
          raw += chunk.token;
          setSlot(slot, { text: visibleText(raw) });
        }
      } catch (err) {
        const note = err instanceof Error ? err.message : String(err);
        if (!raw) raw = `(error — ${note})`;
      } finally {
        setSlot(slot, { text: stripAffinity(raw).clean, pending: false });
      }
    };

    await Promise.all([stream(pa, 'a'), stream(pb, 'b')]);
    set((s) => ({ ab: { ...s.ab, running: false } }));
  },
}));

function clearIdle(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdle(): void {
  clearIdle();
  const { config } = useRoom.getState();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    useRoom.getState().tick('idle');
  }, config.idleMs);
}
