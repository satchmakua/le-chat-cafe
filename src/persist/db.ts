// IndexedDB persistence (DESIGN §6.2) via `idb`. Browser-only; everything the
// room needs to survive a reload lives here: the message log, per-persona
// long-term notes, relationships (affinity), and a small key/value store for
// cursors (summarized count, channel topic, schema version).
//
// Personas are NOT persisted — they're data loaded from src/personas/*.json on
// every boot (editing/persisting personas is M4's concern). The store calls
// these helpers fire-and-forget; failures (private mode, quota) degrade to an
// in-memory session rather than crashing the app.

import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { Message, PersonaMemory, Relationship } from '../core/types';

interface CafeDB extends DBSchema {
  messages: { key: string; value: Message; indexes: { 'by-ts': number } };
  memory: { key: string; value: PersonaMemory };
  relationships: { key: [string, string]; value: Relationship };
  kv: { key: string; value: unknown };
}

const DB_NAME = 'le-chat-cafe';
const DB_VERSION = 2; // v2 adds the `relationships` store (M3)

let dbPromise: Promise<IDBPDatabase<CafeDB>> | null = null;

function db(): Promise<IDBPDatabase<CafeDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CafeDB>(DB_NAME, DB_VERSION, {
      // Guarded so it works both for fresh installs and v1 → v2 upgrades.
      upgrade(database) {
        if (!database.objectStoreNames.contains('messages')) {
          const messages = database.createObjectStore('messages', { keyPath: 'id' });
          messages.createIndex('by-ts', 'ts');
        }
        if (!database.objectStoreNames.contains('memory')) {
          database.createObjectStore('memory', { keyPath: 'personaId' });
        }
        if (!database.objectStoreNames.contains('relationships')) {
          database.createObjectStore('relationships', { keyPath: ['from', 'to'] });
        }
        if (!database.objectStoreNames.contains('kv')) {
          database.createObjectStore('kv');
        }
      },
    });
  }
  return dbPromise;
}

// --- messages ---

/** All messages, oldest-first (ordered by the `by-ts` index). */
export async function loadMessages(): Promise<Message[]> {
  return (await db()).getAllFromIndex('messages', 'by-ts');
}

export async function saveMessage(message: Message): Promise<void> {
  await (await db()).put('messages', message);
}

export async function deleteMessage(id: string): Promise<void> {
  await (await db()).delete('messages', id);
}

// --- per-persona long-term memory ---

export async function loadMemory(): Promise<PersonaMemory[]> {
  return (await db()).getAll('memory');
}

export async function saveMemory(memory: PersonaMemory): Promise<void> {
  await (await db()).put('memory', memory);
}

// --- relationships (affinity) ---

export async function loadRelationships(): Promise<Relationship[]> {
  return (await db()).getAll('relationships');
}

export async function saveRelationship(rel: Relationship): Promise<void> {
  await (await db()).put('relationships', rel);
}

// --- key/value cursors ---

export async function getKV<T>(key: string): Promise<T | undefined> {
  return (await db()).get('kv', key) as Promise<T | undefined>;
}

export async function setKV(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key);
}

/** Wipe everything — used by the dev `__cafe.clearHistory()` helper. */
export async function clearAll(): Promise<void> {
  const database = await db();
  await Promise.all([
    database.clear('messages'),
    database.clear('memory'),
    database.clear('relationships'),
    database.clear('kv'),
  ]);
}
