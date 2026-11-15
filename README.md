# le-chat-cafe

> An old-school chat room where every "person" but you is an LLM persona — part
> friendship simulator, part multi-agent LLM playground, part IRC/AIM-era nostalgia
> trip. Runs entirely on your own machine (local Ollama), for free.

You walk into a room. A nick list runs down the side: you, and a handful of
LLM-driven personas — each with its own name, color, voice, and moods. They talk to
you, they talk to *each other*, they come and go, and they remember you and how they
feel about you across sessions. Wander between channels, slip into a private chat, or
open the playground and tune the room like an instrument.

**Status:** _full roadmap built (Phases 0–4, M0–M11)._ A persistent multi-persona
room with the Conductor, a friendship sim, a power-user playground, CRT/AIM themes,
`/commands`, a persona-distinctness eval, and an opt-in WebSocket relay so other
humans can join. Plus your own nick, personas who drift in and out, profile cards
showing what each one remembers, `#cafe` / `#arcade` / `#library` with their own
crowds and private DMs, and AIM-era touches: door sounds, chimes, unread counts in the
tab title, and `/export` to a `.log`. See [ROADMAP.md](ROADMAP.md) for the plan.

---

## Run it

**Prerequisites:** Node.js ≥ 22 (check: `node -v`). For real personas, install
[Ollama](https://ollama.com) and pull the models the personas use (see each
`src/personas/*.json` — currently `qwen2.5:7b-instruct` and `qwen2.5:1.5b-instruct`):

```bash
ollama pull qwen2.5:7b-instruct
ollama pull qwen2.5:1.5b-instruct
```

Don't have those exact tags? Fine — if a persona names a model that isn't installed,
the app automatically substitutes the closest installed one (same family, else any)
and posts a notice in the chat log.

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

**In the room:** the header toggles the CRT ↔ AIM theme and room sounds (♪) and opens
the ⚙ playground.
Hover a message and click ⑂ to rewind the timeline. Click any nick for their profile
card: bio, how they feel about you, what they remember (hover a memory and click ✕ to
make them forget it), and a **message** button for a private chat. Type `/help` for
the full list of commands:

| Chat command | What it does |
|---|---|
| `/nick <name>` | Pick your name (the personas use it) |
| `/join #arcade` · `/part` · `/list` | Move between channels; each has its own crowd |
| `/query <nick>` · `/msg <nick> <text>` | Private chat with one persona |
| `/who` · `/whois <nick>` | Who's here · open someone's profile card |
| `/kick <nick>` · `/invite <nick>` | Send a persona away · bring them back |
| `/forget <nick>` | Clear everything a persona remembers |
| `/topic <text>` · `/me <action>` | Steer the room · narrate an action |
| `/export` | Save the window you're in as an IRC-style `.log` |
| `/regen` · `/fork` | Redo the last persona line · rewind to your last message |

Personas who like you sometimes message you first while you're in another channel;
the channel pane shows an unread badge. Tune that, and how often personas come and go,
in the ⚙ playground.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run in development (Vite dev server) |
| `npm test` | Run the tests (Vitest) |
| `npm run typecheck` | Type-check with `tsc` (no emit) |
| `npm run build` | Production build (typecheck + Vite build) |
| `npm run eval` | Persona-distinctness report (add `:ollama` for real models) |
| `npm run relay` | Start the multiplayer relay (`ws://localhost:8787`) |

### Multiplayer (optional)

Run `npm run relay`, then in the app open the ⚙ playground → **Multiplayer** → connect
two browser tabs to the same room. Humans appear in each other's nick list and chat in
real time. The **first** tab to connect becomes the **host** — it drives the personas
(have Ollama there) and broadcasts their turns to everyone; other tabs are viewers. It's
fully opt-in — without the relay the app is single-player as above. Persona turns stream
live to viewers, clients auto-reconnect if the relay blips, and host duties hand off if
the host leaves. A shared room is one channel: channels and DMs are single-player only.

---

## Project docs

| Doc | What's in it |
|---|---|
| [DESIGN.md](DESIGN.md) | The full design and rationale — the single source of truth. |
| [ROADMAP.md](ROADMAP.md) | The milestone checklist (the plan + what's done). |
| [`docs/`](docs/) | Long-form docs and architecture decisions (ADRs). |

## Tech stack

TypeScript · React 19 · Vite 8 · Zustand 5 · IndexedDB (`idb`) · Vitest · local
**Ollama** for inference. Browser-only; no backend in v1.

## License

MIT — see [LICENSE](LICENSE).
