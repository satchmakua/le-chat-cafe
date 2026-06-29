import { create } from 'zustand';
import type { ChatRequest, LLMProvider } from '../llm/provider';
import { MockProvider } from '../llm/mock';
import { OllamaProvider } from '../llm/ollama';
import type { ConductorConfig, Message, Persona, PersonaMemory } from '../core/types';
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
import { personas as loadedPersonas } from '../personas';
import * as db from '../persist/db';

const CHANNEL_ID = 'cafe';
const OLLAMA_URL = 'http://localhost:11434';
const KV_SUMMARIZED = 'summarizedCount';

export type ProviderKind = 'mock' | 'ollama';

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function welcomeMessage(): Message {
  return {
    id: uid(),
    channelId: CHANNEL_ID,
    author: loadedPersonas[0]?.id ?? 'system',
    text: '* welcome to le-chat-cafe — say hi *',
    ts: Date.now(),
  };
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

  init: () => Promise<void>;
  sendUserMessage: (text: string) => void;
  tick: (trigger: Trigger) => void;
  startGeneration: (persona: Persona) => Promise<void>;
  maybeSummarize: () => Promise<void>;
}

// Module-scope I/O state (timers/flags), not domain state.
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;
let summarizing = false;

export const useRoom = create<RoomState>((set, get) => ({
  personas: loadedPersonas,
  messages: [welcomeMessage()],
  provider: new MockProvider(),
  providerKind: 'mock',
  generating: [],
  config: DEFAULT_CONDUCTOR_CONFIG,
  memory: {},
  summarizedCount: 0,

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

    // Hydrate the room from IndexedDB (DESIGN §6.2). If nothing's stored yet,
    // persist the seed welcome so the next reload restores it.
    try {
      const [saved, mems, summarized] = await Promise.all([
        db.loadMessages(),
        db.loadMemory(),
        db.getKV<number>(KV_SUMMARIZED),
      ]);
      if (saved.length > 0) {
        set({ messages: saved });
      } else {
        await db.saveMessage(get().messages[0]);
      }
      const memory: Record<string, PersonaMemory> = {};
      for (const m of mems) memory[m.personaId] = m;
      set({ memory, summarizedCount: summarized ?? 0 });
    } catch {
      // no IndexedDB (private mode / unsupported) → in-memory session only
    }

    // Dev affordance for testing persistence (not the M5 /commands feature).
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
        set({ messages: [welcome], memory: {}, summarizedCount: 0 });
      },
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
    const req: ChatRequest = {
      model: persona.model,
      messages: buildPrompt(persona, history, personas, undefined, notes),
      options: { temperature: persona.params.temperature, top_p: persona.params.topP },
    };

    try {
      for await (const chunk of provider.chat(req)) {
        if (!chunk.token) continue;
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === replyId ? { ...m, text: m.text + chunk.token } : m,
          ),
        }));
      }
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === replyId && !m.text ? { ...m, text: `(couldn't reach the model — ${note})` } : m,
        ),
      }));
    } finally {
      set((s) => ({
        messages: s.messages.map((m) => (m.id === replyId ? { ...m, pending: false } : m)),
        generating: s.generating.filter((id) => id !== persona.id),
      }));
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
