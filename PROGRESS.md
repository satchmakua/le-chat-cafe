# PROGRESS — le-chat-cafe

A build log of what shipped and the notable decisions behind it. **Keep it honest** —
this is the working memory between build sessions. The forward-looking plan and
acceptance tests live in [ROADMAP.md](ROADMAP.md); this is the backward-looking "what
got done and why" companion.

**Current phase:** Phase 1 underway (M2 built, awaiting test). Next: **M3 —
Friendship sim** (see [ROADMAP.md](ROADMAP.md)).

### State of the tree

| Area | Files | Status |
|---|---|---|
| LLM port | `src/llm/provider.ts` | ✅ interface defined (chat-stream + generate) |
| Providers | `src/llm/mock.ts`, `src/llm/ollama.ts` | ✅ Ollama default (probed at startup) + Mock fallback |
| Data models | `src/core/types.ts` | ✅ full spec types in use |
| Conductor | `src/core/conductor.ts` | ✅ pure scoring/selection (DESIGN §4); 15 unit tests |
| Persona runtime | `src/runtime/personaRuntime.ts` | ✅ prompt builder + transcript (memory-aware) |
| Memory | `src/runtime/memory.ts` | ✅ working window + long-term-notes summarization |
| Persistence | `src/persist/db.ts` | ✅ IndexedDB (messages, memory, kv) via `idb` |
| Personas | `src/personas/*.json` | ✅ 4 personas, glob-loaded (data-driven) |
| Room state | `src/state/store.ts` | ✅ ticks, concurrency, idle timer, streaming, hydrate + persist |
| UI | `src/App.tsx`, `src/ui/*` | ✅ three-pane shell, provider badge, typing dots |
| Affinity | — | ⛔ not built (M3) |
| Tests | `tests/*.test.ts` | ✅ 30 passing (conductor, runtime, memory, persist, seam) |

---

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
