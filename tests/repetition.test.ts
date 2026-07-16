import { describe, it, expect } from 'vitest';
import {
  isEcho,
  normalizeWords,
  overlapRatio,
  sentences,
  stripNamePrefix,
} from '../src/runtime/repetition';

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

describe('stripNamePrefix', () => {
  it('removes a leading self-name prefix in common shapes', () => {
    expect(stripNamePrefix('Juno: 🍪 bacon rolls!', 'Juno')).toBe('🍪 bacon rolls!');
    expect(stripNamePrefix('juno - hey there', 'Juno')).toBe('hey there');
  });

  it('leaves other text alone (including mid-text names)', () => {
    expect(stripNamePrefix('hey Juno, you around?', 'Juno')).toBe('hey Juno, you around?');
    expect(stripNamePrefix('plain line', 'Juno')).toBe('plain line');
  });
});
