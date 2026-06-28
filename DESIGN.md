# le-chat-cafe — Design

> An old-school chat room where every "person" but you is an LLM persona. Part
> friendship simulator, part multi-agent LLM playground, part IRC/AIM-era nostalgia
> trip — running entirely on your own machine, for free.

**Status:** Design draft · **Language:** TypeScript · **Stack target:** Browser SPA + local Ollama

Name: **le-chat-cafe** (a pun — *le chat* = "the cat" in French, plus "chat" the
noun). Alternates if you ever rename: **Babel**, **The Greenroom**, **Salon**,
**Café Babel**. The folder/repo already use `le-chat-cafe`, so we keep it.

> **Privacy/ethics note (load-bearing, up front):** Everything runs locally — no
> conversation leaves the machine, no account, no telemetry. Personas are explicitly
> *characters*; the UI must never imply sentience or that an LLM is a real person.
> No real-person impersonation in shipped personas.

---

## 1. Concept

You open the app and you're *in a room*. A nick list runs down the right side: you,
maybe a friend's name, and a handful of **LLM personas** — each with its own name,
color, voice, mood, and opinions. They talk to you. They talk to *each other*. They
react when someone joins, when a topic they care about comes up, when the room goes
quiet. You can lurk and watch the banter, jump in, or open the playground and tune
the whole thing like an instrument.

Three overlapping modes, one engine:

- **Chat room** — the default. A living room of personas you hang out in.
- **Friendship simulator** — personas track how they feel about you and each other;
  affinities warm, cool, and persist across sessions. A persona greets you
  differently on day 30 than on day 1.
- **Playground** — power surface: live-edit a persona's prompt, swap its model, tune
  temperature, fork the timeline, regenerate a line, A/B two personas on one prompt.

**The architectural bet:** the persona layer is fully decoupled from the chat
transport. The *Room* doesn't know its participants are LLMs — it just sees
"participants" that emit messages. That makes personas swappable, testable,
mockable, and (post-v1) lets a second human slot in as just another participant.

### Engineering pillars (the 1–3 things that make or break this)

1. **The Conductor** — the turn-taking brain. Decides *who speaks next* so the room
   feels alive but never spams. This is THE pillar; §4 specifies it exactly.
2. **Streaming concurrency on one local GPU** — orchestrating multiple streaming
   Ollama calls (with a hard concurrency cap and a queue) so replies feel snappy and
   the UI never blocks, on a single consumer machine.
3. **Persona differentiation + persistent affinity** — making personas demonstrably
   *distinct* and their relationships *persist*, which is the whole friendship-sim
   payoff. Backed by an eval harness so "all NPCs sound the same" is measurable.

---

## 2. Goals / Non-goals

**Goals (v1 — each is observable/testable)**
- **Believable multi-party conversation.** Personas take turns naturally: they don't
  all answer at once, don't talk over a dead room, and don't monologue.
- **Local-first and free.** Runs against a local **Ollama** server
  (`http://localhost:11434`). No paid API, no cloud, no account required.
- **Personas are data, not code.** Adding a persona = dropping in one `.json` file;
  no rebuild of the engine.
- **The retro feel is load-bearing.** Nick colors, `[HH:MM]` timestamps, join/leave
  lines, live token-streaming "typing", `/commands` — not skin-deep.
- **Relationships persist.** Affinity + per-persona memory survive a page reload and
  carry across sessions (IndexedDB).
- **Distinctness is measured.** An eval script samples each persona on fixed prompts
  so we can see they're actually differentiated, not interchangeable.

**Non-goals (v1)** — deliberately *not* doing these yet (the guardrails for the build):
- **Real multi-human networking.** v1 is single-human, local. The Room treats humans
  and personas as interchangeable participants, so a WebSocket relay is a clean
  post-v1 add (§8 extension) — but it is *not built in v1*. Do not add a server.
- **Cloud / paid LLM providers.** The runtime is behind an `LLMProvider` interface
  (§6.5) so a cloud provider (e.g. Claude) is a drop-in later, but **Ollama is the
  only implementation shipped in v1.** Don't wire up API keys.
