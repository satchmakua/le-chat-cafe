import { describe, it, expect } from 'vitest';
import {
  breaksCharacter,
  characterPriors,
  cutAtNextSpeaker,
  isEcho,
  normalizeWords,
  overlapRatio,
  recitesPrompt,
  sentences,
  stripNamePrefix,
} from '../src/runtime/repetition';
import juno from '../src/personas/juno.json';
import dex from '../src/personas/dex.json';
import mira from '../src/personas/mira.json';
import caius from '../src/personas/caius.json';

describe('normalizeWords / overlapRatio', () => {
  it('normalizes case and punctuation', () => {
    expect(normalizeWords("Hey, ALL — what's good?!")).toEqual(['hey', 'all', "what's", 'good']);
  });

  it('scores identical and disjoint texts at the extremes', () => {
    expect(overlapRatio('coffee and code', 'Coffee and code!')).toBe(1);
    expect(overlapRatio('coffee and code', 'tea plus books')).toBe(0);
  });

  it('catches containment (prior line plus filler)', () => {
    // "same line again with a few extra words" still scores high vs the smaller set
    expect(overlapRatio('honestly i just love coffee', 'well, honestly i just love coffee these days')).toBe(1);
  });
});

describe('sentences', () => {
  it('splits prose into trimmed sentences', () => {
    expect(sentences('You are Dex: terse. You light up for code! Ok?')).toEqual([
      'You are Dex: terse',
      'You light up for code',
      'Ok',
    ]);
  });
});

describe('isEcho', () => {
  const systemSentences = sentences(
    'You are Dex: terse, sardonic, allergic to small talk. You light up only for code, hardware, and sci-fi.',
  );

  it('flags a reply that restates the character prompt', () => {
    expect(isEcho("I'm terse, sardonic, and allergic to small talk.", systemSentences)).toBe(true);
  });

  it('flags repeating a recent own line', () => {
    expect(isEcho('anyone else need more coffee?', ['anyone else need more coffee?'])).toBe(true);
  });

  it('passes a genuinely new reply', () => {
    expect(isEcho('the new kernel build finally compiles clean', systemSentences)).toBe(false);
  });

  it('never flags short small talk', () => {
    expect(isEcho('ha, fair enough.', ['ha, fair enough.'])).toBe(false); // < 4 words
  });

  it('ignores short priors so greetings do not poison the well', () => {
    expect(isEcho('morning all, what did i miss overnight', ['morning all'])).toBe(false);
  });
});

// Fixtures below are verbatim lines from a live run against the shipped personas.
describe('prompt recitation (live regressions)', () => {
  it('clause priors catch a recited description the sentence split let through', () => {
    const line = 'Chaotic-good hype energy, fast and playful here at le-chat-cafe!';
    expect(isEcho(line, sentences(juno.systemPrompt))).toBe(false); // the old miss (0.70)
    expect(isEcho(line, characterPriors(juno.systemPrompt))).toBe(true);
  });

  it('n-gram recitation catches partial parroting of a signature phrase', () => {
    const line = 'Chaotic-good hype energy here — ready to mix in the madness!';
    expect(isEcho(line, characterPriors(juno.systemPrompt))).toBe(false); // too partial
    expect(recitesPrompt(line, juno.systemPrompt)).toBe(true);
  });

  it('runs of short glue words do not count as recitation', () => {
    expect(recitesPrompt('she said it in a friendly way, honestly', juno.systemPrompt)).toBe(false);
  });

  it('healthy in-character lines from the same run pass every guard', () => {
    const healthy: [string, { name: string; systemPrompt: string }][] = [
      ["Hi Satchel! I've heard Caius and Dex are particularly good at telling tales of this place.", mira],
      ["Welcome to the den of late-night talkers! We're a bit eclectic, but that's what makes it fun.", caius],
      ['Ah, a new face always brings fresh fuel for our fireside chats.', caius],
    ];
    for (const [line, p] of healthy) {
      expect(isEcho(line, characterPriors(p.systemPrompt))).toBe(false);
      expect(recitesPrompt(line, p.systemPrompt)).toBe(false);
      expect(breaksCharacter(line, p)).toBe(false);
    }
  });
});

