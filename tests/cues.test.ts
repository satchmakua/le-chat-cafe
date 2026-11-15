import { describe, it, expect } from 'vitest';
import { countsAsUnread, cueFor, newlyFinal, pickCue, titleFor } from '../src/util/cues';
import { formatLog, logFilename } from '../src/util/exportLog';
import type { Message, Persona } from '../src/core/types';
import mira from '../src/personas/mira.json';
import dex from '../src/personas/dex.json';

const m = (id: string, author: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  channelId: 'cafe',
  author,
  text,
  ts: 0,
  ...extra,
});
const mine = (a: string) => a === 'user';
const ctx = { me: 'Satchel', mine };

describe('newlyFinal', () => {
  it('a streamed turn counts once — when it finishes, not when it starts', () => {
    const pending = m('a', 'mira', 'hel', { pending: true });
    const done = m('a', 'mira', 'hello');
    expect(newlyFinal([], [pending])).toEqual([]);
    expect(newlyFinal([pending], [done])).toEqual([done]);
    expect(newlyFinal([done], [done, m('b', 'user', 'hi')]).map((x) => x.id)).toEqual(['b']);
  });
});

describe('cueFor', () => {
  it('doors for comings and goings', () => {
    expect(cueFor(m('j', 'system', '* Mira has joined #cafe *', { presence: { who: 'mira', state: 'join' } }), ctx)).toBe('door-open');
    expect(cueFor(m('l', 'system', '* Dex has quit *', { presence: { who: 'dex', state: 'leave' } }), ctx)).toBe('door-close');
  });

  it('a chime when someone says your name or DMs you — never for your own lines', () => {
    expect(cueFor(m('a', 'mira', 'Satchel, you around?'), ctx)).toBe('chime');
    expect(cueFor(m('b', 'mira', 'psst', { channelId: 'dm:mira' }), ctx)).toBe('chime');
    expect(cueFor(m('c', 'human:2', 'hey satchel'), ctx)).toBe('chime');
    expect(cueFor(m('d', 'user', 'Satchel here', { channelId: 'dm:mira' }), ctx)).toBeNull();
    expect(cueFor(m('e', 'mira', 'nice weather'), ctx)).toBeNull();
    expect(cueFor(m('f', 'system', '* topic set: Satchel *'), ctx)).toBeNull();
    expect(cueFor(m('g', 'mira', 'Satchel?'), { me: '', mine })).toBeNull(); // no nick, no mention
  });

  it('one sound per update, the most important', () => {
    expect(pickCue(['door-close', 'chime', null])).toBe('chime');
    expect(pickCue(['door-close', 'door-open'])).toBe('door-open');
    expect(pickCue([null])).toBeNull();
  });
});

describe('tab title', () => {
  it('counts other people talking, and reads (n) le-chat-cafe', () => {
    expect(countsAsUnread(m('a', 'mira', 'hi'), mine)).toBe(true);
    expect(countsAsUnread(m('b', 'user', 'hi'), mine)).toBe(false);
    expect(countsAsUnread(m('c', 'system', '* Mira has joined *'), mine)).toBe(false);
    expect(titleFor(0)).toBe('le-chat-cafe');
    expect(titleFor(3)).toBe('(3) le-chat-cafe');
  });
});

describe('/export log format', () => {
  const personas = [mira, dex] as Persona[];
  const at = (day: number, h: number, min: number) => new Date(2026, 10, day, h, min).getTime();

  it('writes an IRC-style log: header, day changes, <nick> lines, * events', () => {
    const log = formatLog(
      [
        m('0', 'system', '* welcome to le-chat-cafe *', { notice: true, ts: at(14, 23, 58) }),
        m('1', 'system', '* Mira has joined #cafe *', { ts: at(14, 23, 59), presence: { who: 'mira', state: 'join' } }),
        m('2', 'mira', 'Mira: evening!\nanyone up?', { ts: at(14, 23, 59) }),
        m('3', 'user', 'me, sadly', { ts: at(15, 0, 1) }),
        m('4', 'dex', '§{"user": 0.1}', { ts: at(15, 0, 2) }), // leaked markup: dropped
        m('5', 'dex', 'same', { ts: at(15, 0, 2), pending: true }),
      ],
      { label: '#cafe', personas, nameOf: () => 'Satchel', now: at(15, 0, 5) },
    );
    expect(log).toBe(
      [
        `--- le-chat-cafe · #cafe · exported ${new Date(at(15, 0, 5)).toDateString()} 00:05`,
        `--- Day changed ${new Date(at(14, 0, 0)).toDateString()}`,
        '[23:59] * Mira has joined #cafe',
        '[23:59] <Mira> evening!',
        '[23:59] <Mira> anyone up?',
        `--- Day changed ${new Date(at(15, 0, 0)).toDateString()}`,
        '[00:01] <Satchel> me, sadly',
        '',
      ].join('\n'),
    );
  });

  it('names the file for the channel (or the DM persona) and the date', () => {
    expect(logFilename('arcade', new Date(2026, 10, 15).getTime())).toBe('le-chat-cafe-arcade-2026-11-15.log');
    expect(logFilename('dm:mira', new Date(2026, 0, 5).getTime())).toBe('le-chat-cafe-mira-2026-01-05.log');
  });
});
