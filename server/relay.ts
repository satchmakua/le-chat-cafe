// Thin WebSocket relay (DESIGN §11). Routes messages + tracks presence per room.
// It NEVER talks to Ollama — inference stays on the clients (local-first). The
// relay is the single source of message order: it stamps a monotonic `seq` and
// broadcasts every `say` to all members (including the sender), who append on
// receipt.
//
//   npm run relay         # listens on PORT or 8787
//
// Exports createRelay() so tests can spin it on an ephemeral port.

import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, Participant, ServerMsg } from '../src/net/protocol';
import { DEFAULT_RELAY_PORT, parseFrame } from '../src/net/protocol';
import type { Message } from '../src/core/types';

interface Member {
  socket: WebSocket;
  participant: Participant;
}

interface Room {
  members: Map<string, Member>; // by participant id
  hostId: string | null;
  log: Message[]; // recent message snapshot for joiners
  seq: number;
}

const SNAPSHOT_LIMIT = 200;
let humanCounter = 0;

export interface Relay {
  port: number;
  close: () => Promise<void>;
}

export function createRelay(opts: { port?: number } = {}): Promise<Relay> {
  const wss = new WebSocketServer({ port: opts.port ?? DEFAULT_RELAY_PORT });
  const rooms = new Map<string, Room>();

  const send = (socket: WebSocket, msg: ServerMsg) => socket.send(JSON.stringify(msg));

  const roomOf = (name: string): Room => {
    let room = rooms.get(name);
    if (!room) {
      room = { members: new Map(), hostId: null, log: [], seq: 0 };
      rooms.set(name, room);
    }
    return room;
  };

  const participants = (room: Room): Participant[] =>
    [...room.members.values()].map((m) => ({ ...m.participant, isHost: m.participant.id === room.hostId }));

  const broadcastPresence = (room: Room) => {
    const list = participants(room);
    for (const m of room.members.values()) send(m.socket, { t: 'presence', participants: list });
  };

  wss.on('connection', (socket) => {
    let joined: { room: Room; id: string } | null = null;

    socket.on('message', (data) => {
      const msg = parseFrame<ClientMsg>(data.toString());
      if (!msg) return;

      if (msg.t === 'hello') {
        const room = roomOf(msg.room);
        const id = `human:${++humanCounter}`;
        if (room.hostId === null && msg.canHost) room.hostId = id;
        room.members.set(id, { socket, participant: { id, name: msg.name, kind: 'human' } });
        joined = { room, id };
        send(socket, {
          t: 'welcome',
          you: id,
          hostId: room.hostId ?? '',
          participants: participants(room),
          log: room.log,
        });
        broadcastPresence(room);
        return;
      }

      if (msg.t === 'say' && joined) {
        const { room } = joined;
        room.seq += 1;
        room.log.push(msg.message);
        if (room.log.length > SNAPSHOT_LIMIT) room.log.splice(0, room.log.length - SNAPSHOT_LIMIT);
        const out: ServerMsg = { t: 'message', seq: room.seq, message: msg.message };
        for (const m of room.members.values()) send(m.socket, out);
        return;
      }

      if (msg.t === 'stream' && joined) {
        // Live token update — rebroadcast only, never stored (the final `say`
        // carries the canonical, ordered message).
        const out: ServerMsg = { t: 'stream', message: msg.message };
        for (const m of joined.room.members.values()) send(m.socket, out);
      }
    });

    socket.on('close', () => {
      if (!joined) return;
      const { room, id } = joined;
      room.members.delete(id);
      if (room.hostId === id) {
        // Hand host to whoever's left (M6.2 will make clients react); null if empty.
        room.hostId = room.members.keys().next().value ?? null;
      }
      if (room.members.size === 0) rooms.delete(findRoomName(rooms, room));
      else broadcastPresence(room);
    });
  });

  return new Promise((resolve) => {
    wss.on('listening', () => {
      const address = wss.address();
      const port = typeof address === 'object' && address ? address.port : (opts.port ?? DEFAULT_RELAY_PORT);
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}

function findRoomName(rooms: Map<string, Room>, target: Room): string {
  for (const [name, room] of rooms) if (room === target) return name;
  return '';
}

// CLI entry: `tsx server/relay.ts`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('relay.ts')) {
  const port = Number(process.env.PORT) || DEFAULT_RELAY_PORT;
  void createRelay({ port }).then((relay) => {
    console.log(`le-chat-cafe relay listening on ws://localhost:${relay.port}`);
  });
}