describe('breaksCharacter', () => {
  it('catches model self-reference and denying your own name', () => {
    expect(breaksCharacter("I'm not really Dex, just fine-tuned for tech stuff.", dex)).toBe(true);
    expect(breaksCharacter('As an AI, I cannot taste coffee.', dex)).toBe(true);
    expect(breaksCharacter("I'm just a language model, honestly", dex)).toBe(true);
    expect(breaksCharacter("that's not in my system prompt", dex)).toBe(true);
  });

  it('lets ordinary human phrasing through', () => {
    for (const line of [
      'my programming setup is a mess tonight',
      'I was trained by my coach back in school',
      'roleplaying as a paladin in the campaign later',
      'as an assistant librarian I see a lot of weird books',
      "I'm not really sure, Dex",
    ]) {
      expect(breaksCharacter(line, dex)).toBe(false);
    }
  });
});

describe('stripNamePrefix', () => {
  it('removes a leading self-name prefix in common shapes', () => {
    expect(stripNamePrefix('Juno: 🍪 bacon rolls!', 'Juno')).toBe('🍪 bacon rolls!');
    expect(stripNamePrefix('juno - hey there', 'Juno')).toBe('hey there');
  });

  it('leaves other text alone (including mid-text names)', () => {
    expect(stripNamePrefix('hey Juno, you around?', 'Juno')).toBe('hey Juno, you around?');
    expect(stripNamePrefix('plain line', 'Juno')).toBe('plain line');
  });

  it('removes IRC-style bracket labels too (live: "[Dex] …")', () => {
    expect(stripNamePrefix('[Dex] compiling', 'Dex')).toBe('compiling');
    expect(stripNamePrefix('<Dex> compiling', 'Dex')).toBe('compiling');
    expect(stripNamePrefix('(Dex): compiling', 'Dex')).toBe('compiling');
    expect(stripNamePrefix('[Dex]', 'Dex')).toBe('');
  });
});

describe('cutAtNextSpeaker', () => {
  const labels = ['Caius', 'Cai', 'Mira', 'Dex', 'Juno', 'Satchel'];

  it('cuts the live regression: a fake "(system)" line, then a fake turn', () => {
    const live = 'omg yes the jukebox is BACK\n(system)\nJuno: *back again* Hello and we are so back';
    expect(cutAtNextSpeaker(live, labels)).toBe('omg yes the jukebox is BACK');
  });

  it('cuts at a later line labelled with any speaker, alias, or human', () => {
    expect(cutAtNextSpeaker('ha, fair\nCaius: you would say that', labels)).toBe('ha, fair');
    expect(cutAtNextSpeaker('ha, fair\ncai: nope', labels)).toBe('ha, fair');
    expect(cutAtNextSpeaker('sure thing\nSatchel: thanks!', labels)).toBe('sure thing');
    expect(cutAtNextSpeaker('ok\nuser: and then?', labels)).toBe('ok');
  });

  it('cuts bracket/angle-labelled turns even on the first line (never addressing)', () => {
    expect(cutAtNextSpeaker('<Caius> hey all', labels)).toBe('');
    expect(cutAtNextSpeaker('lol\n[Mira] totally', labels)).toBe('lol');
    expect(cutAtNextSpeaker('[Mira has joined #cafe]', labels)).toBe(''); // still a fake event
  });

  it('cuts fake room events, and a reply that is nothing but one empties out', () => {
    expect(cutAtNextSpeaker('night!\n* Mira has quit (bed) *', labels)).toBe('night!');
    expect(cutAtNextSpeaker('[Dex has joined #cafe]', labels)).toBe('');
    expect(cutAtNextSpeaker('* Dex was kicked by Satchel *', labels)).toBe('');
  });

  it('keeps IRC-style addressing on the first line and ordinary multi-line replies', () => {
    expect(cutAtNextSpeaker('Mira: totally, that chapter wrecked me', labels)).toBe(
      'Mira: totally, that chapter wrecked me',
    );
    expect(cutAtNextSpeaker('wait\nDex has left already?', labels)).toBe('wait\nDex has left already?');
    expect(cutAtNextSpeaker('two things:\n1. coffee\n2. more coffee', labels)).toBe(
      'two things:\n1. coffee\n2. more coffee',
    );
    expect(cutAtNextSpeaker('*sips coffee* morning', labels)).toBe('*sips coffee* morning');
  });
});
