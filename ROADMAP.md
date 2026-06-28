# ROADMAP — le-chat-cafe

The milestone checklist. Standing instruction: **"continue"** → build the next
unchecked milestone.

**Rules of the road:**
- Each milestone is an **independently runnable** slice — something the human can
  actually test, not an internal-only refactor.
- Every milestone ends with explicit **Test** steps: what to do and what should
  happen. These are the acceptance criteria.
- Build **top-down**: a thin end-to-end slice first, then deepen.
- Check a box **only after the human confirms its Test passes**, then add a
  `PROGRESS.md` entry.

See [DESIGN.md](DESIGN.md) for the full rationale; section refs below point into it.

---

## Phase 0 — Walking skeleton

- [x] **M0 — Echo room (skeleton & it runs).** React + Vite shell, three-pane chat
  layout (channels · log · nick list), one hardcoded persona behind the
  `LLMProvider` port. Type a message → get a *streamed* reply in the log. Ships a
  `MockProvider` (no Ollama needed) and the real `OllamaProvider` (wired in M1).
  Typecheck + Vitest green. _(DESIGN §5, §6.5)_
  **Test:** `npm install` then `npm run dev` → app opens with no console errors; type
  a message, press send → a reply streams in token-by-token under a colored nick with
  an `[HH:MM]` timestamp. `npm test` → green; `npm run typecheck` → clean.

## Phase 1 — A living room

- [ ] **M1 — Multi-persona + Conductor.** Load 3–4 personas from `src/personas/*.json`.
  Implement the §4 Conductor (mention / question / event / idle candidates, scoring,
  cooldowns, `MAX_CONCURRENT=2`, anti-monologue) and wire the `OllamaProvider` as the
  default with a Mock fallback. Personas reply to you *and each other* without
  spamming. _(DESIGN §4, §6.1, §6.4)_
  **Test:** with Ollama running (models pulled, `OLLAMA_ORIGINS` set), open the app →
  ask the room a question mentioning one persona by name → that persona answers first;
  leave the room idle → after ~12s exactly one persona breaks the silence; no persona
  monologues. Conductor scoring has unit tests with a pinned RNG (`npm test` green).

- [ ] **M2 — Persistence + memory.** IndexedDB (`idb`) for the message log, personas,
  and channel; working-memory window (last N) + long-term-notes summarization.
  _(DESIGN §6.2, §6.3)_
  **Test:** chat for a while, reload the page → history and personas are still there;
  a long conversation still produces in-character replies (older context summarized,
  not dropped).

- [ ] **M3 — Friendship sim.** Affinity via the `§aff {…}§` sentinel (stripped before
  display, clamped ±0.15/turn, decay on load), `Relationship` state injected into
  prompts, persisted. _(DESIGN §6.6)_
  **Test:** be warm to a persona across a session, reload → it greets you more warmly
  and references you; be cold → its tone visibly cools. No `§aff` text ever shows in
  the log.

## Phase 2 — Instrument & polish

- [ ] **M4 — Playground.** Live persona/prompt/model editing, per-persona + Conductor
  tuning, fork the timeline, regenerate the last line, A/B two personas. _(DESIGN §6.7)_
  **Test:** edit a persona's system prompt → its next turn reflects the change; swap
  its model → replies change character; fork and regenerate work.

- [ ] **M5 — Polish + evals.** CRT↔AIM theme toggle (CSS-variable swap), full
  `/commands` (`/who`, `/msg`, `/kick`, `/invite`, `/topic`, `/me`, `/regen`, `/fork`),
  typing indicators, nick coloring, and the §6.8 distinctness eval harness (add
  jsdom + Testing Library for component tests). _(DESIGN §6.8, §7)_
  **Test:** toggle themes → the whole room restyles instantly; `/commands` work; the
  eval script reports per-persona distinctness numbers.

<!-- Post-v1 (documented, not scheduled): real multiplayer via a thin Node + WebSocket
     relay — a second human is just another participant id (DESIGN §8). -->

---

**North star:** you forget, for a minute, that the room is empty — the personas feel
like distinct people who remember you, and it all runs on your own machine for free.
