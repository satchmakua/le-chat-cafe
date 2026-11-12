import { describe, it, expect } from 'vitest';
import { affinityLabel, ago, buildProfile, type ProfileContext } from '../src/runtime/profile';
import type { Message, Persona } from '../src/core/types';

const mk = (id: string, bio?: string): Persona => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  color: '#fff',
  bio,
  systemPrompt: '',
  model: 'mock',
  params: { temperature: 0.8, topP: 0.9 },
  temperament: { talkativeness: 0.5, warmth: 0.5, pettiness: 0.2 },
  interests: ['books'],
});

const roster = [mk('mira', 'Asks the follow-up question.'), mk('caius'), mk('dex'), mk('juno'), mk('ada')];
const feelings: Record<string, number> = {
  'mira:user': 0.65,
  'mira:caius': 0.1,
  'mira:dex': -0.45,
  'mira:juno': 0.3,
  'mira:ada': 0.05,
};
const msg = (author: string, ts: number, pending = false): Message => ({
  id: `${author}${ts}`,
  channelId: 'cafe',
  author,
  text: 'hi',
  ts,
  pending,
});

function ctx(over: Partial<ProfileContext> = {}): ProfileContext {
  return {
    personas: roster,
    messages: [msg('mira', 10), msg('user', 20), msg('mira', 30, true)],
    online: new Set(roster.map((p) => p.id)),
    muted: [],
    notes: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
    model: 'qwen2.5:7b-instruct',
    affinityOf: (from, to) => feelings[`${from}:${to}`] ?? 0,
    ...over,
  };
}

describe('affinityLabel', () => {
  it('maps the affinity bands to one word', () => {
    expect([0.7, 0.3, 0, -0.3, -0.8].map(affinityLabel)).toEqual(['fond', 'friendly', 'neutral', 'guarded', 'cold']);
  });
});

describe('buildProfile', () => {
  it('reads bio, feelings toward you, model, and recent notes', () => {
    const p = buildProfile(roster[0], ctx());
    expect(p.bio).toBe('Asks the follow-up question.');
    expect(p.towardYou).toEqual({ value: 0.65, label: 'fond' });
    expect(p.model).toBe('qwen2.5:7b-instruct');
    expect(p.remembers).toEqual(['n2', 'n3', 'n4', 'n5', 'n6']); // last five, newest last
  });

  it('lists the strongest feelings about the others first, top three, never itself', () => {
    const p = buildProfile(roster[0], ctx());
    expect(p.peers.map((f) => f.id)).toEqual(['dex', 'juno', 'caius']);
    expect(p.peers[0].label).toBe('guarded');
  });

  it('status is kicked, away, or here', () => {
    expect(buildProfile(roster[0], ctx({ muted: ['mira'] })).status).toBe('kicked');
    expect(buildProfile(roster[0], ctx({ online: new Set(['caius']) })).status).toBe('away');
    expect(buildProfile(roster[0], ctx()).status).toBe('here');
  });

  it('last spoke ignores a still-streaming line; no bio reads as empty', () => {
    expect(buildProfile(roster[0], ctx()).lastSpokeTs).toBe(10);
    expect(buildProfile(roster[2], ctx()).lastSpokeTs).toBeNull();
    expect(buildProfile(roster[2], ctx()).bio).toBe('');
  });
});

describe('ago', () => {
  it('renders coarse relative times', () => {
    const now = 1_000_000_000;
    expect(ago(now - 20_000, now)).toBe('just now');
    expect(ago(now - 4 * 60_000, now)).toBe('4m ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(ago(now - 3 * 86_400_000, now)).toBe('3d ago');
  });
});
