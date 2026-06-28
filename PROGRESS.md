# PROGRESS — le-chat-cafe

A build log of what shipped and the notable decisions behind it. **Keep it honest** —
this is the working memory between build sessions. The forward-looking plan and
acceptance tests live in [ROADMAP.md](ROADMAP.md); this is the backward-looking "what
got done and why" companion.

**Current phase:** Phase 0 complete (M0 scaffolded). Next: **M1 — Multi-persona +
Conductor** (see [ROADMAP.md](ROADMAP.md)).

### State of the tree

| Area | Files | Status |
|---|---|---|
| LLM port | `src/llm/provider.ts` | ✅ interface defined (chat-stream + generate) |
| Providers | `src/llm/mock.ts`, `src/llm/ollama.ts` | ✅ Mock (default) + real Ollama (NDJSON stream); Ollama wired as default in M1 |
| Data models | `src/core/types.ts` | ✅ full spec types; Conductor types unused until M1 |
| Room state | `src/state/store.ts` | ✅ Zustand store, single hardcoded persona, streaming send |
| UI | `src/App.tsx`, `src/ui/*` | ✅ three-pane shell, message list, composer, nick list |
| Conductor | — | ⛔ not built (M1) |
| Persistence | — | ⛔ not built (M2) |
| Tests | `tests/skeleton.test.ts` | ✅ format helper + provider streaming |

---

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
