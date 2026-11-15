import { create } from 'zustand';
import type { ChatRequest, LLMProvider } from '../llm/provider';
import { MockProvider } from '../llm/mock';
import { OllamaProvider } from '../llm/ollama';
import { resolveModel } from '../llm/models';
import type {
  ConductorConfig,
  Message,
  Persona,
  PersonaMemory,
  PresenceChange,
  Relationship,
} from '../core/types';
import type { Trigger } from '../core/conductor';
import {
  DEFAULT_CONDUCTOR_CONFIG,
  isHumanAuthor,
  nextIdleDelay,
  selectSpeakers,
  triggerMessage,
} from '../core/conductor';
import {
  nextPresenceDelay,
  onlineSet,
  planPresenceChange,
  quitMessage,
} from '../core/presence';
import {
  breaksCharacter,
  characterPriors,
  cutAtNextSpeaker,
  isEcho,
  recitesPrompt,
  stripNamePrefix,
} from '../runtime/repetition';
import {
  assemblePrompt,
  buildPromptParts,
  formatTranscript,
  recitationSource,
} from '../runtime/personaRuntime';
import { KEEP_VERBATIM, mergeNotes, shouldSummarize, summarizeForPersona } from '../runtime/memory';
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
import { validateNick } from '../util/nick';
import {
  HOME,
  channelLabel,
  dmId,
  dmPersonaId,
  findChannel,
  isDm,
  membersOf,
  pickDmSender,
  splitLogs,
} from '../core/channels';
import { channels as channelDefs } from '../channels';
import { formatLog, logFilename } from '../util/exportLog';
import { downloadText } from '../util/download';

const OLLAMA_URL = 'http://localhost:11434';
/** One-off prompt nudge for a persona arriving (DESIGN §12.2). */
const GREETING_DIRECTIVE =
  "You just came back into the chat. Say a quick hello to the room in your own way — one short line.";
/** One-off nudge for a persona who DMs you first (DESIGN §12.4). */
const dmOpener = (you: string) =>
  `You're sending ${you} a private message while they're off in another channel. ` +
  `Open with one short, friendly line in your own voice — check in, or follow up on ` +
  `something they said.`;
const KV_LEGACY_SUMMARIZED = 'summarizedCount'; // pre-channels single cursor (#cafe)
const KV_LEGACY_TOPIC = 'topic'; // pre-channels single topic (#cafe)
const KV_SUMMARIZED = 'summarized';
const KV_TOPICS = 'topics';
const KV_OVERRIDES = 'personaOverrides';
const KV_CONFIG = 'conductorConfig';
const KV_MUTED = 'muted';
const KV_NICK = 'nick';
const KV_CHANNEL = 'channel';
const KV_JOINED = 'joined';
const KV_DMS = 'dms';
const KV_UNREAD = 'unread';

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

// Monotonic message timestamps: user message + immediate reply often land in the
// same millisecond, and IndexedDB's by-ts index breaks ties by (random) id — the
// hydrated log could reorder a reply above its question.
let lastTs = 0;
function nextTs(): number {
  const t = Math.max(Date.now(), lastTs + 1);
  lastTs = t;
  return t;
}

/** Remove exactly one occurrence — `filter` would clear duplicate reservations. */
function removeOne(arr: string[], value: string): string[] {
  const i = arr.indexOf(value);
  return i < 0 ? arr : [...arr.slice(0, i), ...arr.slice(i + 1)];
}

/** After deleting messages (fork/regenerate), the active channel's summarization
 *  cursor may point past the end of its log — note-taking would stall until the log
 *  regrows. */
function clampSummarizedCount(get: () => RoomState): void {
  const { channel, summarized, messages } = get();
  const current = summarized[channel] ?? 0;
  const clamped = Math.min(current, Math.max(0, messages.length - KEEP_VERBATIM));
  if (clamped !== current) setCursor(channel, clamped);
}

/** Move one channel's summarization cursor (and persist the map). */
function setCursor(channelId: string, value: number): void {
  const summarized = { ...useRoom.getState().summarized, [channelId]: value };
  useRoom.setState({ summarized });
  void db.setKV(KV_SUMMARIZED, summarized).catch(() => {});
}

function welcomeMessage(): Message {
  return {
    id: uid(),
    channelId: HOME,
    author: 'system',
    text: '* welcome to le-chat-cafe — say hi (try /nick <name>, or /help) *',
    ts: nextTs(),
    notice: true,
  };
}

/** The first thing you see in a channel or DM you've never opened before. */
function introText(channelId: string, personas: Persona[]): string {
  const label = channelLabel(channelId, personas);
  if (isDm(channelId)) {
    return `* private chat with ${label.slice(1)} — only the two of you see this (/part closes it) *`;
  }
  const def = channelDefs.find((c) => c.id === channelId);
  return `* now talking in ${label}${def ? ` — ${def.topic}` : ''} *`;
}

function derivePersonas(overrides: Record<string, Partial<Persona>>): Persona[] {
  return basePersonas.map((p) => mergePersona(p, overrides[p.id] ?? {}));
}

/** A presence event: an ordinary system line that also carries the change, so
 *  presence can be derived from the log (DESIGN §12.2). */
function presenceMessage(channelId: string, text: string, change: PresenceChange): Message {
  return { id: uid(), channelId, author: 'system', text, ts: nextTs(), presence: change };
}

/** A channel's log, wherever it lives: the active view or the stash. */
function logOf(s: Pick<RoomState, 'channel' | 'messages' | 'logs'>, channelId: string): Message[] {
  return s.channel === channelId ? s.messages : (s.logs[channelId] ?? []);
}

/** Rewrite one channel's log in place — a reply that finishes after you switched
 *  away must land in its own channel, not the one you're looking at. */
function updateLog(channelId: string, fn: (log: Message[]) => Message[]): void {
  useRoom.setState((s) =>
    s.channel === channelId
      ? { messages: fn(s.messages) }
      : { logs: { ...s.logs, [channelId]: fn(s.logs[channelId] ?? []) } },
  );
}

/** How a channel is described in the prompt header (DESIGN §12.4). A topic you set
 *  rides along for as long as it stands; the "topic set" line alone scrolls out of
 *  the window within a few turns, and the room drifts back to whatever it was on. */