- **Voice I/O (TTS/STT).** Text only. Clean later add via Piper/Whisper.cpp.
- **Mobile-first layout.** Desktop three-pane chat-client layout first.
- **Auth, multi-user accounts, sync.** Single local user; data lives in the browser.
- **Persona "consciousness" claims.** They're characters; the UI says so.
- **RAG / external tool use by personas.** Personas converse; they don't browse or
  call tools in v1.

---

## 3. Tech stack

*Versions verified 2026-06-27 against npm / official release pages; pin in
`package.json` at scaffold time and re-check tags then.*

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript 5.x** (strict) | Primary language; the app is browser UI + heavy async orchestration, which TS types make tractable. |
| Build/dev | **Vite 8.1** | Fastest React dev loop; instant HMR matters for iterating on the chat surface. |
| UI | **React 19.2** | Component-heavy surface (message list, nick list, persona editor); React 19's `use`/Actions simplify streaming state. |
| State | **Zustand 5.0** | Room state, turn queue, and per-message streaming tokens need predictable, observable, low-ceremony state. Lighter than Redux; no provider boilerplate. *(Decided — not Redux.)* |
| LLM runtime | **Ollama** (local HTTP, `ollama` JS lib, browser entry) | Free, offline, streaming via async-iterator. The free inference backbone; same dependency as the builder's Tavern / Neon Gambit. |
| Persistence | **IndexedDB via `idb`** | All client-side: message history, personas, relationships, long-term notes. `idb` gives a clean promise API over IndexedDB. |
| Styling | **Vanilla CSS + CSS custom properties**, scoped with **CSS Modules** | The retro look wants hand-written CSS, and the CRT↔AIM theme toggle is literally swapping CSS-variable palettes — no utility framework fighting us. |
| Testing | **Vitest** + **@testing-library/react** | First-class with Vite; the Conductor's scoring logic needs fast unit tests with a mocked provider. |
| Lint/format | **ESLint + Prettier** | Standard hygiene. |

**No backend in v1.** The browser talks straight to Ollama. One real setup gotcha
(documented in §9): browser→Ollama requires Ollama to allow the dev origin via the
`OLLAMA_ORIGINS` env var, else CORS blocks the fetch.

---

## 4. The Conductor — get this exactly right

