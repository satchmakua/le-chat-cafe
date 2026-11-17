import 'fake-indexeddb/auto'; // polyfill global indexedDB before db.ts uses it
import { describe, it, expect, vi } from 'vitest';
import type { Message } from '../src/core/types';

// `init` runs once per module (it guards against StrictMode's double call), so each
// scenario imports a fresh store. No Ollama in tests: the probe fails → MockProvider.
vi.stubGlobal('fetch', () => Promise.reject(new Error('no Ollama in tests')));

async function freshStore() {
  vi.resetModules();
  const db = await import('../src/persist/db');
  const { useRoom } = await import('../src/state/store');
  return { db, useRoom };
}

const line = (id: string, channelId: string, author: string, text: unknown, ts: number) =>
  ({ id, channelId, author, text, ts }) as Message;

describe('hydrate (DESIGN §6.2, §12.4)', () => {
  it('reopens the window you left, with channels, DMs, and topics; drops malformed rows', async () => {
    const { db, useRoom } = await freshStore();
    await db.clearAll();
    await db.saveMessage(line('a', 'cafe', 'user', 'hi cafe', 1));
    await db.saveMessage(line('b', 'arcade', 'user', 'hi arcade', 2));
    await db.saveMessage(line('c', 'dm:mira', 'mira', 'psst', 3));
    // A presence line whose text is an object — what a half-applied edit once wrote.
    await db.saveMessage(line('bad', 'cafe', 'system', { who: 'mira', state: 'leave' }, 4));
    await db.setKV('joined', ['cafe', 'arcade', 'nowhere']);
    await db.setKV('dms', ['mira', 'ghost']);
    await db.setKV('channel', 'dm:mira');
    await db.setKV('topics', { arcade: 'speedrun night' });

    await useRoom.getState().init();
    const s = useRoom.getState();
    expect(s.channel).toBe('dm:mira');
    expect(s.messages.map((m) => m.text)).toEqual(['psst']);
    expect(s.logs.cafe.map((m) => m.id)).toEqual(['a']); // the bad row is gone
    expect(s.logs.arcade.map((m) => m.id)).toEqual(['b']);
    expect(s.joined).toEqual(['cafe', 'arcade']); // unknown channels dropped
    expect(s.dms).toEqual(['mira']); // unknown personas dropped
    expect(s.topics).toEqual({ arcade: 'speedrun night' });
    await new Promise((r) => setTimeout(r, 20));
    expect((await db.loadMessages()).some((m) => m.id === 'bad')).toBe(false); // deleted for good
  });

  it('carries the pre-channels cursor and topic over to #cafe', async () => {
    const { db, useRoom } = await freshStore();
    await db.clearAll();
    await db.saveMessage(line('a', 'cafe', 'user', 'old times', 1));
    await db.setKV('summarizedCount', 42);
    await db.setKV('topic', 'the old topic');

    await useRoom.getState().init();
    const s = useRoom.getState();
    expect(s.channel).toBe('cafe');
    expect(s.summarized).toEqual({ cafe: 42 });
    // No Ollama → the room is offline and says so; it never falls back to canned lines.
    expect(s.providerKind).toBe('offline');
    expect(s.ready).toBe(true);
    expect(s.topics).toEqual({ cafe: 'the old topic' });
  });
});
