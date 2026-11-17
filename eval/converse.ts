// Conversation probe: does a model actually *converse*? Runs one scripted scene —
// you say hi, name a persona, share something — through the real prompt builder and
// turn guards, with every persona on the same model, and prints the transcript.
// Distinctness (`npm run eval`) measures whether personas sound different; this shows
// whether they answer you and each other at all.
//
//   npm run eval:converse                 → every installed model
//   npm run eval:converse -- qwen2.5:7b-instruct llama3.1:8b
//
// Needs a local Ollama. Personas load from disk so this runs under tsx.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OllamaProvider } from '../src/llm/ollama';
import {
  answerDirective,
  assemblePrompt,
  buildPromptParts,
  recitationSource,
} from '../src/runtime/personaRuntime';
import { stripAffinity } from '../src/runtime/affinity';
import {
  breaksCharacter,
  characterPriors,
  cutAtNextSpeaker,
  isEcho,
  recitesPrompt,
  stripNamePrefix,
} from '../src/runtime/repetition';
import type { Message, Persona } from '../src/core/types';

const OLLAMA_URL = 'http://localhost:11434';
// CAFE_YOU= (empty) runs the scene as someone who never set a nick.
const YOU = process.env.CAFE_YOU ?? 'Satchel';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'personas');
const personas: Persona[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Persona);
const byId = (id: string) => personas.find((p) => p.id === id)!;

/** The scene: `say` is you typing; `turn` is one persona's turn (as the Conductor
 *  would pick it — a mention answers, an idle turn reacts to the room). */
type Step = { say: string } | { turn: string; answering?: boolean };
const SCENE: Step[] = [
  { say: 'Hi everyone' },
  { turn: 'caius', answering: true },
  { turn: 'juno' },
  { say: 'Hey Caius' }, // a bare greeting: nothing to latch onto but you
  { turn: 'caius', answering: true },
  { turn: 'dex' },
  { say: 'Sorry, what do you mean?' }, // for whoever spoke last
  { turn: 'dex', answering: true },
  { say: "Hi Mira! I just started learning piano, it's humbling" },
  { turn: 'mira', answering: true },
  { turn: 'juno' },
  { say: 'Dex, what are you working on?' },
  { turn: 'dex', answering: true },
  { turn: 'mira' },
  { turn: 'caius' },
];

async function run(model: string): Promise<void> {
  const provider = new OllamaProvider({ baseUrl: OLLAMA_URL });
  const log: Message[] = [];
  let seq = 0;
  let lastSaid = '';
  const add = (author: string, text: string) =>
    log.push({ id: String(seq++), channelId: 'cafe', author, text, ts: seq });
  const labels = [...personas.flatMap((p) => [p.name, ...(p.aliases ?? [])]), YOU || 'user'];
  let dropped = 0;
  let ms = 0;
  let turns = 0;

  console.log(`\n══ ${model} ${'═'.repeat(Math.max(0, 60 - model.length))}`);
  for (const step of SCENE) {
    if ('say' in step) {
      add('user', step.say);
      lastSaid = step.say;
      console.log(`  <${YOU || 'user'}> ${step.say}`);
      continue;
    }
    const persona = byId(step.turn);
    const parts = buildPromptParts(persona, log, personas, {
      ...(YOU ? { names: { user: YOU }, humans: [YOU] } : {}),
      affinities: { user: persona.temperament.warmth - 0.5 },
      place: '#cafe (the main room, where anything goes)',
      directive: step.answering ? answerDirective(lastSaid, YOU || undefined) : undefined,
    });
    const t0 = Date.now();
    let raw = '';
    for await (const chunk of provider.chat({
      model,
      messages: assemblePrompt(parts),
      options: { temperature: persona.params.temperature, top_p: persona.params.topP },
    })) {
      raw += chunk.token;
    }
    ms += Date.now() - t0;
    turns++;
    const clean = cutAtNextSpeaker(stripNamePrefix(stripAffinity(raw).clean, persona.name), labels);
    const priors = [
      ...log.filter((m) => m.author === persona.id).slice(-6).map((m) => m.text),
      ...characterPriors(persona.systemPrompt),
    ];
    const why = !clean
      ? 'empty'
      : isEcho(clean, priors)
        ? 'echo'
        : recitesPrompt(clean, recitationSource(parts))
          ? 'recites prompt'
          : breaksCharacter(clean, persona)
            ? 'breaks character'
            : null;
    if (why) {
      dropped++;
      console.log(`  <${persona.name}> ✗ DROPPED (${why}): ${JSON.stringify(raw.slice(0, 140))}`);
    } else {
      add(persona.id, clean);
      console.log(`  <${persona.name}> ${clean.replace(/\n/g, '\n      ')}`);
    }
  }
  console.log(`  -- ${turns} turns, ${dropped} dropped by guards, avg ${(ms / turns / 1000).toFixed(1)}s/turn`);
}

async function main(): Promise<void> {
  let installed: string[];
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    installed = ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  } catch {
    console.error(`Ollama isn't reachable at ${OLLAMA_URL} — start it and try again.`);
    process.exit(1);
  }
  const wanted = process.argv.slice(2);
  for (const model of wanted.length > 0 ? wanted : installed) await run(model);
}

void main();