This is the domain-critical core. A naive loop ("every persona replies to every
message") produces a wall of noise and burns the GPU. The Conductor instead **gates
who speaks on signals**, scores candidates, and enforces cooldowns + a concurrency
cap. Get this right and the room feels alive; get it wrong and nothing else matters.

### 4.1 When it runs (ticks)

The Conductor evaluates on two triggers only:
1. **On a new message** appended to the channel (from user or persona).
2. **On the idle timer** — `IDLE_MS` (default **12000**) after the *last* message,
   if the room is quiet and not already generating.

It never runs on a raw interval/clock tick — that's what produces spam.

### 4.2 Candidate generation

On a tick, for every persona in the channel **not currently on cooldown** and **not
currently generating**, compute zero or more candidates. A persona may match more
than one reason; keep only its highest-scoring candidate.

```ts
type Reason = 'mention' | 'question' | 'event' | 'idle';

interface TurnCandidate {
  personaId: string;
  reason: Reason;
  score: number;       // final, post-scoring (see 4.3)
}

// Base priority by reason — the dominant term in the score.
const BASE: Record<Reason, number> = {
  mention:  100,   // their nick (or an alias) appears in the latest message
  question:  60,   // latest message ends in '?' AND topic-matches their interests
  event:     40,   // a join/leave, an affinity threshold crossed, or a loved topic surfaced
  idle:      20,   // room has been quiet past IDLE_MS
};
```

- **mention**: case-insensitive match of `persona.name` (or a configured alias) as a
  whole word in the latest message text.
- **question**: latest message is interrogative (`?` or leading wh-word) *and* at
  least one of `persona.interests` keyword-matches the message.
- **event**: emitted by the Room/affinity systems (someone joined, affinity crossed
  ±0.5 toward this persona, a `persona.interests` topic appeared in last N messages).
- **idle**: only generated on the idle trigger, for every eligible persona.

### 4.3 Scoring

```ts
function scoreCandidate(p: Persona, reason: Reason, rng: () => number): number {
  const base       = BASE[reason];
  const chattiness = p.temperament.talkativeness * 15;  // 0..15
  const jitter     = rng() * 10;                          // 0..10, organic ordering
  return base + chattiness + jitter;
}
```

Mentions always beat questions beat events beat idle, but talkativeness + jitter
break ties *within* a tier so order feels organic, not deterministic.

### 4.4 Selection, concurrency, cooldowns

```ts
const MAX_CONCURRENT = 2;   // at most 2 personas generating at once (1 GPU)
const MIN_SCORE      = 25;  // below this, nobody speaks (lets a dead room stay dead)

// cooldown in *turns* (messages) before a persona who just spoke is eligible again:
//   talkative (1.0) -> 2 turns ; reserved (0.0) -> 6 turns
function cooldownTurns(p: Persona): number {
  return Math.round(2 + (1 - p.temperament.talkativeness) * 4);
}
```

Each tick:
1. Generate + score candidates (4.2–4.3).
2. Drop any below `MIN_SCORE`.
3. Sort by score, descending.
4. Pop the top candidate(s) up to `MAX_CONCURRENT − (currently generating)` slots.
   - **Idle ticks pick exactly one** (a quiet room gets a single line, never a pile-on).
5. Mark each chosen persona as generating, start its run (§6.4), and reset its
   cooldown counter.

**Anti-monologue (global):** if a single persona authored ≥ `MONOLOGUE_CAP` (default
**3**) of the last 5 messages, it is excluded from candidacy this tick regardless of
score. Prevents two chatty personas from locking out the room.

### 4.5 Tunable constants (one place)

```ts
interface ConductorConfig {
  idleMs: number;          // 12000
  maxConcurrent: number;   // 2
  minScore: number;        // 25
  monologueCap: number;    // 3 of last 5
  chattinessWeight: number;// 15
  jitterMax: number;       // 10
}
```

All live in one config object so the playground can tune room "energy" live, and so
tests can pin `rng` and assert deterministic selection.

---

## 5. Architecture

**Pattern: layered, with a transport-agnostic core.** The Room is a dumb,
append-only message/presence transport. The Conductor is the social-dynamics brain.
The Persona Runtime is the *only* layer that knows LLMs exist, and it talks to models
through an `LLMProvider` port (ports-and-adapters at the edge). UI is a thin view
over Zustand stores fed by the Room's event bus.

```
┌──────────────────────────────────────────────────────────────┐
│                          UI (React)                          │
│   MessageList · NickList · Composer · PersonaEditor · Cmds   │
└───────────────▲───────────────────────────────┬─────────────┘
                │ store updates / events          │ user actions
┌───────────────┴───────────────────────────────▼─────────────┐
│                     State (Zustand stores)                   │
│      room store · personas store · relationships store       │
└───────────────▲───────────────────────────────┬─────────────┘
                │ messages / presence            │ commands
┌───────────────┴───────────────────────────────▼─────────────┐
│                         Room (core)                          │
│  participant registry · append-only log · presence · bus     │
└───────────────▲───────────────────────────────┬─────────────┘
                │ "who speaks next?"             │ "X said Y"
┌───────────────┴───────────────────────────────▼─────────────┐
│                       Conductor (§4)                         │
│   candidate gen · scoring · cooldowns · concurrency cap      │
└───────────────▲───────────────────────────────┬─────────────┘
                │ "persona P, go"                │ token stream + affinity
┌───────────────┴───────────────────────────────▼─────────────┐
│                    Persona Runtime                           │
│  build prompt (system + notes + window) → LLMProvider →      │
│  stream tokens → strip affinity sentinel → update memory     │
└───────────────────────────┬──────────────────────────────────┘
                            │ chat() (streaming) / generate()
┌───────────────────────────▼──────────────────────────────────┐
│              LLMProvider (port)  →  OllamaProvider (v1)       │
└──────────────────────────────────────────────────────────────┘
```

**Persistence** (`idb`) sits beside the stores: Room log, personas, and relationships
are hydrated from IndexedDB on boot and written through on change.

---

## 6. Core systems

### 6.1 Persona

A persona is a flat spec — adding one is adding a `personas/*.json` file.

```ts
interface Persona {
  id: string;
  name: string;                 // nick shown in the room
  aliases?: string[];           // extra mention triggers ("Cai" for "Caius")
  color: string;                // nick color (hex), retro IRC vibe
  avatar?: string;              // emoji or pixel-art data URI (optional)
  systemPrompt: string;         // the character
  model: string;                // ollama tag, e.g. "qwen3:8b"
  params: { temperature: number; topP: number };
  temperament: {
    talkativeness: number;      // 0..1 → idle weighting + cooldown length
    warmth: number;             // baseline friendliness (affinity start toward user)
    pettiness: number;          // how hard affinity swings on slights
  };
  interests: string[];          // topic-match keywords for the Conductor
}
```

**Tiered models** (sane latency/VRAM on one GPU): a fast small model for ambient
personas, a larger one for the "host"/closest persona. Verify exact tags at
[ollama.com/library](https://ollama.com/library) when scaffolding — as of 2026-06-27
good defaults are ambient = **`llama3.2:3b`** or **`gemma3:4b`**, host = **`qwen3:8b`**
or **`llama3.1:8b`**.

### 6.2 Room (transport core)

Knows nothing about LLMs. Append-only log + participant registry + presence + a tiny
event bus the Conductor and stores subscribe to.

```ts
interface Message {
  id: string;
  channelId: string;
  author: string;               // personaId | "user"
  text: string;
  ts: number;
  replyTo?: string;             // for forks / threading
  pending?: boolean;            // true while tokens are still streaming in
}

interface Channel {
  id: string;
  name: string;
  participants: string[];       // personaIds + "user"
  topic?: string;
}

type RoomEvent =
  | { type: 'message'; message: Message }
  | { type: 'join' | 'leave'; participant: string }
  | { type: 'topic'; topic: string };
```

### 6.3 Memory (two tiers)

To stay inside a local model's context window:

- **Working memory** — the last `N` messages (default 20), verbatim, in the prompt.
- **Long-term notes** — when history past the window exceeds a threshold (default
  every 30 messages), a cheap summarization pass distills older turns into per-persona
  bullet notes ("user is a dad to Atlas; dislikes spoilers"), re-injected into that
  persona's system prompt. Smart-lossy social memory.

```ts
interface PersonaMemory {
  personaId: string;
  notes: string[];              // distilled long-term bullets
  lastSummarizedTs: number;
}
```

### 6.4 Persona Runtime

The only LLM-aware layer. On "persona P, go":

1. Build the prompt: `systemPrompt` + long-term `notes` + working-memory window +
   light room context (who's present, topic).
2. Call `provider.chat({ ..., stream: true })`, append a `pending` message, and write
   tokens into it as they arrive (this drives the live "typing" feel).
3. On completion, **strip the affinity sentinel** (§6.6) from the text, apply the
   deltas, and finalize the message (`pending: false`).

> **Critical constraint (verified 2026-06-27):** Ollama's structured-output `format`
> (JSON schema) does **not** combine with streaming — `format` implies a single
> non-streamed JSON response. The visible reply MUST stream, so affinity cannot ride
> on a structured-output call for the same turn. Hence the sentinel approach below.

### 6.5 LLMProvider (the port)

```ts
interface ChatTurn { role: 'system' | 'user' | 'assistant'; content: string }

interface LLMProvider {
  // streaming reply for the visible chat turn
  chat(req: {
    model: string;
    messages: ChatTurn[];
    options?: { temperature?: number; top_p?: number };
  }): AsyncIterable<{ token: string; done: boolean }>;

  // one-shot, non-streamed — used for summarization & the optional sentiment fallback
  generate(req: {
    model: string;
    prompt: string;
    format?: object;            // JSON schema (structured output) when needed
  }): Promise<string>;
}
```

`OllamaProvider` is the only v1 implementation (wraps the `ollama` browser lib). A
`MockProvider` (scripted replies) backs the Conductor/runtime unit tests. Any cloud
provider is a post-v1 adapter behind this same port.

### 6.6 Relationships & affinity (the friendship sim)

Each persona holds an **affinity** in `[-1, 1]` toward the user and toward every other
persona. High affinity → eager greetings, inside jokes, defends you; low → terse,
sarcastic, may leave. Affinity is injected as a phrase into the persona's prompt
("you currently feel warmly toward user").

**Update mechanism — sentinel emission (primary, free, streaming-safe).** The persona
is instructed to optionally end its reply with a one-line machine block the runtime
strips before display:

```
§aff {"user": 0.05, "caius": -0.02}§
```

Regex strip (anchored to end of message): `/\n?§aff\s*(\{.*?\})\s*§\s*$/s`. Parse the
JSON, clamp each delta to **±0.15/turn**, apply, persist. No extra model call, keeps
streaming. **Fallback** (only if sentinels prove noisy): a `generate()` call with a
structured-output `format` schema rating the exchange — reliable but costs a call.

```ts
interface Relationship {
  from: string;                 // personaId
  to: string;                   // personaId | "user"
  affinity: number;             // -1..1
  notes: string[];              // "remembered user likes synth music"
}
```

**Stability:** clamp per-turn delta (±0.15), and **decay toward 0** by a small factor
(e.g. ×0.98) on each session load, so relationships don't spiral to permanent
love/hate. Persisted to IndexedDB → relationships carry across sessions.

### 6.7 Playground controls

Side panel + `/commands`:
- Live-edit a persona's `systemPrompt`; takes effect next turn.
- Swap a persona's `model` on the fly.
- Tune `temperature` / `topP` per persona, and the `ConductorConfig` (room energy).
- **Fork** the timeline at any message (branch via `replyTo`).
- **Regenerate** the last persona line.
- **A/B**: run one prompt through two personas/models side by side.

### 6.8 Eval harness (distinctness)

A small Vitest/script harness samples each persona on a fixed prompt set and reports,
so "all NPCs sound the same" becomes measurable: response length distribution,
vocabulary overlap between personas, and a quick self-rated "in-character" check.
Runs against `MockProvider` in CI and Ollama locally.

---

## 7. UX / aesthetic

Lean into the late-90s/early-2000s chat client — the interaction grammar is borrowed
wholesale from IRC/AIM.

- **Three-pane layout:** channel tabs (left), message log (center), nick list (right).
- **The feel-good loop:** you type → personas *stream* replies token-by-token, with
  `Caius is typing…` indicators driven by stream-start → the room banters among
  itself → you jump back in. Streaming (not spinner-then-blob) is what sells "someone
  is typing to you."
- Colored nicks, `[HH:MM]` timestamps, `* Persona has joined` / `has left` lines.
- **`/commands`:** `/who`, `/msg <nick>`, `/kick <nick>` (mute a persona), `/invite
  <persona>`, `/topic <text>`, `/me <action>`, `/regen`, `/fork`.
- **Theme toggle (pure CSS variables):** **CRT/terminal** (scanlines, monospace, green
  phosphor) ↔ **AIM** (rounded, pastel). Themes are just swapped custom-property sets.

---

## 8. Milestones

Independently-runnable, built top-down. Each opens in the browser and proves
something. Scaffold turns this list into `ROADMAP.md` (adding explicit Test steps).

- **M0 — Echo room (walking skeleton).** React+Vite shell, three-pane layout, one
  hardcoded persona behind the `LLMProvider` port. Type a message → get a *streamed*
  reply in the log. No Conductor. **Proves:** the Ollama pipe + streaming render +
  the provider seam. *(MockProvider path runs with no Ollama installed.)*

- **M1 — Multi-persona + Conductor.** 3–4 personas loaded from `personas/*.json`.
  Full §4 Conductor: mention/question/event/idle candidates, scoring, cooldowns,
  `MAX_CONCURRENT`, anti-monologue. **Proves:** personas talk to you *and each other*
  without spamming; selection is unit-tested with a pinned rng + MockProvider.

- **M2 — Persistence + memory.** IndexedDB (`idb`) for the message log, personas, and
  channel; working-memory window + long-term-notes summarization. **Proves:** reload
  the page and the room/history survive; long chats stay in-context.

- **M3 — Friendship sim.** Affinity via sentinel emission, `Relationship` state,
  prompt injection of current feelings, clamp + decay, persisted. **Proves:** a
  persona's tone visibly shifts with affinity and *remembers* you across sessions.

- **M4 — Playground.** Live persona/prompt/model editing, per-persona + Conductor
  tuning, fork, regenerate, A/B. **Proves:** the room is tunable like an instrument.

- **M5 — Polish + evals.** CRT/AIM themes, full `/commands`, typing indicators, nick
  coloring, and the §6.8 eval harness. **Proves:** it *feels* like a chat client and
  personas are measurably distinct.

**Documented post-v1 extension — real multiplayer.** Add a thin Node + WebSocket
relay. Because the Room already treats humans and personas as interchangeable
participants, a second human is just another participant id; the Conductor is
unaffected. Not built in v1.

---

## 9. Risks / open questions

- **Browser → Ollama CORS.** Browser fetch to `localhost:11434` is blocked unless
  Ollama allows the origin. → Document setting `OLLAMA_ORIGINS` (e.g. to the Vite dev
  origin / `*` for local dev) in README; surface a friendly "can't reach Ollama —
  set OLLAMA_ORIGINS" error in-app.
- **Latency stacking.** Several personas reacting in sequence can queue up. →
  `MAX_CONCURRENT=2`, small models for ambient personas, and streaming so the *first*
  token appears fast. Show typing indicators so waiting feels intentional.
- **Affinity drift.** Self-reported deltas may spiral. → ±0.15/turn clamp + decay
  toward 0 on session load (§6.6). Watch in M3; switch to the structured `generate()`
  fallback if sentinels prove noisy.
- **Sentinel leakage.** If the strip regex misses, `§aff …§` shows in chat. → anchor
  the regex to end-of-message, unit-test it on malformed cases, and hard-strip any
  stray `§aff` defensively before render.
- **Small-model repetition.** Local models loop. → anti-repetition guidance in the
  system prompt, rotate speakers via the Conductor, modest `top_p`/temperature.
- **"All NPCs sound the same."** → distinct temperament + prompts + tiered models, and
  the §6.8 eval harness to *measure* it rather than hope.
- **Open question — model tags.** Exact best small models shift monthly; verify at
  ollama.com/library at scaffold time (defaults noted in §6.1).

---

## 10. References

- **IRC / AIM** — the interaction grammar (persistent rooms, nick lists, slash
  commands, join/leave notices) is borrowed wholesale.
- **Ollama** — open-source local LLM server; the free, offline inference backbone.
  [Library](https://ollama.com/library) ·
  [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs) ·
  [Streaming](https://docs.ollama.com/capabilities/streaming) ·
  [`ollama-js`](https://github.com/ollama/ollama-js). *(All verified 2026-06-27;
  structured-output + streaming are mutually exclusive — see §6.4.)*
- **Stack** — [React 19.2](https://react.dev/versions),
  [Vite 8.1](https://vite.dev/releases), [Zustand 5.0](https://www.npmjs.com/package/zustand),
  [`idb`](https://www.npmjs.com/package/idb). *(Versions verified 2026-06-27.)*
- **Tavern (builder's project)** — the Conductor's mention/idle/event gating and
  tiered-model throughput model are lifted directly. Reuse the prompt-throttling code.
- **Neon Gambit (builder's project)** — the "persona layer decoupled from the engine"
  separation is the same pattern; the `LLMProvider` port mirrors it.
- **Omnia (builder's project)** — the two-tier "smart lossy" memory compression
  instinct, applied here to social memory (§6.3).
- **Character.AI** — closest commercial cousin, but one-on-one and cloud;
  le-chat-cafe's differentiators are the *multi-persona room* and *local-first* stack.
