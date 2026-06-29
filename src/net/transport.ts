// Transport port (DESIGN §11) — mirrors LLMProvider. The store routes outbound
// messages through a Transport and ingests inbound ones. LocalTransport is the
// single-player no-op (so offline behavior is byte-identical); WSTransport talks
// to the relay over the browser-native WebSocket.

import type { ClientMsg, ServerMsg } from './protocol';

export interface ConnectOpts {
  url: string;
  room: string;
  name: string;
  canHost: boolean;
}

export interface Transport {
  connect(opts: ConnectOpts): Promise<void>;
  send(msg: ClientMsg): void;
  onMessage(cb: (m: ServerMsg) => void): void;
  isHost(): boolean;
  close(): void;
}

/** Single-player: does nothing. Lets the store stay transport-agnostic. */
export class LocalTransport implements Transport {
  async connect(): Promise<void> {}
  send(): void {}
  onMessage(): void {}
  isHost(): boolean {
    return true;
  }
  close(): void {}
}

export class WSTransport implements Transport {
  private ws: WebSocket | null = null;
  private cb: ((m: ServerMsg) => void) | null = null;
  private you = '';
  private hostId = '';

  connect(opts: ConnectOpts): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(opts.url);
      this.ws = ws;

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ t: 'hello', room: opts.room, name: opts.name, canHost: opts.canHost }));
      });

      ws.addEventListener('message', (ev) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMsg;
        } catch {
          return;
        }
        if (msg.t === 'welcome') {
          this.you = msg.you;
          this.hostId = msg.hostId;
          resolve(); // connection is ready once the relay welcomes us
        } else if (msg.t === 'presence') {
          const me = msg.participants.find((p) => p.id === this.you);
          if (me?.isHost) this.hostId = this.you;
        }
        this.cb?.(msg);
      });

      ws.addEventListener('error', () => reject(new Error('relay connection failed')));
      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null;
      });
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onMessage(cb: (m: ServerMsg) => void): void {
    this.cb = cb;
  }

  isHost(): boolean {
    return this.you !== '' && this.you === this.hostId;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
