# le-chat-cafe

> An old-school chat room where every "person" but you is an LLM persona — part
> friendship simulator, part multi-agent LLM playground, part IRC/AIM-era nostalgia
> trip. Runs entirely on your own machine (local Ollama), for free.

You walk into a room. A nick list runs down the side: you, and a handful of
LLM-driven personas — each with its own name, color, voice, and moods. They talk to
you, they talk to *each other*, and (later milestones) they remember how they feel
about you across sessions. Lurk, jump in, or open the playground and tune the room
like an instrument.

**Status:** _M1 — multi-persona room with the Conductor_ — see [ROADMAP.md](ROADMAP.md)
for the plan and [PROGRESS.md](PROGRESS.md) for what's shipped.

---

## Run it

**Prerequisites:** Node.js ≥ 22 (check: `node -v`). For real personas, install
[Ollama](https://ollama.com) and pull the model the personas use:

```bash
ollama pull llama3.2:3b
```

Ollama must allow the browser origin or the fetch is CORS-blocked. Start it with:

```bash
# macOS/Linux: OLLAMA_ORIGINS=* ollama serve
# Windows (PowerShell): $env:OLLAMA_ORIGINS='*'; ollama serve
```

Without Ollama the app still runs — it falls back to a built-in `MockProvider` (the
header shows `● mock` vs `● ollama`) so you can see the Conductor take turns.

```bash
npm install     # once
npm run dev     # start it → open the printed URL (default http://localhost:5173)
```

Type a message and the room responds — personas reply to you and to each other,
streaming token-by-token. Leave it idle and someone breaks the silence.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run in development (Vite dev server) |
| `npm test` | Run the tests (Vitest) |
| `npm run typecheck` | Type-check with `tsc` (no emit) |
| `npm run build` | Production build (typecheck + Vite build) |

---

## How to give feedback

This project is built by an AI loop; you mainly **test and report**:

- Describe what happened in plain language.
- Paste any errors verbatim (the single most useful thing) — including anything in
  the browser devtools console.
- Screenshots for anything visual.

Every milestone in [ROADMAP.md](ROADMAP.md) ends with explicit **Test** steps.

---

## Project docs

| Doc | What's in it |
|---|---|
| [DESIGN.md](DESIGN.md) | The full design and rationale — the single source of truth. |
| [ROADMAP.md](ROADMAP.md) | The milestone checklist (the plan + what's done). |
| [PROGRESS.md](PROGRESS.md) | Build log: what shipped each milestone and why. |
| [CLAUDE.md](CLAUDE.md) | Standing instructions for the AI build loop. |
| [`docs/`](docs/) | Long-form docs and architecture decisions (ADRs). |

## Tech stack

TypeScript · React 19 · Vite 8 · Zustand 5 · IndexedDB (`idb`) · Vitest · local
**Ollama** for inference. Browser-only; no backend in v1.

## License

MIT — see [LICENSE](LICENSE).
