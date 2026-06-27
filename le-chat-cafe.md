# le-chat-cafe — Software Design Document

> An old-school chat room, but every other "person" in it is an LLM. Part friendship
> simulator, part multi-agent LLM playground, part nostalgia trip for IRC/AIM-era chat.

**Status:** Design draft · **Language:** TypeScript · **Stack target:** browser + local Ollama

Name is a placeholder (it reads as a pun: *le chat* = "the cat" in French, plus
"chat" the noun). Alternates if you want to rename: **Babel** (many voices in one
room), **The Greenroom**, **Salon**, **Café Babel**.

---

## 1. Concept

You walk into a chat room. There's a nick list down the side. Some nicks are humans
(you, friends), most are LLM-driven **personas** — each with its own name, color,
personality, and voice. They talk to you, they talk to *each other*, they react to
events, they have opinions and moods. You can sit back and watch the room banter, jump
in, or tune the whole thing like an instrument.

Three overlapping modes, all the same engine:

- **Chat room** — the default. A living room of personas you hang out in.
- **Friendship simulator** — personas track how they feel about you and each other;
  relationships warm, cool, and develop over sessions.
- **Playground** — power-user surface: live-edit a persona's prompt, swap the model
  behind it, tune temperature, fork the conversation, regenerate a line, A/B two
  personas on the same prompt.

The unifying technical bet: **the persona layer is fully decoupled from the chat
transport** (same separation you used in Neon Gambit between the LLM persona layer and
the game engine). The room doesn't know personas are LLMs; it just knows "participants"
that emit messages. That makes personas swappable, testable, and reusable.

---

## 2. Goals / Non-goals

**Goals**
- Believable multi-party conversation: personas take turns naturally, don't all talk
  at once, don't talk over a dead room.
- Local-first and free: runs against a local **Ollama** server (Ollama = an
  open-source runtime that serves quantized LLMs like Llama, Qwen, Mistral on your own
  machine via a simple HTTP API). No paid API required.
- Personas are data, not code. Adding a persona = adding one JSON/Markdown file.
- The retro feel is load-bearing, not skin-deep: nick colors, `/commands`, join/leave
  lines, timestamps, typing indicators.

**Non-goals (v1)**
- Real multi-human networking. v1 is single-human, local. (Architected so a relay
  server *can* be bolted on — see §8 — but not built yet.)
- Voice I/O. Text only for v1. (TTS/STT is a clean later add via Piper/Whisper.cpp,
  same tools as Tavern.)
- Mobile-first layout. Desktop chat-client layout first.
- Persona "consciousness" claims. These are characters, and the UI should never
  pretend otherwise.

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** | Your primary; the whole thing is browser UI + async orchestration, which TS handles cleanly. |
| UI | **React + Vite** | Fast dev loop; the chat surface is component-heavy (message list, nick list, persona editor). |
| State | **Zustand** (or Redux Toolkit) | Room state, turn queue, and streaming tokens need predictable, observable state. Zustand is lighter. |
| LLM runtime | **Ollama** (local HTTP) | Free, offline, streaming. Same dependency as Tavern/Neon Gambit. |
| Persistence | **IndexedDB** (via `idb`) | Conversation history, persona affinity, long-term notes — all client-side. |
| Styling | **CSS Modules** or vanilla CSS | The retro look wants hand-written CSS, not a utility framework fighting you. |

