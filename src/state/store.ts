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
import type { Participant, ServerMsg } from '../net/protocol';
import type { Transport } from '../net/transport';
import { WSTransport } from '../net/transport';
import { personas as basePersonas } from '../personas';
import * as db from '../persist/db';

const CHANNEL_ID = 'cafe';
const OLLAMA_URL = 'http://localhost:11434';
const KV_SUMMARIZED = 'summarizedCount';
const KV_OVERRIDES = 'personaOverrides';
const KV_CONFIG = 'conductorConfig';
const KV_MUTED = 'muted';
const KV_TOPIC = 'topic';

export type ProviderKind = 'mock' | 'ollama';

export interface ABSlot {
  personaId: string;
  text: string;
  pending: boolean;
}
export interface ABState {
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
    author: 'system',
    text: '* welcome to le-chat-cafe — say hi (type /who, /help) *',
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
  /** personaIds muted via /kick (excluded from the Conductor). */
  muted: string[];
  /** Channel topic shown in the header (/topic). */
  topic: string;
  /** Multiplayer (DESIGN §11): true while connected to a relay. */
  networked: boolean;
  /** True when this client drives the personas (single-player, or the relay host). */
  isHost: boolean;
  /** This client's participant id when networked ('' otherwise). */
  myId: string;
  /** Participants reported by the relay (humans), when networked. */
  remoteParticipants: Participant[];
  /** Sticky id→name cache so a departed participant's old lines still show a nick. */
  participantNames: Record<string, string>;

