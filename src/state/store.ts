import { create } from 'zustand';
import type { ChatRequest, LLMProvider } from '../llm/provider';
import { MockProvider } from '../llm/mock';
import { OllamaProvider } from '../llm/ollama';
import type { ConductorConfig, Message, Persona } from '../core/types';
import type { Trigger } from '../core/conductor';
import { DEFAULT_CONDUCTOR_CONFIG, selectSpeakers } from '../core/conductor';
import { buildPrompt } from '../runtime/personaRuntime';
import { personas as loadedPersonas } from '../personas';

const CHANNEL_ID = 'cafe';
const OLLAMA_URL = 'http://localhost:11434';

export type ProviderKind = 'mock' | 'ollama';

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

interface RoomState {
  personas: Persona[];
  messages: Message[];
  provider: LLMProvider;
  providerKind: ProviderKind;
  /** personaIds currently streaming (concurrency cap lives in the Conductor). */
  generating: string[];
  config: ConductorConfig;

  init: () => Promise<void>;
  sendUserMessage: (text: string) => void;
  /** Conductor pass: pick who speaks and start them. */
  tick: (trigger: Trigger) => void;
  /** Stream one persona's reply into a pending message. */
  startGeneration: (persona: Persona) => Promise<void>;
}

// Idle timer lives at module scope (one per app); it's I/O, not domain state.
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

export const useRoom = create<RoomState>((set, get) => ({
  personas: loadedPersonas,
  messages: [
    {
      id: uid(),
      channelId: CHANNEL_ID,
      author: loadedPersonas[0]?.id ?? 'system',
      text: '* welcome to le-chat-cafe — say hi *',
      ts: Date.now(),
    },
  ],
  provider: new MockProvider(),
  providerKind: 'mock',
  generating: [],
  config: DEFAULT_CONDUCTOR_CONFIG,

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

    const { provider, messages, personas } = get();
    const history = messages.filter((m) => m.id !== replyId);
    const req: ChatRequest = {
      model: persona.model,
      messages: buildPrompt(persona, history, personas),
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
      get().tick('message'); // a new line landed — let others react / fill freed slots
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
