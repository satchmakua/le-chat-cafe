# ROADMAP — le-chat-cafe

The milestone checklist.

> **Phases 0–3 complete (M0–M6.2).** v1 confirmed 2026-06-28; multiplayer (M6)
> confirmed 2026-07-17 by a two-browser-tab test. **Phase 4 — a living world (M7–M11)
> is in progress.**

**Rules of the road:**
- Each milestone is an **independently runnable** slice — something actually testable
  end-to-end, not an internal-only refactor.
- Every milestone ends with explicit **Test** steps: what to do and what should
  happen. These are the acceptance criteria.
- Build **top-down**: a thin end-to-end slice first, then deepen.
- Check a box **only after its Test passes**.

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

- [x] **M1 — Multi-persona + Conductor.** Load 3–4 personas from `src/personas/*.json`.
  Implement the §4 Conductor (mention / question / event / idle candidates, scoring,
  cooldowns, `MAX_CONCURRENT=2`, anti-monologue) and wire the `OllamaProvider` as the
  default with a Mock fallback. Personas reply to you *and each other* without
  spamming. _(DESIGN §4, §6.1, §6.4)_
  **Test:** with Ollama running (models pulled, `OLLAMA_ORIGINS` set), open the app →
  ask the room a question mentioning one persona by name → that persona answers first;
  leave the room idle → after ~12s exactly one persona breaks the silence; no persona
  monologues. Conductor scoring has unit tests with a pinned RNG (`npm test` green).

- [x] **M2 — Persistence + memory.** IndexedDB (`idb`) for the message log, personas,
  and channel; working-memory window (last N) + long-term-notes summarization.
  _(DESIGN §6.2, §6.3)_
  **Test:** chat for a while, reload the page → history and personas are still there;
  a long conversation still produces in-character replies (older context summarized,
  not dropped).

- [x] **M3 — Friendship sim.** Affinity via the `§aff {…}§` sentinel (stripped before
  display, clamped ±0.15/turn, decay on load), `Relationship` state injected into
  prompts, persisted. _(DESIGN §6.6)_
  **Test:** be warm to a persona across a session, reload → it greets you more warmly
  and references you; be cold → its tone visibly cools. No `§aff` text ever shows in
  the log.

## Phase 2 — Instrument & polish

- [x] **M4 — Playground.** Live persona/prompt/model editing, per-persona + Conductor
  tuning, fork the timeline, regenerate the last line, A/B two personas. _(DESIGN §6.7)_
  **Test:** edit a persona's system prompt → its next turn reflects the change; swap
  its model → replies change character; fork and regenerate work.

- [x] **M5 — Polish + evals.** CRT↔AIM theme toggle (CSS-variable swap), full
  `/commands` (`/who`, `/msg`, `/kick`, `/invite`, `/topic`, `/me`, `/regen`, `/fork`),
  typing indicators, nick coloring, and the §6.8 distinctness eval harness (add
  jsdom + Testing Library for component tests). _(DESIGN §6.8, §7)_
  **Test:** toggle themes → the whole room restyles instantly; `/commands` work; the
  eval script reports per-persona distinctness numbers.

## Phase 3 — Multiplayer (post-v1, greenlit 2026-06-28)

Crosses the v1 "no backend" line on purpose; single-player stays the default. Full
spec in [DESIGN.md §11](DESIGN.md).

- [x] **M6.0 — Relay skeleton.** Thin Node + `ws` relay + a `Transport` port
  (`LocalTransport` no-op / `WSTransport`). Two clients join a room and exchange
  *human* messages with live presence (join/leave); networked mode gates local persona
  ticks. Single-player path unchanged. _(DESIGN §11)_
  **Test:** run `npm run relay`; open two browser tabs, connect both to the same room →
  a message typed in one appears in the other, and each tab's nick list shows the other
  human. With no relay, the app behaves exactly as before. (`npm test` covers the relay
  with a two-client integration test.)

- [x] **M6.1 — Host-authoritative personas.** The host client runs the Conductor and
  broadcasts persona turns; joiners see the room banter. `/who` lists remote humans +
  personas. _(DESIGN §11)_
  **Test:** two tabs connected, only the host has Ollama → personas reply and both tabs
  see the same turns in the same order; no duplicate persona lines.

- [x] **M6.2 — Streaming & resilience.** Token-delta streaming over WS, reconnection
  with snapshot resync, nick-collision handling, host hand-off when the host leaves.
  _(DESIGN §11)_
  **Test:** persona replies stream live in the joiner's tab; kill/restart a tab → it
  resyncs; close the host tab → another client picks up hosting.

## Phase 4 — A living world

What still breaks the illusion, in order: nobody knows your name, the room never
breathes, what the personas remember is invisible, and there's only one room. Full
spec in [DESIGN.md §12](DESIGN.md).

- [x] **M7 — Your name.** `/nick <name>` (persisted); prompts label your lines and the
  roster with it so personas address you by name; persona lines that mention you are
  highlighted. _(DESIGN §12.1)_
  **Test:** `/nick Satchel` → your lines show `Satchel` and a notice confirms it; talk
  to the room → a persona addresses you by name and that line is highlighted; reload →
  the nick is still set; `/nick` with a persona's name is refused.

- [x] **M8 — Personas come and go.** Log-derived presence, sociability-weighted
  departures/arrivals on a jittered timer, IRC quit messages, arrival greetings;
  `/kick` and `/invite` become real departures/arrivals. _(DESIGN §12.2)_
  **Test:** set "comings & goings" to ~15 s in ⚙ and wait → `* X has quit (…) *`
  and `* Y has joined #cafe *` lines appear, away personas are dimmed and silent,
  arrivals say hi, and at least two personas are always present; `/kick Dex` → he
  leaves and stays gone; `/invite Dex` → he joins and greets; reload → presence holds.

- [x] **M9 — Profiles.** Clickable nicks and `/whois <nick>` open a profile card: bio,
  status, interests, model, feelings toward you and the others, and what they
  remember. _(DESIGN §12.3)_
  **Test:** click Mira → her card shows bio, status, how she feels about you, what she
  remembers, and her strongest feelings about the others; `/whois Dex` opens his;
  Esc closes it; nothing is added to the chat log.

- [ ] **M10 — Channels & DMs.** `#cafe` / `#arcade` / `#library` with per-channel logs,
  topics, and members; `/join` `/part` `/list` `/query`; private `/msg`; personas who
  like you occasionally DM you first. _(DESIGN §12.4)_
  **Test:** `/join #arcade` → only the arcade crowd is there and they talk there;
  switch back → #cafe's history is intact; `/msg Mira hi` → a private `@Mira` window
  opens and only she answers; reload → channels, DMs, and topics persist.

- [ ] **M11 — Retro polish.** Synthesized sounds (with a toggle), `/export` to a `.log`,
  unread counts in the tab title. _(DESIGN §12.5)_
  **Test:** a persona arrives → a door sound plays (toggle it off in the header →
  silence); `/export` downloads a readable `.log` of the current channel; hide the tab
  while a DM arrives → its title shows `(1)`.

---

**North star:** you forget, for a minute, that the room is empty — the personas feel
like distinct people who remember you, and it all runs on your own machine for free.
