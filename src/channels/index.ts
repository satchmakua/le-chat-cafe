import type { Channel } from '../core/types';
import { HOME } from '../core/channels';

// Channels are data, like personas (DESIGN §12.4): adding one is dropping a JSON file
// in this folder. Home (#cafe) always lists first; the rest sort by id.
const modules = import.meta.glob<{ default: Channel }>('./*.json', { eager: true });

export const channels: Channel[] = Object.values(modules)
  .map((mod) => mod.default)
  .sort((a, b) => Number(b.id === HOME) - Number(a.id === HOME) || a.id.localeCompare(b.id));
