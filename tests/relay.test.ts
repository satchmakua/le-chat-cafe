import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createRelay, type Relay } from '../server/relay';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';
import type { Message } from '../src/core/types';

let relay: Relay | null = null;
afterEach(async () => {
  await relay?.close();
  relay = null;
});

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function next(ws: WebSocket, pred: (m: ServerMsg) => boolean): Promise<ServerMsg> {
  return new Promise((resolve) => {
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      if (pred(msg)) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

const sendC = (ws: WebSocket, m: ClientMsg) => ws.send(JSON.stringify(m));
const isWelcome = (m: ServerMsg): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome';

describe('relay (two-client integration)', () => {
  it('broadcasts a human message from one client to the other in the same room', async () => {
    relay = await createRelay({ port: 0 });
    const url = `ws://localhost:${relay.port}`;
    const a = await open(url);
    const b = await open(url);

    const aWelcome = next(a, isWelcome);
    sendC(a, { t: 'hello', room: 'cafe', name: 'Ann', canHost: true });
    const wa = (await aWelcome) as Extract<ServerMsg, { t: 'welcome' }>;

    const bWelcome = next(b, isWelcome);
    sendC(b, { t: 'hello', room: 'cafe', name: 'Bob', canHost: false });
    await bWelcome;

    const bGetsMessage = next(b, (m) => m.t === 'message');
    const message: Message = { id: 'm1', channelId: 'cafe', author: wa.you, text: 'hi bob', ts: Date.now() };
    sendC(a, { t: 'say', message });

    const received = (await bGetsMessage) as Extract<ServerMsg, { t: 'message' }>;
    expect(received.message.text).toBe('hi bob');
    expect(received.message.author).toBe(wa.you);
    expect(received.seq).toBe(1);

    a.close();
    b.close();
  });

  it('makes the first canHost client the host and reports it in presence', async () => {
    relay = await createRelay({ port: 0 });
    const url = `ws://localhost:${relay.port}`;
    const a = await open(url);
    const aWelcome = next(a, isWelcome);
    sendC(a, { t: 'hello', room: 'r', name: 'Ann', canHost: true });
    const wa = (await aWelcome) as Extract<ServerMsg, { t: 'welcome' }>;
    expect(wa.hostId).toBe(wa.you); // first canHost becomes host

    const presenceTwo = next(a, (m) => m.t === 'presence' && m.participants.length === 2);
    const b = await open(url);
    sendC(b, { t: 'hello', room: 'r', name: 'Bob', canHost: true });
    const pres = (await presenceTwo) as Extract<ServerMsg, { t: 'presence' }>;
    expect(pres.participants.find((p) => p.isHost)?.name).toBe('Ann');

    a.close();
    b.close();
  });

  it('rebroadcasts live stream frames without storing them in the log', async () => {
    relay = await createRelay({ port: 0 });
    const url = `ws://localhost:${relay.port}`;
    const a = await open(url);
    const b = await open(url);
    const aw = next(a, isWelcome);
    sendC(a, { t: 'hello', room: 'cafe', name: 'Ann', canHost: true });
    await aw;
    sendC(b, { t: 'hello', room: 'cafe', name: 'Bob', canHost: false });
    await next(b, isWelcome);

    // A streams a partial persona turn; B should get a 'stream' (not 'message').
    const bStream = next(b, (m) => m.t === 'stream');
    sendC(a, { t: 'stream', message: { id: 'p1', channelId: 'cafe', author: 'caius', text: 'hel', ts: 1, pending: true } });
    const streamed = (await bStream) as Extract<ServerMsg, { t: 'stream' }>;
    expect(streamed.message.text).toBe('hel');

    // A finalizes with 'say'; B gets the canonical ordered 'message'.
    const bMsg = next(b, (m) => m.t === 'message');
    sendC(a, { t: 'say', message: { id: 'p1', channelId: 'cafe', author: 'caius', text: 'hello', ts: 2 } });
    await bMsg;

    // A late joiner's snapshot has exactly the final (streams are never stored).
    const c = await open(url);
    const cw = next(c, isWelcome);
    sendC(c, { t: 'hello', room: 'cafe', name: 'Cara', canHost: false });
    const wc = (await cw) as Extract<ServerMsg, { t: 'welcome' }>;
    expect(wc.log.filter((m) => m.id === 'p1')).toHaveLength(1);
    expect(wc.log.find((m) => m.id === 'p1')?.text).toBe('hello');

    a.close();
    b.close();
    c.close();
  });

  it('hands host off to a remaining member when the host leaves', async () => {
    relay = await createRelay({ port: 0 });
    const url = `ws://localhost:${relay.port}`;
    const a = await open(url);
    const aw = next(a, isWelcome);
    sendC(a, { t: 'hello', room: 'cafe', name: 'Ann', canHost: true });
    await aw;
    const b = await open(url);
    const bw = next(b, isWelcome);
    sendC(b, { t: 'hello', room: 'cafe', name: 'Bob', canHost: true });
    const wb = (await bw) as Extract<ServerMsg, { t: 'welcome' }>;
    expect(wb.hostId).not.toBe(wb.you); // Ann is host, not Bob

    // Ann (host) leaves → relay promotes Bob and tells him via presence.
    const bBecomesHost = next(b, (m) => m.t === 'presence' && !!m.participants.find((p) => p.id === wb.you)?.isHost);
    a.close();
    const pres = (await bBecomesHost) as Extract<ServerMsg, { t: 'presence' }>;
    expect(pres.participants.find((p) => p.isHost)?.name).toBe('Bob');

    b.close();
  });
});