function placeOf(channelId: string, topics: Record<string, string>): string {
  if (isDm(channelId)) return 'a private one-on-one chat';
  const def = channelDefs.find((c) => c.id === channelId);
  const topic = topics[channelId] ? `; the topic right now: ${topics[channelId]}` : '';
  return def ? `#${def.id} (${def.about}${topic})` : `#${channelId}`;
}

/** Your display name right now: the connect nick in a shared room, else /nick. */
export function selfName(s: Pick<RoomState, 'networked' | 'connection' | 'nick'>): string {
  return s.networked ? (s.connection?.name ?? '') : s.nick;
}

/** How prompts name the humans present (DESIGN §12.1): your nick in single-player,
 *  every connected human in a shared room. */
function promptPeople(s: RoomState): { names: Record<string, string>; humans: string[] } {
  const names = { ...s.participantNames };
  if (s.nick) names.user = s.nick;
  const humans = s.networked
    ? s.remoteParticipants.filter((p) => p.kind === 'human').map((p) => p.name)
    : [s.nick || 'the user'];
  return { names, humans };
}

/** Every label a reply could fake a turn under: persona names + aliases, and the
 *  humans' display names (see `cutAtNextSpeaker`). */
function speakerLabels(personas: Persona[], people: { names: Record<string, string>; humans: string[] }): string[] {
  return [
    ...personas.flatMap((p) => [p.name, ...(p.aliases ?? [])]),
    ...Object.values(people.names),
    ...people.humans,
  ];
}

interface RoomState {
  personas: Persona[];
  /** The active channel's log — everything that reads "the room" reads this. */
  messages: Message[];
  /** The channel or DM you're looking at (DESIGN §12.4): "cafe", "arcade", "dm:mira". */
  channel: string;
  /** Logs of the other channels, stashed while you're elsewhere. */
  logs: Record<string, Message[]>;
  /** Public channels you've joined (the channel pane); home is always first. */
  joined: string[];
  /** Personas you have a DM window open with, in the order they opened. */
  dms: string[];
  /** Unread persona lines per channel you aren't looking at. */
  unread: Record<string, number>;
  /** /topic overrides per channel ('' = use the channel's default). */
  topics: Record<string, string>;
  /** Switch the view to another channel or DM. */
  switchChannel: (id: string) => void;
  /** Open (or focus) a private chat with a persona. */
  openDm: (personaId: string) => void;
  /** Close a DM window, or part a channel (home can't be parted). */
  closeWindow: (id: string) => void;
  provider: LLMProvider;
  providerKind: ProviderKind;
  /** Model tags installed on the local Ollama ([] = unknown / mock). */
  availableModels: string[];
  /** personaIds currently streaming (concurrency cap lives in the Conductor). */
  generating: string[];
  config: ConductorConfig;
  /** Per-persona long-term notes (DESIGN §6.3), keyed by personaId. */
  memory: Record<string, PersonaMemory>;
  /** Per channel: how many of its oldest messages are already folded into notes. */
  summarized: Record<string, number>;
  /** Affinity relationships (DESIGN §6.6), keyed by `${from}:${to}`. */
  relationships: Record<string, Relationship>;
  /** Playground persona edits (DESIGN §6.7), merged onto the JSON base. */
  personaOverrides: Record<string, Partial<Persona>>;
  /** A/B comparison scratch state. */
  ab: ABState;
  /** personaIds muted via /kick (excluded from the Conductor). */
  muted: string[];
  /** Your display name (/nick, DESIGN §12.1); '' = unset. */
  nick: string;
  /** Persona whose profile card is open (/whois, DESIGN §12.3); UI-only. */
  profileId: string | null;
  openProfile: (id: string) => void;
  closeProfile: () => void;
  /** Multiplayer (DESIGN §11): true while connected to a relay. */
  networked: boolean;
  /** True when this client drives the personas (single-player, or the relay host). */
  isHost: boolean;
  /** This client's participant id when networked ('' otherwise). */
  myId: string;
  /** Every id the relay has ever assigned this client (reconnects mint new ids) —
   *  needed so the user's pre-reconnect lines still render as "you". */
  myIds: string[];
  /** Participants reported by the relay (humans), when networked. */
  remoteParticipants: Participant[];
  /** Sticky id→name cache so a departed participant's old lines still show a nick. */
  participantNames: Record<string, string>;
  /** Room/nick of the live connection (drives the Playground banner). */
  connection: { room: string; name: string } | null;

  init: () => Promise<void>;
  connect: (url: string, room: string, name: string) => Promise<void>;
  disconnect: () => void;
  sendUserMessage: (text: string) => void;
  /** Append a `* … *` system line. A `notice` (the default: command output, errors,
   *  local ephemera) is shown to you only; an `event` (/me, /topic, a nick change) is
   *  part of the room and reaches the personas' prompts. */
  postSystem: (text: string, kind?: 'notice' | 'event') => void;
  /** Post a *shared* room event (a presence line): persisted in single-player; in a
   *  shared room the host broadcasts it and every client derives the same state. */
  postEvent: (msg: Message) => void;
  /** Maybe send one persona away or bring one back (DESIGN §12.2). */
  presenceTick: () => void;
  /** Have an arriving persona say hello, if a reply slot is free. */
  greet: (persona: Persona) => void;
  /** Handle a `/command` typed in the composer. */
  runCommand: (raw: string) => void;
  tick: (trigger: Trigger) => void;
  /** Stream one persona turn into a channel (default: the active one). */
  startGeneration: (persona: Persona, opts?: { directive?: string; channelId?: string }) => Promise<void>;
  /** Maybe have a persona who likes you DM you first (DESIGN §12.4); returns who. */
  maybePersonaDm: (rng?: () => number) => string | null;
  maybeSummarize: (channelId?: string) => Promise<void>;
  /** Drop one remembered note (by its text), or all of a persona's notes. */
  forget: (personaId: string, note?: string) => void;
  affinityOf: (from: string, to: string) => number;
  applyAffinityDeltas: (from: string, deltas: Record<string, number>) => void;
  /** The model tag to actually run for a persona (falls back to an installed one). */
  modelFor: (persona: Persona) => string;

  // --- Playground (M4) ---
  updatePersona: (id: string, patch: Partial<Persona>) => void;
  updateConfig: (patch: Partial<ConductorConfig>) => void;
  regenerateLast: () => void;
  forkAt: (id: string) => void;
  runAB: (prompt: string, aId: string, bId: string) => Promise<void>;
}

