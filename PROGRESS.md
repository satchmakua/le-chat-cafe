# PROGRESS — le-chat-cafe

A build log of what shipped and the notable decisions behind it. **Keep it honest** —
this is the working memory between build sessions. The forward-looking plan and
acceptance tests live in [ROADMAP.md](ROADMAP.md); this is the backward-looking "what
got done and why" companion.

**Current phase:** v1 complete (M0–M5); **M6.0 (multiplayer relay skeleton) built**,
awaiting the human's two-tab test. Next: **M6.1 — host-authoritative personas**.

### State of the tree

| Area | Files | Status |
|---|---|---|
| LLM port | `src/llm/provider.ts` | ✅ interface defined (chat-stream + generate) |
| Providers | `src/llm/mock.ts`, `src/llm/ollama.ts` | ✅ Ollama default (probed at startup) + Mock fallback |
| Data models | `src/core/types.ts` | ✅ full spec types in use |
| Conductor | `src/core/conductor.ts` | ✅ pure scoring/selection (DESIGN §4); 15 unit tests |
| Persona runtime | `src/runtime/personaRuntime.ts` | ✅ prompt builder: transcript + memory + feelings + sentinel |
| Memory | `src/runtime/memory.ts` | ✅ working window + long-term-notes summarization |
| Affinity | `src/runtime/affinity.ts` | ✅ §aff sentinel strip, clamp/apply/decay, phrasing |
| Playground | `src/runtime/playground.ts` | ✅ persona merge, fork, regen target, A/B prompt (pure) |
| Eval | `src/eval/metrics.ts`, `eval/run.ts` | ✅ distinctness metrics + `npm run eval` harness |
| Net / transport | `src/net/protocol.ts`, `src/net/transport.ts` | ✅ wire types + `LocalTransport`/`WSTransport` |
| Relay | `server/relay.ts` | ✅ thin `ws` relay (`npm run relay`); 2-client integration test |
| Persistence | `src/persist/db.ts` | ✅ IndexedDB v2 (messages, memory, relationships, kv) via `idb` |
| Personas | `src/personas/*.json` | ✅ 4 personas, glob-loaded (data-driven) |
| Room state | `src/state/store.ts` | ✅ ticks, streaming, persist, affinity, playground, /commands, connect |
| UI | `src/App.tsx`, `src/ui/*` | ✅ shell, themes, hearts, typing, Playground (+ multiplayer), system lines |
| Tests | `tests/*.test.{ts,tsx}` | ✅ 57 passing (+ relay integration, protocol) |

---

## M6.0 — Multiplayer relay skeleton · built 2026-06-28 (awaiting test)

**What shipped (post-v1, greenlit):** a second human can join the room. A thin Node +
`ws` relay (`server/relay.ts`, `npm run relay`) routes messages and tracks presence per
room — it never touches Ollama, so local-first holds. A `Transport` port
(`src/net/transport.ts`) mirrors `LLMProvider`: `LocalTransport` (single-player no-op)
and `WSTransport` (browser-native WebSocket). The store gained opt-in `connect`/
`disconnect`; while networked it sends human turns through the relay (which is the single
source of order — it stamps a `seq` and broadcasts to all, who append on receipt) and
gates local persona ticks. A Multiplayer section in the Playground drives connect; remote
humans show in the nick list and message log. **Single-player is byte-identical when not
connected.**

**Key decisions:** thin relay (no LLM on the server); host-authoritative personas
deferred to M6.1 (the `canHost` flag is already sent, set from whether this client has
Ollama); relay-as-source-of-order (no optimistic local append → no dupes); joiners get a
snapshot, only single-player persists to IndexedDB (networked messages are session-only).

**Verified:** `npm run typecheck` clean (no DOM/@types/node conflict); **57/57 tests**
(+2 relay two-client integration: message broadcast + host assignment; +2 protocol);
`npm run build` clean. End-to-end in the browser: started `npm run relay`, connected the
preview tab (Playground → connect) → "connected as guest"; a second client launched from
the terminal joined the same room → it appeared in the browser's nick list (live
presence) and its message rendered in the log with the correct nick; disconnect returned
the tab cleanly to single-player (personas resume); no console errors.

**Known limitation (→ M6.1):** a message from a participant who has since *left* renders
its raw id (e.g. `human:2`) because name resolution uses live presence; names render
correctly while connected. A sticky id→name cache will fix this alongside the
host-authoritative persona work.

## M5 — Polish + evals · built 2026-06-28 (awaiting test)

**What shipped:** the v1 finishing pass.
- **CRT ↔ AIM themes** — a header toggle that swaps `document.documentElement`'s
  `data-theme`; both palettes (and font + radius) are pure CSS variables in
  `index.css`, so the whole room restyles instantly. Choice persists in localStorage.
