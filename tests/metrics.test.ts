import { describe, it, expect } from 'vitest';
import { avgWords, jaccard, meanPairwiseOverlap, wordSet } from '../src/eval/metrics';

describe('eval metrics', () => {
  it('wordSet tokenizes to lowercased unique words', () => {
    expect(wordSet('The cat, the CAT!')).toEqual(new Set(['the', 'cat']));
  });

  it('jaccard measures vocab similarity', () => {
    expect(jaccard(wordSet('a b c'), wordSet('a b c'))).toBe(1);
    expect(jaccard(wordSet('a b'), wordSet('c d'))).toBe(0);
    expect(jaccard(wordSet('a b'), wordSet('b c'))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('avgWords averages word counts across replies', () => {
    expect(avgWords(['one two', 'three four five', ''])).toBeCloseTo((2 + 3 + 0) / 3);
    expect(avgWords([])).toBe(0);
  });

  it('meanPairwiseOverlap is lower for distinct vocabularies', () => {
    const distinct = [wordSet('apple pie'), wordSet('rocket ship'), wordSet('green moss')];
    const samey = [wordSet('hello there'), wordSet('hello there'), wordSet('hello friend')];
    expect(meanPairwiseOverlap(distinct)).toBeLessThan(meanPairwiseOverlap(samey));
    expect(meanPairwiseOverlap([wordSet('solo')])).toBe(0); // needs ≥2
  });
});