No backend required for v1 — the browser talks straight to `http://localhost:11434`
(Ollama's default). Optional thin Node relay only enters in the multi-human extension.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                          UI (React)                          │
│   MessageList · NickList · Composer · PersonaEditor · Cmds   │
└───────────────▲───────────────────────────────┬─────────────┘
                │ messages / presence            │ user actions
┌───────────────┴───────────────────────────────▼─────────────┐
│                         Room (core)                          │
│  - participant registry      - message log (append-only)     │
│  - presence (join/leave)     - event bus                     │
└───────────────▲───────────────────────────────┬─────────────┘
                │ "who speaks next?"             │ "X said Y"
┌───────────────┴───────────────────────────────▼─────────────┐
│                       Conductor                              │
│  decides turn order: mention-detection · idle timers ·       │
│  event triggers · priority queue · cooldowns/anti-spam       │
└───────────────▲───────────────────────────────┬─────────────┘
                │ "persona P, your turn"         │ token stream
┌───────────────┴───────────────────────────────▼─────────────┐
│                    Persona Runtime                           │
│  builds prompt (system + memory + recent log) → Ollama →     │
│  streams reply → emits affinity deltas → updates memory      │
└──────────────────────────────────────────────────────────────┘
```

The **Room** is dumb and transport-like. The **Conductor** is the brain of the social
dynamics. The **Persona Runtime** is the only part that knows about LLMs at all.

---

## 5. Core systems

### 5.1 The Conductor (turn-taking)

This is the make-or-break system. A naive loop ("every persona replies to every
message") produces a wall of noise and burns tokens. Reuse the throughput model you
built for Tavern: **gate who speaks on signals, not on every tick.**

A persona becomes a *candidate to speak* when any of:

- **Direct mention** — their nick appears in the latest message (highest priority).
- **Addressed-implicitly** — the message is a question and they're the most relevant
  persona (cheap heuristic: keyword/topic match against their interests).
- **Reaction trigger** — an event fires (someone joined, a topic they care about came
  up, an affinity threshold crossed).
- **Idle timer** — the room's been quiet for `t` seconds; pick a persona weighted by
  talkativeness to break the silence.

Candidates go into a **priority queue**. The Conductor pops one (or a small number,
with a cap of ~2 concurrent), runs it, and enforces **cooldowns** so the same persona
can't monologue. Talkative personas get shorter cooldowns; reserved ones longer. This
gives you a room that *feels* alive but doesn't spam.

```ts
interface TurnCandidate {
  personaId: string;
  reason: 'mention' | 'topic' | 'event' | 'idle';
  priority: number;     // mention > event > topic > idle
  jitter: number;       // small randomization so order feels organic
}
```

### 5.2 Persona system

A persona is a flat spec — adding one is adding a file:

```ts
interface Persona {
  id: string;
  name: string;              // nick shown in the room
  color: string;             // their nick color (retro IRC vibe)
  avatar?: string;           // optional pixel-art / emoji
  systemPrompt: string;      // the character
  model: string;             // ollama model tag, e.g. "qwen2.5:7b"
  params: { temperature: number; topP: number };
  temperament: {
    talkativeness: number;   // 0..1 → idle-timer weighting + cooldown length
    warmth: number;          // baseline friendliness
    pettiness: number;       // how much affinity swings on slights
  };
  interests: string[];       // topic-match keywords for the Conductor
}
```

Tiered models, same idea as Tavern: a fast small model (3–4B) for background/ambient
personas, a larger one (7–8B) for the persona you're closest to or the "host." Keeps
latency and memory sane on a single GPU.

### 5.3 Relationships & affinity (the friendship sim)

Each persona holds an **affinity** value toward the user and toward every other
persona, in `[-1, 1]`. Affinity shifts conversational behavior: high warmth → eager
greetings, inside jokes, defends you; low → terse, sarcastic, may leave.

Two ways to update affinity, pick per your taste for cost vs. control:

1. **Structured emission** (preferred) — instruct the persona to optionally end its
   reply with a hidden tagged delta, e.g. `<<affinity user:+0.05>>`, which the runtime
   strips before display and applies. The model decides how it feels. Cheap, no extra
   call, surprisingly expressive.
2. **Sentiment pass** — a tiny separate classifier call rates the exchange. More
   reliable, costs a call. Use only if (1) proves too noisy.

```ts
interface Relationship {
  from: string;              // personaId
  to: string;                // personaId | "user"
  affinity: number;          // -1..1
  notes: string[];           // "remembered that user likes synth music"
}
```

Persisted to IndexedDB, so relationships **carry across sessions** — the core of the
friendship-sim feel. A persona greets you differently on day 30 than day 1.

### 5.4 Memory

Two tiers, to stay inside a local model's context window:

- **Working memory** — the last N messages, verbatim.
- **Long-term notes** — periodically, a cheap summarization pass distills older
  history into per-persona bullet notes ("user is a dad to Atlas; dislikes spoilers").
  Re-injected into the system prompt. This is the same "smart lossy" compression
  instinct from Omnia, applied to social memory.

### 5.5 Playground controls

Surfaced as a side panel / `/commands`:

- Live-edit a persona's system prompt and watch behavior change next turn.
- Swap the model behind a persona on the fly.
- Tune `temperature` / `topP` per persona.
- **Fork** the conversation at any message (branch the timeline).
- **Regenerate** the last persona line.
- **A/B**: run the same prompt through two personas/models side by side.

---

## 6. UX / aesthetic

Lean into the late-90s/early-2000s chat client:

- Three-pane layout: room tabs (left), message log (center), nick list (right).
- Colored nicks, `[HH:MM]` timestamps, `* Persona has joined` / `has left` lines.
- Typing indicators (`Caius is typing…`) driven by token-stream start.
- `/commands`: `/who`, `/msg <nick>`, `/kick` (mute a persona), `/invite <persona>`,
  `/topic`, `/me`.
- An optional **CRT/terminal theme** toggle (scanlines, monospace) vs. an **AIM
  theme** (rounded, pastel). Themes are pure CSS.
- Streaming: tokens appear live, character by character, which sells the "someone is
  typing to you" illusion far better than a spinner-then-blob.

---

## 7. Key data models (summary)

`Persona`, `Relationship`, `TurnCandidate` above, plus:

```ts
interface Message {
  id: string;
  author: string;            // personaId | "user"
  text: string;
  ts: number;
  channelId: string;
  replyTo?: string;          // for forks / threading
}

interface Channel {
  id: string;
  name: string;
  participants: string[];    // personaIds + "user"
  topic?: string;
}
```

---

## 8. Milestones

- **M0 — Echo room.** React shell, one hardcoded persona, send a message, get a
  streamed Ollama reply in the log. No Conductor. Proves the Ollama pipe.
- **M1 — Multi-persona + Conductor.** 3–4 personas from JSON, mention-detection +
  idle timer + cooldowns. Personas talk to you and each other without spamming.
- **M2 — Persistence + memory.** IndexedDB history, working memory window, long-term
  notes summarization.
- **M3 — Friendship sim.** Affinity emission + relationship state that visibly shifts
  persona behavior and persists across sessions.
- **M4 — Playground.** Live persona editing, model swap, fork/regenerate, A/B.
- **M5 — Polish.** Themes (CRT/AIM), `/commands`, typing indicators, nick coloring.

**Documented extension (post-v1): real multiplayer.** Add a thin Node + WebSocket
relay. Because the Room already treats humans and personas as interchangeable
participants, a second human is just another participant id — minimal core changes.
The Conductor logic is unaffected.

---

## 9. Risks / open questions

- **Latency stacking.** With several personas reacting in sequence, replies can queue
  up. Mitigate with concurrency cap (~2), small models for ambient personas, and
  streaming so the *first* reply starts fast.
- **Affinity drift.** Self-reported affinity deltas may spiral (everyone ends up
  loving or hating you). Clamp per-turn delta magnitude and add slow decay toward a
  neutral baseline.
- **Repetition.** Small local models loop. Mitigate with anti-repetition in the prompt,
  rotating which personas speak, and `frequency_penalty`-style instructions.
- **The "all NPCs sound the same" problem.** Distinct temperament + distinct system
  prompts + distinct models help; worth an eval harness that samples each persona on
  fixed prompts to check they're actually differentiated.

---

## 10. References

- **IRC / AIM** — the chat clients this apes: persistent rooms, nick lists, slash
  commands, join/leave notices. The interaction grammar is borrowed wholesale.
- **Ollama** — open-source local LLM server; the free, offline inference backbone.
- **Tavern (your project)** — the Conductor's mention/idle/event gating and tiered-model
  approach are lifted directly from Tavern's throughput model.
- **Neon Gambit (your project)** — the "persona layer decoupled from the engine"
  architecture is the same separation, reused.
- **Character.AI / chat-persona apps** — the closest commercial cousins, but those are
  one-on-one and cloud; le-chat-cafe's differentiator is the *multi-persona room* and
  *local-first* stack.
