import { describe, it, expect } from 'vitest';
import {
  HOME,
  channelLabel,
  dmId,
  dmPersonaId,
  findChannel,
  isDm,
  membersOf,
  pickDmSender,
  splitLogs,
} from '../src/core/channels';
import type { Channel, Message, Persona } from '../src/core/types';
import caius from '../src/personas/caius.json';
import dex from '../src/personas/dex.json';
import juno from '../src/personas/juno.json';
import mira from '../src/personas/mira.json';
import arcade from '../src/channels/arcade.json';
import cafe from '../src/channels/cafe.json';
import library from '../src/channels/library.json';

const roster = [caius, dex, juno, mira] as Persona[];
const defs: Channel[] = [cafe, arcade, library];
const ids = (ps: Persona[]) => ps.map((p) => p.id);

describe('channel ids', () => {
  it('round-trips DM ids and tells them from channels', () => {
    expect(dmId('mira')).toBe('dm:mira');
    expect(isDm('dm:mira')).toBe(true);
    expect(isDm(HOME)).toBe(false);
    expect(dmPersonaId('dm:mira')).toBe('mira');
    expect(dmPersonaId('arcade')).toBeNull();
  });

  it('labels channels with # and DMs with @name', () => {
    expect(channelLabel('arcade', roster)).toBe('#arcade');
    expect(channelLabel('dm:mira', roster)).toBe('@Mira');
  });

  it('finds a channel with or without #, in any case', () => {
    expect(findChannel('#Arcade', defs)?.id).toBe('arcade');
    expect(findChannel('library', defs)?.id).toBe('library');
    expect(findChannel('#nowhere', defs)).toBeUndefined();
    expect(findChannel(undefined, defs)).toBeUndefined();
  });
});

describe('membersOf', () => {
  it('reads each crowd from the persona JSON (everyone is home in #cafe)', () => {
    expect(ids(membersOf('cafe', roster))).toEqual(['caius', 'dex', 'juno', 'mira']);
    expect(ids(membersOf('arcade', roster))).toEqual(['caius', 'dex', 'juno']);
    expect(ids(membersOf('library', roster))).toEqual(['dex', 'mira']);
  });

  it('defaults a persona with no channels list to home only', () => {
    const plain = { ...caius, id: 'plain', channels: undefined } as Persona;
    expect(ids(membersOf('cafe', [plain]))).toEqual(['plain']);
    expect(membersOf('arcade', [plain])).toEqual([]);
  });

  it('a DM holds exactly its one persona', () => {
    expect(ids(membersOf('dm:juno', roster))).toEqual(['juno']);
  });
});

describe('splitLogs', () => {
  it('groups one ordered log by channel, keeping order', () => {
    const m = (id: string, channelId: string): Message => ({ id, channelId, author: 'user', text: id, ts: Number(id) });
    const logs = splitLogs([m('1', 'cafe'), m('2', 'dm:mira'), m('3', 'cafe'), m('4', 'arcade')]);
    expect(logs.cafe.map((x) => x.id)).toEqual(['1', '3']);
    expect(logs['dm:mira'].map((x) => x.id)).toEqual(['2']);
    expect(logs.arcade.map((x) => x.id)).toEqual(['4']);
  });
});

describe('pickDmSender', () => {
  const fond = (scores: Record<string, number>) => (id: string) => scores[id] ?? 0;

  it('only someone who likes you (≥ 0.4) ever writes first', () => {
    const none = pickDmSender(roster, fond({ mira: 0.39, caius: 0.1 }), new Set(), HOME, () => 0);
    expect(none).toBeNull();
    const mira = pickDmSender(roster, fond({ mira: 0.6 }), new Set(), HOME, () => 0);
    expect(mira?.id).toBe('mira');
  });

  it('skips the busy or kicked, and whoever you are already talking to', () => {
    const scores = fond({ mira: 0.8 });
    expect(pickDmSender(roster, scores, new Set(['mira']), HOME, () => 0)).toBeNull();
    expect(pickDmSender(roster, scores, new Set(), 'dm:mira', () => 0)).toBeNull();
  });

  it('stays rare: the chance gate fails most draws', () => {
    expect(pickDmSender(roster, fond({ mira: 0.8 }), new Set(), HOME, () => 0.3)).toBeNull();
  });

  it('weights the pick by how warm they feel', () => {
    const scores = fond({ caius: 0.4, mira: 1.6 }); // mira holds 80% of the weight
    const draws = [0, 0.5]; // pass the gate, then land at 50% of the total weight
    const rng = () => draws.shift() ?? 0;
    expect(pickDmSender(roster, scores, new Set(), HOME, rng)?.id).toBe('mira');
  });
});
