import 'fake-indexeddb/auto'; // polyfill global indexedDB before db.ts uses it
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearAll,
  getKV,
  loadMemory,
  loadMessages,
  saveMemory,
  saveMessage,
  setKV,
} from '../src/persist/db';
import type { Message, PersonaMemory } from '../src/core/types';

const m = (id: string, ts: number): Message => ({
  id,
  channelId: 'cafe',
  author: 'user',
  text: `msg ${id}`,
  ts,
});

beforeEach(async () => {
  await clearAll();
});

describe('persistence (idb round-trips)', () => {
  it('returns messages ordered by timestamp regardless of insert order', async () => {
    await saveMessage(m('b', 200));
    await saveMessage(m('a', 100));
    await saveMessage(m('c', 300));
    const all = await loadMessages();
    expect(all.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('updates a message in place by id (pending → finalized)', async () => {
    await saveMessage({ ...m('x', 1), text: 'first', pending: true });
    await saveMessage({ ...m('x', 1), text: 'final', pending: false });
    const all = await loadMessages();
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe('final');
    expect(all[0].pending).toBe(false);
  });

  it('round-trips per-persona memory', async () => {
    const mem: PersonaMemory = { personaId: 'caius', notes: ['likes coffee'], lastSummarizedTs: 5 };
    await saveMemory(mem);
    expect(await loadMemory()).toEqual([mem]);
  });

  it('round-trips kv values and clears everything', async () => {
    await setKV('summarizedCount', 42);
    await saveMessage(m('a', 1));
    expect(await getKV<number>('summarizedCount')).toBe(42);

    await clearAll();
    expect(await getKV<number>('summarizedCount')).toBeUndefined();
    expect(await loadMessages()).toEqual([]);
  });
});