- **`/commands`** — `/who`, `/help`, `/msg <nick> <text>`, `/kick <nick>` (mute),
  `/invite <nick>` (unmute), `/topic <text>`, `/me <action>`, `/regen`, `/fork`
  (rewind to your last message). Parsed in the store; output is rendered as dim
  italic `* … *` system notices (new `author: 'system'`). Muted personas are excluded
  from the Conductor; mute + topic persist.
- **Typing indicators** — a pending message with no text yet shows "Nick is typing…"
  until the first token lands.
- **Eval harness (§6.8)** — `npm run eval` (and `eval:ollama`) samples each persona on
  5 fixed prompts and reports avg words, vocab size, and mean pairwise vocab overlap →
  a distinctness score. Metric functions (`src/eval/metrics.ts`) are pure + unit-tested;
  the runnable script (`eval/run.ts`) loads personas from disk so it runs under `tsx`.

**Key decisions:**
- **Themes are data, not forks.** No per-theme component code — just two CSS-variable
  sets, so adding a theme is adding a `[data-theme]` block.
- **Commands route before chat.** `sendUserMessage` intercepts a leading `/`; everything
  else is unchanged, so the command layer is a thin front door, not a rewrite.
- **Eval reads JSON from disk.** The harness can't use the Vite `import.meta.glob`
  persona loader under plain `tsx`, so it `readdirSync`s `src/personas/*.json` directly.
- **Component tests opt into jsdom per-file** (`// @vitest-environment jsdom`) so the
  fast Node suite stays the default; added `@testing-library/react` + `jsdom`.

