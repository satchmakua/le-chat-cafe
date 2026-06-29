// Persona distinctness eval harness (DESIGN §6.8). Samples each persona on a
// fixed prompt set and reports how differentiated they are. Runs against the
// MockProvider by default (hermetic, but personas will look identical — that's
// expected for the stub); pass --ollama to measure the real models.
//
//   npm run eval            # MockProvider
//   npm run eval:ollama     # local Ollama
//
// Loads personas from disk (not the Vite glob) so it runs under plain tsx.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMProvider } from '../src/llm/provider';
import { MockProvider } from '../src/llm/mock';
import { OllamaProvider } from '../src/llm/ollama';
import { buildABPrompt } from '../src/runtime/playground';
import { avgWords, meanPairwiseOverlap, wordSet } from '../src/eval/metrics';
import type { Persona } from '../src/core/types';

const PROMPTS = [
  'what did you get up to this weekend?',
  'recommend me something good',
  'someone new just walked in — say hi',
  "what's on your mind tonight?",
  'pitch me your ideal evening',
];

function loadPersonas(): Persona[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/personas');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Persona);
}

async function sample(provider: LLMProvider, persona: Persona, prompt: string): Promise<string> {
  let raw = '';
  for await (const chunk of provider.chat({
    model: persona.model,
    messages: buildABPrompt(persona, prompt),
    options: { temperature: persona.params.temperature, top_p: persona.params.topP },
  })) {
    raw += chunk.token;
  }
  return raw.trim();
}

async function main() {
  const useOllama = process.argv.includes('--ollama');
  const provider: LLMProvider = useOllama
    ? new OllamaProvider()
    : new MockProvider({ delayMs: 0 });
  const personas = loadPersonas();

  console.log(`\nle-chat-cafe — persona distinctness eval  (${useOllama ? 'ollama' : 'mock'})`);
  console.log(`${personas.length} personas × ${PROMPTS.length} prompts\n`);

  const vocabs: Set<string>[] = [];
  console.log('persona      avg words   vocab size');
  console.log('-------------------------------------');
  for (const persona of personas) {
    const replies: string[] = [];
    for (const prompt of PROMPTS) replies.push(await sample(provider, persona, prompt));
    const vocab = wordSet(replies.join(' '));
    vocabs.push(vocab);
    console.log(
      `${persona.name.padEnd(12)} ${avgWords(replies).toFixed(1).padStart(8)} ${String(vocab.size).padStart(11)}`,
    );
  }

  const overlap = meanPairwiseOverlap(vocabs);
  console.log('\n-------------------------------------');
  console.log(`mean pairwise vocab overlap : ${overlap.toFixed(3)}  (lower = more distinct)`);
  console.log(`distinctness score          : ${(1 - overlap).toFixed(3)}  (higher = better)\n`);
  if (!useOllama) {
    console.log('(mock replies share one canned pool, so expect low distinctness — run with --ollama for real signal)\n');
  }
}

void main();
