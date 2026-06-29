import { describe, it, expect } from 'vitest';
import {
  affinityPhrase,
  applyDelta,
  baselineAffinity,
  clampDelta,
  decay,
  resolveTarget,
  stripAffinity,
  visibleText,
} from '../src/runtime/affinity';
import type { Persona } from '../src/core/types';

const mk = (id: string, warmth: number): Persona => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  color: '#fff',
  systemPrompt: '',
  model: 'mock',
  params: { temperature: 0.8, topP: 0.9 },
  temperament: { talkativeness: 0.5, warmth, pettiness: 0.2 },
  interests: [],
});

describe('stripAffinity', () => {
  it('extracts deltas and removes the sentinel from the text', () => {
    const { clean, deltas } = stripAffinity('good to see you!\n§aff {"user": 0.05, "mira": -0.02}§');
    expect(clean).toBe('good to see you!');
    expect(deltas).toEqual({ user: 0.05, mira: -0.02 });
  });

  it('returns the text untouched and no deltas when there is no sentinel', () => {
    const { clean, deltas } = stripAffinity('just a normal line');
    expect(clean).toBe('just a normal line');
    expect(deltas).toEqual({});
  });

  it('ignores a malformed sentinel rather than leaking it', () => {
    const { clean, deltas } = stripAffinity('hi §aff {bad json}§');
    expect(clean).toBe('hi');
    expect(deltas).toEqual({});
  });
});

describe('visibleText', () => {
  it('hides everything from the sentinel marker onward (mid-stream safety)', () => {
    expect(visibleText('hello there §aff {"user')).toBe('hello there');
    expect(visibleText('no sentinel yet')).toBe('no sentinel yet');
  });
});

describe('delta math', () => {
  it('clampDelta caps magnitude at ±0.15', () => {
    expect(clampDelta(0.9)).toBe(0.15);
    expect(clampDelta(-0.9)).toBe(-0.15);
    expect(clampDelta(0.04)).toBeCloseTo(0.04);
  });

  it('applyDelta clamps the delta then keeps the result in [-1, 1]', () => {
    expect(applyDelta(0.95, 0.9)).toBe(1); // 0.95 + 0.15 capped at 1
    expect(applyDelta(0, 0.05)).toBeCloseTo(0.05);
    expect(applyDelta(-0.95, -0.9)).toBe(-1);
  });

  it('decay moves affinity toward 0', () => {
    expect(decay(0.5)).toBeCloseTo(0.49);
    expect(decay(-0.5)).toBeCloseTo(-0.49);
  });
});

describe('baselineAffinity & phrasing', () => {
  it('baseline toward user is warmth-derived, peers neutral', () => {
    expect(baselineAffinity(mk('mira', 0.85), 'user')).toBeCloseTo(0.35);
    expect(baselineAffinity(mk('dex', 0.3), 'user')).toBeCloseTo(-0.2);
    expect(baselineAffinity(mk('caius', 0.6), 'caius')).toBe(0); // peer
  });

  it('affinityPhrase spans warm → cold', () => {
    expect(affinityPhrase(0.7, 'the user')).toContain('warmly');
    expect(affinityPhrase(0, 'the user')).toContain('neutral');
    expect(affinityPhrase(-0.8, 'the user')).toContain('cold');
  });
});

describe('resolveTarget', () => {
  const personas = [mk('caius', 0.6), mk('mira', 0.85)];
  it('resolves user, ids, and names; rejects unknowns', () => {
    expect(resolveTarget('user', personas)).toBe('user');
    expect(resolveTarget('Mira', personas)).toBe('mira'); // by name
    expect(resolveTarget('caius', personas)).toBe('caius'); // by id
    expect(resolveTarget('ghost', personas)).toBeNull();
  });
});