// Module-scope I/O state (timers/flags/sockets), not domain state.
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let presenceTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;
let summarizing = false;
let transport: Transport | null = null;
const modelNoticeShown = new Set<string>(); // one substitution notice per persona+tag
// Consecutive idle-driven turns since the last human message — drives the bursty
// idle pacing (§4.1): gaps grow with the streak, a human message resets it.
let idleStreak = 0;
// Echo-guard cooldown: a dropped turn leaves no message in the log, so the persona
// isn't on normal cooldown and the same trigger could re-select it immediately —
// a stuck model would loop generate→drop→generate. Park it briefly instead.
const droppedUntil = new Map<string, number>();
const DROP_COOLDOWN_MS = 30_000;
// Arrivals waiting to say hello because both reply slots were busy when they came
// in — the next free slot goes to them (DESIGN §12.2).
const pendingGreetings = new Set<string>();
// When a persona last DMed you first. Starts at load time, so the first one comes
// at least `dmGapMs` into a visit, never the moment you open the app.
let lastPersonaDm = Date.now();

export const useRoom = create<RoomState>((set, get) => ({
  personas: basePersonas,
  messages: [welcomeMessage()],
  channel: HOME,
  logs: {},
  joined: [HOME],
  dms: [],
  unread: {},
  topics: {},

  switchChannel(id) {
    const s = get();
    if (id === s.channel) return;
    if (s.networked) {
      get().postSystem('* a shared room is one channel — disconnect to switch *');
      return;
    }
    const next = s.logs[id] ?? [];
    const logs = { ...s.logs, [s.channel]: s.messages };
    delete logs[id];
    const unread = { ...s.unread };
    delete unread[id];
    set({ channel: id, messages: next, logs, unread });
    void db.setKV(KV_CHANNEL, id).catch(() => {});
    void db.setKV(KV_UNREAD, unread).catch(() => {});
    if (next.length === 0) get().postSystem(introText(id, s.personas));
    // A fresh room: chatter picks up quickly, and comings & goings start early.
    idleStreak = 0;
    pendingGreetings.clear(); // greetings belong to the room they arrived in
    scheduleIdle();
    schedulePresence(true);
    get().tick('message'); // e.g. answer a DM you left waiting
  },

  openDm(personaId) {
    if (get().networked) {
      get().postSystem("* private messages aren't available in a shared room *");
      return;
    }
    if (!get().personas.some((p) => p.id === personaId)) return;
    if (!get().dms.includes(personaId)) {
      const dms = [...get().dms, personaId];
      set({ dms });
      void db.setKV(KV_DMS, dms).catch(() => {});
    }
    get().switchChannel(dmId(personaId));
  },

  closeWindow(id) {
    const dm = dmPersonaId(id);
    if (dm) {
      // The DM's history stays in the log; reopening the window brings it back.
      const dms = get().dms.filter((d) => d !== dm);
      set({ dms });
      void db.setKV(KV_DMS, dms).catch(() => {});
    } else {
      if (id === HOME) return;
      const joined = get().joined.filter((c) => c !== id);
      set({ joined });
      void db.setKV(KV_JOINED, joined).catch(() => {});
    }
    if (get().channel === id) get().switchChannel(HOME);
  },
  provider: new MockProvider(),
  providerKind: 'mock',
  availableModels: [],
  generating: [],
  config: DEFAULT_CONDUCTOR_CONFIG,
  memory: {},
  summarized: {},
  relationships: {},
  personaOverrides: {},
  ab: { a: null, b: null, running: false },
  muted: [],
  nick: '',
  profileId: null,
  openProfile: (id) => set({ profileId: id }),
  closeProfile: () => set({ profileId: null }),
  networked: false,
  isHost: true, // single-player drives its own personas
  myId: '',
  myIds: [],
  remoteParticipants: [],
  participantNames: {},
  connection: null,

  async init() {
    if (initialized) return; // guard against React StrictMode double-invoke
    initialized = true;

    // Probe Ollama; this fetch also doubles as the CORS check (DESIGN §9).
    // Fall back to the MockProvider so the app always runs.
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET' });
      if (res.ok) {
        // The tags list doubles as the installed-model inventory, so persona
        // model tags can be resolved against what this machine actually has.
        const data = (await res.json()) as { models?: { name: string }[] };
        set({
          provider: new OllamaProvider({ baseUrl: OLLAMA_URL }),
          providerKind: 'ollama',
          availableModels: (data.models ?? []).map((m) => m.name),
        });
      }
    } catch {
      // stay on MockProvider
    }

    // Hydrate everything persisted (DESIGN §6.2). If nothing's stored, persist
    // the seed welcome so the next reload restores it.
    try {
      const [stored, mems, rels, overrides, savedConfig, savedMuted, savedNick] = await Promise.all([
        db.loadMessages(),
        db.loadMemory(),
        db.loadRelationships(),
        db.getKV<Record<string, Partial<Persona>>>(KV_OVERRIDES),
        db.getKV<Partial<ConductorConfig>>(KV_CONFIG),
        db.getKV<string[]>(KV_MUTED),
        db.getKV<string>(KV_NICK),
      ]);
      const [cursors, legacyCursor, topicMap, legacyTopic, savedChannel, savedJoined, savedDms, savedUnread] =
        await Promise.all([
          db.getKV<Record<string, number>>(KV_SUMMARIZED),
          db.getKV<number>(KV_LEGACY_SUMMARIZED),
          db.getKV<Record<string, string>>(KV_TOPICS),
          db.getKV<string>(KV_LEGACY_TOPIC),
          db.getKV<string>(KV_CHANNEL),
          db.getKV<string[]>(KV_JOINED),
          db.getKV<string[]>(KV_DMS),
          db.getKV<Record<string, number>>(KV_UNREAD),
        ]);
      // A malformed row (text that isn't a string — written by a build with a bug in
      // it) would crash every prompt and render that touches it. Drop it for good.
      const saved = stored.filter((m) => typeof m.text === 'string' && typeof m.channelId === 'string');
      for (const bad of stored.filter((m) => !saved.includes(m))) void db.deleteMessage(bad.id).catch(() => {});
      if (saved.length === 0) await db.saveMessage(get().messages[0]);

      // Channels (DESIGN §12.4): one stored log, split by channelId. You come back to
      // the window you left, as long as it still exists.
      const byChannel = splitLogs(saved.length > 0 ? saved : get().messages);
      const joined = [
        HOME,
        ...(savedJoined ?? []).filter((c) => c !== HOME && channelDefs.some((d) => d.id === c)),
      ];
      const dms = (savedDms ?? []).filter((id) => basePersonas.some((p) => p.id === id));
      const reopenable = (id: string) =>
        joined.includes(id) || (isDm(id) && dms.includes(dmPersonaId(id) ?? ''));
      const channel = savedChannel && reopenable(savedChannel) ? savedChannel : HOME;
      const messages = byChannel[channel] ?? [];
      delete byChannel[channel];
      set({
        channel,
        messages,
        logs: byChannel,
        joined,
        dms,
        unread: savedUnread ?? {},
        // Data from before channels had one cursor and one topic, both #cafe's.
        summarized: cursors ?? (legacyCursor ? { [HOME]: legacyCursor } : {}),
        topics: topicMap ?? (legacyTopic ? { [HOME]: legacyTopic } : {}),
      });

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
        relationships,
        personaOverrides,
        personas: derivePersonas(personaOverrides),
        config: { ...DEFAULT_CONDUCTOR_CONFIG, ...(savedConfig ?? {}) },
        muted: savedMuted ?? [],
        nick: savedNick ?? '',
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
          // Your name is identity, not history — it survives a history wipe.
          if (get().nick) await db.setKV(KV_NICK, get().nick);
        } catch {
          /* ignore */
        }
        set({
          messages: [welcome],
          channel: HOME,
          logs: {},
          joined: [HOME],
          dms: [],
          unread: {},
          topics: {},
          memory: {},
          summarized: {},
          relationships: {},
          personaOverrides: {},
          personas: derivePersonas({}),
          config: DEFAULT_CONDUCTOR_CONFIG,
          muted: [],
        });
      },
      bumpAffinity: (from: string, delta: number, to = 'user') =>
        get().applyAffinityDeltas(from, { [to]: delta }),
      presenceTick: () => get().presenceTick(),
      /** Skip the wait and the dice: a persona who likes you DMs you now, if any can. */
      dmNow: () => {
        lastPersonaDm = 0;
        return get().maybePersonaDm(() => 0);
      },
    };

    scheduleIdle(); // let the room come alive on its own
    schedulePresence(true); // first comings & goings land early in a visit
  },

  async connect(url, room, name) {
    if (get().networked) return;
    // A shared room is one channel (DESIGN §12.4): go home first so the channel you
    // were in is stashed intact; the relay's log then replaces home's view.
    get().switchChannel(HOME);
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
        set((s) => ({
          networked: true,
          isHost,
          myId: m.you,
          myIds: s.myIds.includes(m.you) ? s.myIds : [...s.myIds, m.you],
          remoteParticipants: m.participants,
          participantNames: cacheNames(m.participants),
          messages: m.log,
        }));
        // The host drives the room (idle turns + comings & goings); viewers don't.
        if (isHost) {
          scheduleIdle();
          schedulePresence();
        } else {
          clearPresence();
        }
      } else if (m.t === 'presence') {
        const prevHostId = get().remoteParticipants.find((p) => p.isHost)?.id;
        const newHostId = m.participants.find((p) => p.isHost)?.id;
        const me = m.participants.find((p) => p.id === get().myId);
        const becameHost = !!me?.isHost && !get().isHost;
        set({
          remoteParticipants: m.participants,
          participantNames: cacheNames(m.participants),
          isHost: me?.isHost ?? get().isHost,
        });
        // The host changed (left/died): any still-pending streamed persona lines
        // will never get their final `say` — drop the ghosts.
        if (prevHostId && newHostId !== prevHostId) {
          set((s) => ({ messages: s.messages.filter((x) => !x.pending) }));
        }
        if (becameHost) {
          // Host hand-off: the relay promoted us when the previous host left.
          get().postSystem('* you are now the host — driving the personas *');
          scheduleIdle();
          schedulePresence();
        }
      } else if (m.t === 'message') {
        // Canonical, ordered message. Append in relay order (moving a streamed
        // provisional line to its final position) so every client — including
        // late joiners hydrating from the snapshot — sees the same ordering.
        const exists = get().messages.some((x) => x.id === m.message.id);
        if (isHumanAuthor(m.message.author)) idleStreak = 0; // a human spoke — the room heats back up
        set((s) => ({
          messages: [...s.messages.filter((x) => x.id !== m.message.id), m.message],
        }));
        if (!exists && get().isHost) get().tick('message'); // host reacts to genuinely new lines
      } else if (m.t === 'stream') {
        // Live token update for a persona turn — viewers only (the host streams locally).
        if (get().isHost) return;
        // A final empty frame retracts the turn (the host's echo guard dropped it).
        if (!m.message.pending && !m.message.text) {
          set((s) => ({ messages: s.messages.filter((x) => x.id !== m.message.id) }));
          return;
        }
        set((s) => ({
          messages: s.messages.some((x) => x.id === m.message.id)
            ? s.messages.map((x) => (x.id === m.message.id ? { ...x, text: m.message.text, pending: m.message.pending } : x))
            : [...s.messages, m.message],
        }));
      }
    });

    // Terminal connection loss (reconnects exhausted): drop back to single-player
    // visibly instead of black-holing everything the user types.
    t.onClose(() => {
      if (transport !== t) return;
      transport = null;
      set({ networked: false, isHost: true, myId: '', remoteParticipants: [], connection: null });
      get().postSystem('* connection lost — back to single-player *');
      void db
        .loadMessages()
        .then((saved) => {
          const home = saved.filter((m) => m.channelId === HOME);
          if (home.length > 0) set({ messages: home });
        })
        .catch(() => {});
      scheduleIdle();
      schedulePresence();
    });

    // Every client offers to host; the relay makes the first one the host. (For
    // real personas that client should have Ollama; with Mock it drives stubs.)
    try {
      await t.connect({ url, room, name, canHost: true });
    } catch (err) {
      // Neutralize the failed transport (cancels any retry) and restore the
      // single-player idle loop the clearIdle() above suspended.
      t.close();
      scheduleIdle();
      throw err;
    }
    transport = t;
    set({ connection: { room, name } });
  },

  disconnect() {
    transport?.close();
    transport = null;
    // Keep myIds + participantNames (sticky) so any retained lines stay readable;
    // restore the persisted single-player timeline — the networked log is
    // session-only and must not be built upon by single-player persistence.
    set({ networked: false, isHost: true, myId: '', remoteParticipants: [], connection: null });
    void db
      .loadMessages()
      .then((saved) => {
        const home = saved.filter((m) => m.channelId === HOME);
        set({ messages: home.length > 0 ? home : [welcomeMessage()] });
      })
      .catch(() => {});
    scheduleIdle();
    schedulePresence();
  },

  sendUserMessage(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('/')) {
      get().runCommand(trimmed);
      return;
    }
    idleStreak = 0; // a human spoke — the room heats back up (§4.1)
    // Networked: send through the relay; it broadcasts back and we append on
    // receipt (the relay is the single source of order). No local append/persist.
    if (get().networked && transport) {
      const delivered = transport.send({
        t: 'say',
        message: {
          id: uid(),
          channelId: HOME,
          author: get().myId || 'user',
          text: trimmed,
          ts: nextTs(),
        },
      });
      if (!delivered) {
        get().postSystem('* message not delivered — reconnecting to the relay… *');
      }
      return;
    }
    clearIdle();
    const msg: Message = {
      id: uid(),
      channelId: get().channel,
      author: 'user',
      text: trimmed,
      ts: nextTs(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
    void db.saveMessage(msg).catch(() => {});
    get().tick('message');
  },

  tick(trigger) {
    // In a networked room only the host drives personas; joiners just render.
    if (get().networked && !get().isHost) return;
    const { channel } = get();

    // A DM is a conversation, not a room (DESIGN §12.4): the persona answers what you
    // left unanswered and never chatters on its own. The idle timer doubles as the
    // retry when a turn guard dropped their reply.
    const dmWith = dmPersonaId(channel);
    if (dmWith) {
      const { personas, messages, generating, config } = get();
      const persona = personas.find((p) => p.id === dmWith);
      const latest = triggerMessage(messages);
      const free =
        !!persona &&
        !generating.includes(persona.id) &&
        generating.length < config.maxConcurrent &&
        (droppedUntil.get(persona.id) ?? 0) <= Date.now();
      if (persona && free && latest?.author === 'user') void get().startGeneration(persona);
      else if (generating.length === 0) scheduleIdle();
      return;
    }

    // Only this channel's crowd, and only those present, can speak (§12.2, §12.4).
    const members = membersOf(channel, get().personas);
    const online = onlineSet(get().messages, members);

    // A queued arrival greeting takes the next free slot, ahead of normal turns.
    for (const id of [...pendingGreetings]) {
      const { generating, config, muted } = get();
      if (generating.length >= config.maxConcurrent) break;
      const arrival = members.find((p) => p.id === id);
      if (!arrival || !online.has(id) || muted.includes(id)) {
        pendingGreetings.delete(id); // left again (or was kicked) before getting a word in
        continue;
      }
      if (generating.includes(id)) continue;
      pendingGreetings.delete(id);
      void get().startGeneration(arrival, { directive: GREETING_DIRECTIVE });
    }

    const { messages, generating, config, muted } = get();
    const now = Date.now();
    const chosen = selectSpeakers({
      personas: members.filter(
        (p) => online.has(p.id) && !muted.includes(p.id) && (droppedUntil.get(p.id) ?? 0) <= now,
      ),
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
      const persona = members.find((p) => p.id === candidate.personaId);
      if (persona) void get().startGeneration(persona);
    }
  },

  async startGeneration(persona, opts = {}) {
    clearIdle();
    // A turn belongs to the channel it started in, even if you switch away mid-reply.
    const channelId = opts.channelId ?? get().channel;
    // The persist/broadcast decision must reflect the mode this turn STARTED in —
    // a mid-stream disconnect must not leak a networked turn into the
    // single-player IndexedDB log (or vice versa).
    const startedNetworked = get().networked;
    const replyId = uid();
    const pending: Message = {
      id: replyId,
      channelId,
      author: persona.id,
      text: '',
      ts: nextTs(),
      pending: true,
    };
    // Reserve the concurrency slot + show the pending line synchronously, before
    // any await, so concurrent ticks see an accurate `generating` set.
    set((s) => ({ generating: [...s.generating, persona.id] }));
    updateLog(channelId, (log) => [...log, pending]);

    const { provider, personas, memory } = get();
    const history = logOf(get(), channelId).filter((m) => m.id !== replyId);
    const notes = memory[persona.id]?.notes ?? [];
    const affinities: Record<string, number> = { user: get().affinityOf(persona.id, 'user') };
    for (const other of personas) {
      if (other.id !== persona.id) affinities[other.id] = get().affinityOf(persona.id, other.id);
    }
    const people = promptPeople(get());
    const parts = buildPromptParts(persona, history, personas, {
      notes,
      affinities,
      ...people,
      present: [...onlineSet(history, membersOf(channelId, personas))],
      directive: opts.directive,
      place: placeOf(channelId, get().topics),
    });
    // A reply ends where a new speaker would begin (the model writing someone
    // else's turn, or a fake room event) — applied mid-stream and on finalize.
    const labels = speakerLabels(personas, people);
    const ownTurn = (text: string) => cutAtNextSpeaker(stripNamePrefix(text, persona.name), labels);
    const req: ChatRequest = {
      model: get().modelFor(persona),
      messages: assemblePrompt(parts),
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
        const shown = ownTurn(visibleText(raw));
        updateLog(channelId, (log) => log.map((m) => (m.id === replyId ? { ...m, text: shown } : m)));
        // Host: stream live token updates to viewers, throttled (the final `say`
        // below carries the canonical message). M6.2.
        if (startedNetworked && transport) {
          const now = Date.now();
          if (now - lastStreamed > 100) {
            lastStreamed = now;
            transport.send({
              t: 'stream',
              message: { id: replyId, channelId, author: persona.id, text: shown, ts: pending.ts, pending: true },
            });
          }
        }
      }
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      if (!raw) raw = `(couldn't reach the model — ${note})`;
    } finally {
      const { clean: stripped, deltas } = stripAffinity(raw);
      const clean = ownTurn(stripped);
      // Turn guards (DESIGN §9): small models sometimes parrot their character
      // prompt, repeat a line they already said, or step out of the fiction. Drop
      // such turns — a beat of silence reads better than a stuck record.
      const priors = [
        ...logOf(get(), channelId)
          .filter((m) => m.author === persona.id && m.id !== replyId && !m.pending)
          .slice(-6)
          .map((m) => m.text),
        ...characterPriors(persona.systemPrompt),
      ];
      const dropped =
        !clean ||
        isEcho(clean, priors) ||
        recitesPrompt(clean, recitationSource(parts)) ||
        breaksCharacter(clean, persona);
      updateLog(channelId, (log) =>
        dropped
          ? log.filter((m) => m.id !== replyId)
          : log.map((m) => (m.id === replyId ? { ...m, text: clean, pending: false } : m)),
      );
      set((s) => ({ generating: removeOne(s.generating, persona.id) }));
      if (dropped) {
        droppedUntil.set(persona.id, Date.now() + DROP_COOLDOWN_MS);
        // Retract any live frames viewers already saw (empty final = remove).
        if (startedNetworked) {
          transport?.send({
            t: 'stream',
            message: { id: replyId, channelId, author: persona.id, text: '', ts: pending.ts, pending: false },
          });
        }
      } else {
        get().applyAffinityDeltas(persona.id, deltas);
        const finalized = logOf(get(), channelId).find((m) => m.id === replyId);
        if (finalized) {
          if (startedNetworked) {
            // Host: publish the persona turn to the room (joiners render it). The
            // relay echoes it back, where ingest dedups by id.
            transport?.send({ t: 'say', message: finalized });
          } else {
            void db.saveMessage(finalized).catch(() => {});
          }
          // Landed somewhere you aren't looking: the channel pane shows a badge.
          if (channelId !== get().channel) {
            const unread = { ...get().unread, [channelId]: (get().unread[channelId] ?? 0) + 1 };
            set({ unread });
            void db.setKV(KV_UNREAD, unread).catch(() => {});
          }
        }
        void get().maybeSummarize(channelId);
      }
      get().tick('message'); // the room moved — let others react / fill freed slots
    }
  },

  async maybeSummarize(channelId = get().channel) {
    if (summarizing) return;
    const { provider, personas } = get();
    const log = logOf(get(), channelId);
    const done = get().summarized[channelId] ?? 0;
    if (!shouldSummarize(log.length, done)) return;

    summarizing = true;
    try {
      // Digest only the delta that has aged out since the last pass — never the
      // whole history (which would re-summarize old turns every time and grow the
      // prompt without bound). The cursor snapshot is taken NOW so messages that
      // arrive during the slow LLM loop below are left for the next pass.
      const upper = Math.max(0, log.length - KEEP_VERBATIM);
      const older = log.slice(done, upper);
      if (older.length === 0) return;
      const { names } = promptPeople(get());
      const transcript = formatTranscript(older, personas, undefined, names);
      // Only the channel's own crowd remembers what was said there (§12.4).
      // Sequential to be gentle on a single GPU (DESIGN §9 latency-stacking).
      for (const persona of membersOf(channelId, personas)) {
        const incoming = await summarizeForPersona(
          provider,
          persona,
          transcript,
          get().modelFor(persona),
          names.user ?? 'the user',
        );
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
      setCursor(channelId, upper);
    } finally {
      summarizing = false;
    }
  },

  forget(personaId, note) {
    // Summaries can be wrong (a small model may invent a detail), and a wrong memory
    // resurfaces in every channel. The profile card lets you correct them.
    const prev = get().memory[personaId];
    if (!prev) return;
    const updated: PersonaMemory = {
      ...prev,
      notes: note === undefined ? [] : prev.notes.filter((n) => n !== note),
    };
    set((s) => ({ memory: { ...s.memory, [personaId]: updated } }));
    void db.saveMemory(updated).catch(() => {});
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
    const userAliases = get().nick ? [get().nick] : [];
    for (const [rawKey, value] of Object.entries(deltas)) {
      const to = resolveTarget(rawKey, personas, userAliases);
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

  modelFor(persona) {
    const resolved = resolveModel(persona.model, get().availableModels);
    if (resolved !== persona.model) {
      const key = `${persona.id}:${persona.model}`;
      if (!modelNoticeShown.has(key)) {
        modelNoticeShown.add(key);
        get().postSystem(
          `* ${persona.name}'s model "${persona.model}" isn't installed — using "${resolved}" ` +
            `(run \`ollama pull ${persona.model}\` or edit the persona in ⚙) *`,
        );
      }
    }
    return resolved;
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
    if ('presenceMs' in patch) schedulePresence(); // a new pace takes effect now
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
    clampSummarizedCount(get);
    void db.deleteMessage(target.id).catch(() => {});
    void get().startGeneration(persona);
  },

  forkAt(id) {
    if (get().networked) return; // timeline edits are local-only (relay owns order)
    const { kept, removed } = truncateAfter(get().messages, id);
    if (removed.length === 0) return;
    set({ messages: kept });
    // A rewind can put the summarization cursor beyond the log's end, which
    // would stall note-taking for hundreds of messages — clamp it back.
    clampSummarizedCount(get);
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
          model: get().modelFor(persona),
          messages: buildABPrompt(persona, trimmed),
          options: { temperature: persona.params.temperature, top_p: persona.params.topP },
        })) {
          if (!chunk.token) continue;
          raw += chunk.token;
          setSlot(slot, { text: stripNamePrefix(visibleText(raw), persona.name) });
        }
      } catch (err) {
        const note = err instanceof Error ? err.message : String(err);
        if (!raw) raw = `(error — ${note})`;
      } finally {
        setSlot(slot, { text: stripNamePrefix(stripAffinity(raw).clean, persona.name), pending: false });
      }
    };

    await Promise.all([stream(pa, 'a'), stream(pb, 'b')]);
    set((s) => ({ ab: { ...s.ab, running: false } }));
  },

  postSystem(text, kind = 'notice') {
    const msg: Message = { id: uid(), channelId: get().channel, author: 'system', text, ts: nextTs() };
    if (kind === 'notice') msg.notice = true;
    set((s) => ({ messages: [...s.messages, msg] }));
    // Networked notices are local ephemera — persisting them would splice
    // fragments of a session-only conversation into the single-player log.
    if (!get().networked) void db.saveMessage(msg).catch(() => {});
  },

  postEvent(msg) {
    if (get().networked) {
      // Shared state: only the host publishes, and like every line it lands when
      // the relay echoes it back (the relay is the single source of order).
      if (get().isHost && transport) transport.send({ t: 'say', message: msg });
      return;
    }
    updateLog(msg.channelId, (log) => [...log, msg]);
    void db.saveMessage(msg).catch(() => {});
  },

  presenceTick() {
    if (get().networked && !get().isHost) return;
    const { personas, messages, generating, muted, channel } = get();
    if (isDm(channel)) return; // nobody comes or goes in a private chat
    // Presence is per channel: only this channel's crowd comes and goes here.
    const members = membersOf(channel, personas);
    const online = onlineSet(messages, members);
    // Mid-reply personas can't leave; kicked (muted) ones never return on their own.
    const blocked = new Set([...generating, ...muted]);
    const change = planPresenceChange(members, online, blocked, Math.random);
    if (!change) return;
    const persona = members.find((p) => p.id === change.who);
    if (!persona) return;
    if (change.state === 'leave') {
      get().postEvent(
        presenceMessage(channel, `* ${persona.name} has quit (${quitMessage(persona, Math.random)}) *`, change),
      );
    } else {
      get().postEvent(
        presenceMessage(channel, `* ${persona.name} has joined ${channelLabel(channel, personas)} *`, change),
      );
      get().greet(persona);
    }
  },

  maybePersonaDm(rng = Math.random) {
    const s = get();
    if (s.networked || s.config.dmGapMs <= 0) return null;
    if (Date.now() - lastPersonaDm < s.config.dmGapMs) return null;
    if (s.generating.length > 0) return null; // only while the room you're in is quiet
    const sender = pickDmSender(
      s.personas,
      (id) => s.affinityOf(id, 'user'),
      new Set(s.muted),
      s.channel,
      rng,
    );
    if (!sender) return null;
    lastPersonaDm = Date.now();
    const channelId = dmId(sender.id);
    if (!s.dms.includes(sender.id)) {
      const dms = [...s.dms, sender.id];
      set({ dms });
      void db.setKV(KV_DMS, dms).catch(() => {});
    }
    if (logOf(s, channelId).length === 0) {
      const intro: Message = {
        id: uid(),
        channelId,
        author: 'system',
        text: introText(channelId, s.personas),
        ts: nextTs(),
        notice: true,
      };
      updateLog(channelId, (log) => [...log, intro]);
      void db.saveMessage(intro).catch(() => {});
    }
    void get().startGeneration(sender, { channelId, directive: dmOpener(s.nick || 'the user') });
    return sender.id;
  },

  greet(persona) {
    const { generating, config } = get();
    if (generating.includes(persona.id) || generating.length >= config.maxConcurrent) {
      pendingGreetings.add(persona.id); // say hi as soon as a reply slot frees up
      return;
    }
    void get().startGeneration(persona, { directive: GREETING_DIRECTIVE });
  },

  runCommand(raw) {
    const parts = raw.slice(1).trim().split(/\s+/);
    const cmd = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1);
    const { personas, muted, channel } = get();
    const members = membersOf(channel, personas);
    const label = channelLabel(channel, personas);
    const find = (nick: string | undefined) =>
      nick
        ? personas.find(
            (p) => p.name.toLowerCase() === nick.toLowerCase() || p.id === nick.toLowerCase(),
          )
        : undefined;

    switch (cmd) {
      case 'who': {
        const online = onlineSet(get().messages, members);
        const here = members.filter((p) => online.has(p.id) && !muted.includes(p.id)).map((p) => p.name);
        const away = members.filter((p) => !online.has(p.id) || muted.includes(p.id)).map((p) => p.name);
        const humans = get().networked
          ? get().remoteParticipants
              .filter((p) => p.kind === 'human')
              .map((p) => (p.id === get().myId ? `${p.name} (you)` : p.name))
          : [get().nick ? `${get().nick} (you)` : 'you'];
        get().postSystem(
          `* in ${label}: ${[...humans, ...here].join(', ')}${away.length > 0 ? ` · away: ${away.join(', ')}` : ''} *`,
        );
        break;
      }
      case 'help':
        get().postSystem(
          '* commands: /join #chan /part /list /query <nick> /msg <nick> <text> /nick <name> /who /whois <nick> /forget <nick> /kick <nick> /invite <nick> /topic <text> /me <action> /export /regen /fork *',
        );
        break;
      case 'list': {
        const rows = channelDefs.map((c) => {
          const count = membersOf(c.id, personas).length;
          const topic = get().topics[c.id] || c.topic;
          return `#${c.id} (${count}) ${topic}${get().joined.includes(c.id) ? '' : ' — /join it'}`;
        });
        get().postSystem(`* channels: ${rows.join(' · ')} *`);
        break;
      }
      case 'join': {
        const def = findChannel(args[0], channelDefs);
        if (!def) {
          get().postSystem(`* no channel called "${args[0] ?? ''}" — try /list *`);
          break;
        }
        if (get().networked) {
          get().postSystem('* a shared room is one channel — disconnect to join others *');
          break;
        }
        const firstVisit = !get().joined.includes(def.id);
        if (firstVisit) {
          const joined = [...get().joined, def.id];
          set({ joined });
          void db.setKV(KV_JOINED, joined).catch(() => {});
        }
        get().switchChannel(def.id);
        // Walking in is a room event the crowd can react to — but only the first time;
        // after that you're just switching windows.
        if (firstVisit) get().postSystem(`* ${selfName(get()) || 'you'} joined #${def.id} *`, 'event');
        break;
      }
      case 'part': {
        if (channel === HOME) {
          get().postSystem(`* ${label} is home — it can't be parted *`);
          break;
        }
        if (!isDm(channel)) get().postSystem(`* ${selfName(get()) || 'you'} left ${label} *`, 'event');
        get().closeWindow(channel);
        break;
      }
      case 'query': {
        const target = find(args[0]);
        if (!target) {
          get().postSystem(`* no one here called "${args[0] ?? ''}" *`);
          break;
        }
        get().openDm(target.id);
        break;
      }
      case 'forget': {
        const target = find(args[0]);
        if (!target) {
          get().postSystem(`* no one here called "${args[0] ?? ''}" *`);
          break;
        }
        get().forget(target.id);
        get().postSystem(`* ${target.name}'s memories are cleared *`);
        break;
      }
      case 'whois': {
        // Opens the profile card — deliberately not a log line, so it never
        // leaks into prompts (DESIGN §12.3).
        const target = find(args[0]);
        if (!target) {
          get().postSystem(`* no one here called "${args[0] ?? ''}" *`);
          break;
        }
        get().openProfile(target.id);
        break;
      }
      case 'nick': {
        if (get().networked) {
          get().postSystem('* in a shared room your name is the one you connected with *');
          break;
        }
        if (!args[0]) {
          get().postSystem(get().nick ? `* you are ${get().nick} *` : '* no nick set — try /nick <name> *');
          break;
        }
        const result = validateNick(args[0], personas);
        if (!result.ok) {
          get().postSystem(`* can't use that nick: ${result.reason} *`);
          break;
        }
        const previous = get().nick;
        set({ nick: result.nick });
        void db.setKV(KV_NICK, result.nick).catch(() => {});
        get().postSystem(
          previous ? `* ${previous} is now known as ${result.nick} *` : `* you are now known as ${result.nick} *`,
          'event',
        );
        break;
      }
      case 'msg': {
        const target = find(args[0]);
        const body = args.slice(1).join(' ');
        if (!target) {
          get().postSystem(`* no one here called "${args[0] ?? ''}" *`);
          break;
        }
        // Private, as in IRC (DESIGN §12.4): open the DM and say it there — the
        // DM's tick has them answer. A shared room has no DMs (openDm says so).
        get().openDm(target.id);
        if (body && !get().networked) get().sendUserMessage(body);
        break;
      }
      case 'kick': {
        const target = find(args[0]);
        if (!target) {
          get().postSystem(`* no one here called "${args[0] ?? ''}" *`);
          break;
        }
        if (get().networked && !get().isHost) {
          get().postSystem('* only the host can kick personas *');
          break;
        }
        if (isDm(channel)) {
          get().postSystem('* nobody to kick in a private chat — /part closes it *');
          break;
        }
        if (!members.some((p) => p.id === target.id)) {
          get().postSystem(`* ${target.name} doesn't hang out in ${label} *`);
          break;
        }
        // Kicked = muted: they leave now and never return on their own (§12.2).
        if (!get().muted.includes(target.id)) {
          const next = [...get().muted, target.id];
          set({ muted: next });
          void db.setKV(KV_MUTED, next).catch(() => {});
        }
        if (onlineSet(get().messages, members).has(target.id)) {
          get().postEvent(
            presenceMessage(channel, `* ${target.name} was kicked by ${selfName(get()) || 'you'} *`, {
              who: target.id,
              state: 'leave',
            }),
          );
        } else {
          get().postSystem(`* ${target.name} is already gone — they'll stay away until you /invite them *`);
        }
        break;
      }
      case 'invite': {
        const target = find(args[0]);
        if (!target) {
          get().postSystem(`* no one here called "${args[0] ?? ''}" *`);
          break;
        }
        if (get().networked && !get().isHost) {
          get().postSystem('* only the host can invite personas *');
          break;
        }
        if (isDm(channel)) {
          get().postSystem(`* a private chat is just the two of you — /query ${target.name} to talk to them *`);
          break;
        }
        if (!members.some((p) => p.id === target.id)) {
          get().postSystem(`* ${target.name} doesn't hang out in ${label} *`);
          break;
        }
        const next = get().muted.filter((id) => id !== target.id);
        set({ muted: next });
        void db.setKV(KV_MUTED, next).catch(() => {});
        if (onlineSet(get().messages, members).has(target.id)) {
          get().postSystem(`* ${target.name} is already here *`);
          break;
        }
        get().postEvent(
          presenceMessage(channel, `* ${target.name} has joined ${label} *`, { who: target.id, state: 'join' }),
        );
        get().greet(target);
        break;
      }
      case 'topic': {
        if (isDm(channel)) {
          get().postSystem('* a private chat has no topic *');
          break;
        }
        const topic = args.join(' ');
        const topics = { ...get().topics, [channel]: topic };
        set({ topics });
        void db.setKV(KV_TOPICS, topics).catch(() => {});
        get().postSystem(topic ? `* topic set: ${topic} *` : '* topic cleared *', 'event');
        break;
      }
      case 'me': {
        const action = args.join(' ');
        if (action) get().postSystem(`* ${selfName(get()) || 'you'} ${action} *`, 'event');
        break;
      }
      case 'export': {
        // The window you're in, as a plain IRC-style .log (DESIGN §12.5).
        const s = get();
        const now = Date.now();
        const nameOf = (author: string) =>
          author === 'user' || s.myIds.includes(author)
            ? selfName(s) || 'you'
            : (s.participantNames[author] ?? author);
        const filename = logFilename(channel, now);
        const text = formatLog(s.messages, { label, personas, nameOf, now });
        get().postSystem(
          downloadText(filename, text) ? `* saved ${label} to ${filename} *` : "* couldn't save the log here *",
        );
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

function clearPresence(): void {
  if (presenceTimer) {
    clearTimeout(presenceTimer);
    presenceTimer = null;
  }
}

/** Arm the comings-and-goings timer (DESIGN §12.2). Only whoever drives the
 *  personas runs it; `first` shortens the opening delay so a visit gets an early
 *  arrival or departure instead of a static room. */
function schedulePresence(first = false): void {
  clearPresence();
  const { config, networked, isHost } = useRoom.getState();
  if (networked && !isHost) return;
  const mean = first ? Math.min(config.presenceMs, 30_000) : config.presenceMs;
  const delay = nextPresenceDelay(mean);
  if (delay === null) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    useRoom.getState().presenceTick();
    schedulePresence();
  }, delay);
}

function scheduleIdle(): void {
  clearIdle();
  const { config } = useRoom.getState();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    idleStreak += 1; // deepen the lull even if nobody ends up speaking
    // The room is quiet — the moment a persona who likes you might DM you (§12.4).
    useRoom.getState().maybePersonaDm();
    useRoom.getState().tick('idle');
  }, nextIdleDelay(idleStreak, config));
}