  init: () => Promise<void>;
  connect: (url: string, room: string, name: string) => Promise<void>;
  disconnect: () => void;
  sendUserMessage: (text: string) => void;
  /** Append a `* … *` system notice (joins/leaves/topic/command output). */
  postSystem: (text: string) => void;
  /** Handle a `/command` typed in the composer. */
  runCommand: (raw: string) => void;
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

// Module-scope I/O state (timers/flags/sockets), not domain state.
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;
let summarizing = false;
let transport: Transport | null = null;

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
  ab: { a: null, b: null, running: false },
  muted: [],
  topic: '',
  networked: false,
  isHost: true, // single-player drives its own personas
  myId: '',
  remoteParticipants: [],
  participantNames: {},

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
      const [saved, mems, rels, summarized, overrides, savedConfig, savedMuted, savedTopic] =
        await Promise.all([
          db.loadMessages(),
          db.loadMemory(),
          db.loadRelationships(),
          db.getKV<number>(KV_SUMMARIZED),
          db.getKV<Record<string, Partial<Persona>>>(KV_OVERRIDES),
          db.getKV<Partial<ConductorConfig>>(KV_CONFIG),
          db.getKV<string[]>(KV_MUTED),
          db.getKV<string>(KV_TOPIC),
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
        muted: savedMuted ?? [],
        topic: savedTopic ?? '',
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
          muted: [],
          topic: '',
        });
      },
      bumpAffinity: (from: string, delta: number, to = 'user') =>
        get().applyAffinityDeltas(from, { [to]: delta }),
    };

    scheduleIdle(); // let the room come alive on its own
  },

  async connect(url, room, name) {
    if (get().networked) return;
    clearIdle();
    const t = new WSTransport();

    // Merge a participant list into the sticky id→name cache.
    const cacheNames = (participants: Participant[]) => {
      const names = { ...get().participantNames };
      for (const p of participants) names[p.id] = p.name;
      return names;
    };

    t.onMessage((m: ServerMsg) => {
      if (m.t === 'welcome') {
        const isHost = m.you === m.hostId;
        set({
          networked: true,
          isHost,
          myId: m.you,
          remoteParticipants: m.participants,
          participantNames: cacheNames(m.participants),
          messages: m.log,
        });
        if (isHost) scheduleIdle(); // the host drives the room
      } else if (m.t === 'presence') {
        const me = m.participants.find((p) => p.id === get().myId);
        const becameHost = !!me?.isHost && !get().isHost;
        set({
          remoteParticipants: m.participants,
          participantNames: cacheNames(m.participants),
          isHost: me?.isHost ?? get().isHost,
        });
        if (becameHost) {
          // Host hand-off: the relay promoted us when the previous host left.
          get().postSystem('* you are now the host — driving the personas *');
          scheduleIdle();
        }
      } else if (m.t === 'message') {
        // Canonical, ordered message: upsert (finalizes a streamed turn for viewers).
        const exists = get().messages.some((x) => x.id === m.message.id);
        set((s) => ({
          messages: exists
            ? s.messages.map((x) => (x.id === m.message.id ? m.message : x))
            : [...s.messages, m.message],
        }));
        if (!exists && get().isHost) get().tick('message'); // host reacts to genuinely new lines
      } else if (m.t === 'stream') {
        // Live token update for a persona turn — viewers only (the host streams locally).
        if (get().isHost) return;
        set((s) => ({
          messages: s.messages.some((x) => x.id === m.message.id)
            ? s.messages.map((x) => (x.id === m.message.id ? { ...x, text: m.message.text, pending: m.message.pending } : x))
            : [...s.messages, m.message],
        }));
      }
    });

    // Every client offers to host; the relay makes the first one the host. (For
    // real personas that client should have Ollama; with Mock it drives stubs.)
    await t.connect({ url, room, name, canHost: true });
    transport = t;
  },

  disconnect() {
    transport?.close();
    transport = null;
    set({ networked: false, isHost: true, myId: '', remoteParticipants: [], participantNames: {} });
    scheduleIdle();
  },

  sendUserMessage(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('/')) {
      get().runCommand(trimmed);
      return;
    }
    // Networked: send through the relay; it broadcasts back and we append on
    // receipt (the relay is the single source of order). No local append/persist.
    if (get().networked && transport) {
      transport.send({
        t: 'say',
        message: {
          id: uid(),
          channelId: CHANNEL_ID,
          author: get().myId || 'user',
          text: trimmed,
          ts: Date.now(),
        },
      });
      return;
    }
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
    // In a networked room only the host drives personas; joiners just render.
    if (get().networked && !get().isHost) return;
    const { personas, messages, generating, config, muted } = get();
    const chosen = selectSpeakers({
      personas: personas.filter((p) => !muted.includes(p.id)),
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
    let lastStreamed = 0;
    try {
      for await (const chunk of provider.chat(req)) {
        if (!chunk.token) continue;
        raw += chunk.token;
        const shown = visibleText(raw);
        set((s) => ({
          messages: s.messages.map((m) => (m.id === replyId ? { ...m, text: shown } : m)),
        }));
        // Host: stream live token updates to viewers, throttled (the final `say`
        // below carries the canonical message). M6.2.
        if (get().networked && transport) {
          const now = Date.now();
          if (now - lastStreamed > 100) {
            lastStreamed = now;
            transport.send({
              t: 'stream',
              message: { id: replyId, channelId: CHANNEL_ID, author: persona.id, text: shown, ts: pending.ts, pending: true },
            });
          }
        }
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
      if (finalized) {
        if (get().networked) {
          // Host: publish the persona turn to the room (joiners render it). The
          // relay echoes it back, where ingest dedups by id. (Streaming over the
          // wire is M6.2; for now joiners get the final message.)
          transport?.send({ t: 'say', message: finalized });
        } else {
          void db.saveMessage(finalized).catch(() => {});
        }
      }
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
    if (get().networked) return; // timeline edits are local-only (relay owns order)
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
    if (get().networked) return; // timeline edits are local-only (relay owns order)
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

  postSystem(text) {
    const msg: Message = { id: uid(), channelId: CHANNEL_ID, author: 'system', text, ts: Date.now() };
    set((s) => ({ messages: [...s.messages, msg] }));
    void db.saveMessage(msg).catch(() => {});
  },

  runCommand(raw) {
    const parts = raw.slice(1).trim().split(/\s+/);
    const cmd = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1);
    const { personas, muted } = get();
    const find = (nick: string | undefined) =>
      nick
        ? personas.find(
            (p) => p.name.toLowerCase() === nick.toLowerCase() || p.id === nick.toLowerCase(),
          )
        : undefined;

    switch (cmd) {
      case 'who': {
        const personaList = personas.map((p) => (muted.includes(p.id) ? `${p.name} (muted)` : p.name));
        const humans = get().networked
          ? get().remoteParticipants
              .filter((p) => p.kind === 'human')
              .map((p) => (p.id === get().myId ? `${p.name} (you)` : p.name))
          : ['you'];
        get().postSystem(`* in the room: ${[...humans, ...personaList].join(', ')} *`);
        break;
      }
      case 'help':
        get().postSystem(
          '* commands: /who /msg <nick> <text> /kick <nick> /invite <nick> /topic <text> /me <action> /regen /fork *',
        );
        break;
      case 'msg': {
        const target = find(args[0]);
        const body = args.slice(1).join(' ');
        if (!target) {
          get().postSystem(`* no one here called "${args[0] ?? ''}" *`);
          break;
        }
        if (!body) break;
        const text = `${target.name}: ${body}`;
        // Networked: send as a normal human turn; the host's Conductor sees the
        // mention and answers. Single-player: append + drive the persona directly.
        if (get().networked && transport) {
          transport.send({
            t: 'say',
            message: { id: uid(), channelId: CHANNEL_ID, author: get().myId || 'user', text, ts: Date.now() },
          });
          break;
        }
        clearIdle();
        const msg: Message = { id: uid(), channelId: CHANNEL_ID, author: 'user', text, ts: Date.now() };
        set((s) => ({ messages: [...s.messages, msg] }));
        void db.saveMessage(msg).catch(() => {});
        if (!get().muted.includes(target.id)) void get().startGeneration(target);
        break;
      }
      case 'kick': {
        const target = find(args[0]);
        if (!target) {
          get().postSystem(`* no one here called "${args[0] ?? ''}" *`);
          break;
        }
        if (!get().muted.includes(target.id)) {
          const next = [...get().muted, target.id];
          set({ muted: next });
          void db.setKV(KV_MUTED, next).catch(() => {});
        }
        get().postSystem(`* ${target.name} has been kicked *`);
        break;
      }
      case 'invite': {
        const target = find(args[0]);
        if (!target) {
          get().postSystem(`* no one here called "${args[0] ?? ''}" *`);
          break;
        }
        const next = get().muted.filter((id) => id !== target.id);
        set({ muted: next });
        void db.setKV(KV_MUTED, next).catch(() => {});
        get().postSystem(`* ${target.name} has joined *`);
        break;
      }
      case 'topic': {
        const topic = args.join(' ');
        set({ topic });
        void db.setKV(KV_TOPIC, topic).catch(() => {});
        get().postSystem(topic ? `* topic set: ${topic} *` : '* topic cleared *');
        break;
      }
      case 'me': {
        const action = args.join(' ');
        if (action) get().postSystem(`* you ${action} *`);
        break;
      }
      case 'regen':
        get().regenerateLast();
        break;
      case 'fork': {
        const lastUser = [...get().messages].reverse().find((m) => m.author === 'user');
        if (lastUser) {
          get().forkAt(lastUser.id);
          get().postSystem('* rewound to your last message *');
        }
        break;
      }
      default:
        get().postSystem(`* unknown command: /${cmd} (try /help) *`);
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
