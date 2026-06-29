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

const MAX_RECONNECTS = 5;

export class WSTransport implements Transport {
  private ws: WebSocket | null = null;
  private cb: ((m: ServerMsg) => void) | null = null;
  private opts: ConnectOpts | null = null;
  private you = '';
  private hostId = '';
  private userClosed = false;
  private attempts = 0;

  connect(opts: ConnectOpts): Promise<void> {
    this.opts = opts;
    this.userClosed = false;
    return this.open(true);
  }

  /** Open a socket + wire listeners. `initial` rejects on failure; reconnects don't. */
  private open(initial: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const opts = this.opts;
      if (!opts) return reject(new Error('not configured'));
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
          this.attempts = 0; // a clean welcome resets the backoff
          resolve(); // ready once the relay welcomes us (also fires after a reconnect resync)
        } else if (msg.t === 'presence') {
          const me = msg.participants.find((p) => p.id === this.you);
          if (me?.isHost) this.hostId = this.you;
        }
        this.cb?.(msg);
      });

      ws.addEventListener('error', () => {
        if (initial) reject(new Error('relay connection failed'));
      });

      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null;
        if (!this.userClosed) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.userClosed || this.attempts >= MAX_RECONNECTS) return;
    this.attempts += 1;
    setTimeout(
      () => {
        if (!this.userClosed) void this.open(false).catch(() => {});
      },
      400 * this.attempts, // linear backoff
    );
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
    this.userClosed = true;
    this.ws?.close();
    this.ws = null;
  }
}
