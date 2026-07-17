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
  /** Returns false when the frame was dropped (socket not open) — callers should
   *  surface that rather than let a message vanish silently. */
  send(msg: ClientMsg): boolean;
  onMessage(cb: (m: ServerMsg) => void): void;
  /** Fired once when the connection is terminally gone (user close excluded):
   *  reconnect attempts exhausted, or closed before ever being welcomed. */
  onClose(cb: () => void): void;
  isHost(): boolean;
  close(): void;
}

/** Single-player: does nothing. Lets the store stay transport-agnostic. */
export class LocalTransport implements Transport {
  async connect(): Promise<void> {}
  send(): boolean {
    return true;
  }
  onMessage(): void {}
  onClose(): void {}
  isHost(): boolean {
    return true;
  }
  close(): void {}
}

const MAX_RECONNECTS = 5;

export class WSTransport implements Transport {
  private ws: WebSocket | null = null;
  private cb: ((m: ServerMsg) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private opts: ConnectOpts | null = null;
  private you = '';
  private hostId = '';
  private userClosed = false;
  private attempts = 0;
  /** Reconnects are only attempted after a first successful welcome — a socket
   *  that never connected must not keep retrying behind the caller's back. */
  private hadWelcome = false;
  private terminalFired = false;

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
          this.hadWelcome = true;
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
        if (this.userClosed) return;
        // Never welcomed → the initial connect failed; don't retry in the
        // background (an orphaned reconnect could later hijack the caller).
        if (!this.hadWelcome) return;
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.userClosed) return;
    if (this.attempts >= MAX_RECONNECTS) {
      this.fireTerminal();
      return;
    }
    this.attempts += 1;
    setTimeout(
      () => {
        if (!this.userClosed) void this.open(false).catch(() => {});
      },
      400 * this.attempts, // linear backoff
    );
  }

  private fireTerminal(): void {
    if (this.terminalFired) return;
    this.terminalFired = true;
    this.closeCb?.();
  }

  send(msg: ClientMsg): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  onMessage(cb: (m: ServerMsg) => void): void {
    this.cb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
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
