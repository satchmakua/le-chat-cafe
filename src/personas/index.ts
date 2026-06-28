import type { Persona } from '../core/types';

// Personas are data, not code (DESIGN §1): adding one is dropping a JSON file in
// this folder. Vite's glob import picks them up at build time — no registry to
// edit. Sorted by filename for a stable roster/nick-list order.
const modules = import.meta.glob<{ default: Persona }>('./*.json', { eager: true });

export const personas: Persona[] = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, mod]) => mod.default);