**Verified:** `npm run typecheck` clean; **53/53 tests pass** (+4 eval metrics, +2 jsdom
component tests for MessageList/NickList); `npm run build` clean; `npm run eval` prints a
full distinctness report (mock distinctness 0.71, as expected for the canned pool). In
the headless browser: toggling the theme flipped `data-theme` crt→aim and the body from
dark mono (`rgb(11,15,10)`) to light sans (`rgb(238,243,251)`) instantly; `/who`,
`/topic` (header updated to "# cafe — neon nights"), `/kick` (second `/who` showed "Dex
(muted)"), and `/me` all produced the right system lines; no console errors. Human still
to confirm the in-browser Test with real Ollama (ROADMAP M5).

## M4 — Playground · built 2026-06-28 (awaiting test)

**What shipped:** the room is now a tunable instrument. A ⚙ button in the header opens
a right-side **Playground drawer** (`src/ui/Playground.tsx`) with five live controls,
all from DESIGN §6.7:
- **Persona editor** — pick a persona, edit its system prompt, model tag, temperature,
  and top_p. Edits merge onto the JSON base as *overrides*, apply on the persona's next
  turn, and **persist** (so they survive reload).
- **Conductor tuning** — sliders for idle-break seconds, max concurrent, and min score
  ("room energy"), persisted.
- **Regenerate** — drop the last persona line and re-run that persona.
- **Fork/rewind** — hover any message, click ⑂ to truncate the timeline there.
- **A/B** — run one prompt through two personas side by side, streamed.

**Key decisions:**
- **Edits are overrides, not rewrites.** `personaOverrides` (a partial-Persona map) is
  merged onto the glob-loaded JSON via `mergePersona`, kept in `kv`. Personas stay
  data-driven; the JSON is never mutated, so a base edit still flows through for
  untouched fields. (This is the persona-persistence deferred from M2.)
- **Fork = single-timeline rewind.** Rather than maintaining parallel branches, forking
  truncates after the chosen message (`truncateAfter`) and deletes the rest from
  IndexedDB — a usable "explore from here" that stays simple and runnable.
- **A/B is out-of-band.** It streams into separate scratch state (`ab`), reusing the
  provider port and a one-shot `buildABPrompt` — it doesn't touch the room log,
  Conductor, or affinity.
- **Pure helpers, thin store.** merge/fork/regen-target/AB-prompt all live in
  `src/runtime/playground.ts` and are unit-tested; the store just wires them to
  persistence and streaming.

**Verified:** `npm run typecheck` clean; **47/47 tests pass** (+6 playground); `npm run
build` clean. In the headless browser (Mock): opened the drawer (4 sections render);
**A/B** produced two distinct streamed columns (Caius vs Dex); edited Caius's model to
`qwen3:8b` → persisted to IndexedDB and **survived a reload** (re-applied on hydrate);
**regenerate** swapped the last line for a fresh one; **fork** truncated the log to the
clicked message; no console errors. Human still to confirm the in-browser Test with real
Ollama — esp. that editing a prompt visibly changes the next turn and swapping a model
changes character (ROADMAP M4).

## M3 — Friendship sim · built 2026-06-28 (awaiting test)

**What shipped:** the room now has feelings that stick. Each persona carries an
**affinity** in [-1, 1] toward the user (and toward each peer), seeded from its
`warmth` and nudged by a hidden sentinel it can append to a reply:
`§aff {"user": 0.05}§`. The runtime (`src/runtime/affinity.ts`) strips that line
*before display* — and crucially **mid-stream**, by only ever showing text before the
`§aff` marker, so it never flashes on screen. Deltas are clamped to ±0.15/turn, applied
into [-1, 1], persisted to a new IndexedDB `relationships` store (DB bumped to v2), and
**decayed ×0.98 on each session load** so feelings drift back toward neutral instead of
spiraling. `buildPrompt` injects each persona's current feelings ("You feel warmly
toward the user.") so tone actually shifts with affinity. The nick list shows a colored
♥ per persona (green warm → red cool) with the numeric value on hover.

**Key decisions:**
- **Sentinel, not a structured call.** Affinity rides the streamed turn via the
  stripped `§aff` line because structured outputs can't combine with streaming
  (DESIGN §6.4). `stripAffinity` collects deltas from *every* sentinel and removes them
  all; a malformed one is dropped, never leaked. The structured-`generate()` fallback
  stays documented for later if sentinels prove noisy.
- **Affinity is pure + derived.** All math (strip, visibleText, clampDelta, applyDelta,
  decay, baseline-from-warmth, phrasing, target resolution) is pure and unit-tested;
  the store just orchestrates and persists.
- **Warmth seeds the baseline.** Persona→user starts at `warmth − 0.5` (Mira fond at
  +0.35, Dex guarded at −0.20), so personalities feel distinct from message one even
  before any interaction; peers start neutral.
- **Dev affordance:** `window.__cafe.bumpAffinity(personaId, delta, target?)` for
  testing the affinity UI/persistence without waiting on the model.

**Verified:** `npm run typecheck` clean; **41/41 tests pass** (+10 affinity, +1 prompt
injection); `npm run build` clean. In the headless browser: baseline hearts rendered
per-persona from warmth (Mira +0.35 green, Dex −0.20 red); four +0.15 bumps moved Dex
−0.20 → **0.40** (clamping correct) and turned the heart green; after a same-origin
reload Dex read **0.39** — i.e. the relationship persisted *and* decayed (0.40 × 0.98);
no `§aff` ever appeared in the log; no console errors. Human still to confirm the
in-browser Test with real Ollama (warm/cool tone shift across a session), ROADMAP M3.

## M2 — Persistence + memory · built 2026-06-28 (awaiting test)

**What shipped:** the room remembers. An IndexedDB layer (`src/persist/db.ts`, via
`idb`) persists the message log, per-persona long-term notes, and a small kv store
(summarized-count cursor). On boot the store hydrates from IndexedDB; on every
user/persona message it writes through (final text only — no per-token writes). Reload
the page and the conversation is intact. Layered on top: two-tier memory
(`src/runtime/memory.ts`) — the verbatim working window plus a long-term-notes
summarization pass that fires once ~30 messages have aged out of the window, distilling
them into per-persona bullet notes that `buildPrompt` re-injects under "What you
remember:".

**Key decisions:**
- **Personas are not persisted.** They stay JSON-sourced (loaded every boot), so the
  data-driven "drop a file in" model is preserved; persisting *edited* personas is M4's
  job. Only messages, notes, and cursors live in IndexedDB.
- **Write-through on settle, not per token.** User messages persist on send; persona
  messages persist when finalized (pending → false). A reload mid-stream simply drops
  the half-finished line — clean, no partial junk.
- **Memory is derived + cheap.** `summarizedCount` is a high-water mark; summarization
  runs only when `messages - 16 - summarizedCount ≥ 30`, sequentially across personas
  (gentle on one GPU, DESIGN §9), through the same `generate()` port so MockProvider
  exercises it in CI. All the slicing/parse/merge logic is pure and unit-tested.
- **Graceful degradation.** Every IndexedDB call is wrapped; if storage is unavailable
  (private mode/quota) the app runs as an in-memory session instead of crashing.
- **Dev affordance:** `window.__cafe.clearHistory()` wipes IndexedDB and reseeds the
  welcome — for testing the reload behavior (this is *not* the M5 `/commands` feature).

**Verified:** `npm run typecheck` clean; **30/30 tests pass** (added 6 memory + 4
persistence round-trips using `fake-indexeddb` so CI stays hermetic); `npm run build`
clean. In the headless browser: sent "persistence test alpha-123", reloaded the page,
and the full log (welcome + an idle line + the user message) was restored byte-for-byte
from IndexedDB; `__cafe.clearHistory()` reset to the welcome; no console errors. Human
still to confirm the in-browser Test with real Ollama, incl. the long-chat summarization
(ROADMAP M2).

## M1 — Multi-persona + Conductor · built 2026-06-28 (awaiting test)

**What shipped:** the room came alive. Four data-driven personas (Caius, Mira, Dex,
Juno) loaded from `src/personas/*.json` via Vite glob — adding a persona is now
literally dropping in a JSON file. The **Conductor** (`src/core/conductor.ts`, the
domain-critical core, DESIGN §4) decides who speaks: it scores candidates by reason
(mention 100 > question 60 > event 40 > idle 20) plus talkativeness and jitter, then
gates on turn-based cooldowns (2–6 turns by talkativeness), a 2-persona concurrency
cap, an anti-monologue rule (≥3 of last 5), and a min-score floor. The store drives
ticks on each new message and on a 12s idle timer; the persona runtime
(`src/runtime/personaRuntime.ts`) flattens the log into a labelled transcript prompt.

**Key decisions:**
- **Conductor is pure.** It takes (log, roster, generating set, trigger, rng) and
  returns who speaks — no timers or I/O inside. That made the social dynamics fully
  unit-testable with a pinned RNG (15 deterministic tests). Cooldown and monologue
  state are *derived from the message log* (messages-since-last-spoke), so there's no
  separate mutable state to keep in sync.
- **Ollama is the default, Mock is the safety net.** On startup the store probes
  `GET /api/tags` (which doubles as the CORS check); if it fails, it stays on
  `MockProvider` so the app always runs. The Mock now streams varied canned lines so a
  no-Ollama run still *shows* turn-taking. A `● ollama / ● mock` badge surfaces which
  path is live.
- **Idle keeps the room alive.** When the room settles, a 12s timer fires an idle tick
  that picks exactly one persona, weighted by talkativeness — so a quiet room gets a
  single line, never a pile-on.
- **Scaffolding fix:** `vite.config.ts` now reads `process.env.PORT` so the preview
  harness can bind the dev server to its assigned port (it was drifting to a random
  Vite port otherwise).

**Verified:** `npm run typecheck` clean; **20/20 tests pass** (`tests/conductor.test.ts`
15, `tests/runtime.test.ts` 2, `tests/skeleton.test.ts` 3); `npm run build` clean.
Ran the app in the headless browser preview (Mock fallback, since this box has no
Ollama): no console errors; the idle timer fired and Juno (most talkative) broke the
silence; Mira/Dex/Caius then took turns with the concurrency cap; a direct mention of
Dex was correctly *withheld* because he was still on cooldown — anti-spam working live.
Human still to confirm the in-browser Test with real Ollama (ROADMAP M1).

## M0 — Echo room (skeleton & it runs) · built 2026-06-28 (awaiting test)

**What shipped:** a runnable React 19 + Vite 8 chat shell. Three-pane layout
(channels · message log · nick list) with the retro CRT palette as CSS variables.
One hardcoded persona ("Caius") replies through the `LLMProvider` port; the default
`MockProvider` streams a canned reply token-by-token into a `pending` message, so the
"someone is typing" feel and the persona-runtime seam both work with **no Ollama
install** — which also keeps CI hermetic.

**Key decisions:**
- **Provider port first.** `LLMProvider` (chat-stream + one-shot generate) is the
  central seam from day one (DESIGN §6.5). `MockProvider` backs dev/CI; the real
  `OllamaProvider` is fully implemented (NDJSON line-parsing over `fetch`) and ready,
  but the app defaults to Mock until M1 so M0 needs no external services.
- **Streaming vs structured outputs.** Confirmed against current Ollama docs
  (verified 2026-06-27): `format` (JSON schema) is one-shot and cannot combine with
  streaming. Recorded in DESIGN §6.4/§6.6 — affinity will ride a stripped `§aff …§`
  sentinel on the streamed turn, not a structured call. No code impact yet (M3).
- **State = Zustand 5.** The store orchestrates the M0 send loop directly; the Room +
  Conductor split (DESIGN §5) is introduced in M1 when turn-taking needs it.
- **Tests stay pure for M0.** Vitest runs in the Node environment (no jsdom yet) —
  the test covers the `formatTimestamp` helper and that `MockProvider` streams tokens
  that reassemble into the reply and end with exactly one `done` frame.

**Verified:** `npm install`, `npm run typecheck`, `npm test`, and `npm run build`
all succeeded locally (evidence in the scaffold session). Human still to confirm the
in-browser Test in ROADMAP M0.
