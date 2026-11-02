import { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const WINDOW = 65536;
const CHUNK = 32768;
export const MAX_FRAME = 131072;
/** Version 1: bounded, credit-controlled TCP streams over one authenticated WebSocket. */
export class Tunnel {
  readonly channels = new Map<string, Channel>();
  private heartbeat: NodeJS.Timeout;
  private alive = true;
  constructor(readonly ws: WebSocket, private accept?: (channel: Duplex) => void) {
    ws.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('binary_frame');
        const m = JSON.parse(raw.toString());
        if (typeof m.id !== 'string' || !/^[a-f0-9-]{36}$/.test(m.id)) throw new Error('invalid_id');
        if (m.type === 'open') {
          if (!accept || this.channels.has(m.id) || this.channels.size >= 64) throw new Error('invalid_open');
          const c = new Channel(this, m.id);
          this.channels.set(m.id, c);
          accept(c);
          return;
        }
        const c = this.channels.get(m.id);
        if (!c) return; // In-flight credits / close after cancellation are harmless.
        if (m.type === 'data') {
          if (typeof m.data !== 'string' || m.data.length > 43692 || !/^[A-Za-z0-9+/]*={0,2}$/.test(m.data)) throw new Error('invalid_data');
          c.receive(Buffer.from(m.data, 'base64'));
        } else if (m.type === 'credit') c.credit(m.bytes);
        else if (m.type === 'end') c.push(null);
        else if (m.type === 'close') c.destroy();
        else throw new Error('invalid_type');
      } catch { ws.close(1008, 'Invalid relay frame'); this.destroy(); }
    });
    ws.on('pong', () => { this.alive = true; });
    ws.on('close', () => this.destroy());
    ws.on('error', () => this.destroy());
    this.heartbeat = setInterval(() => {
      if (!this.alive) { ws.terminate(); return; }
      this.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 20000);
    this.heartbeat.unref();
  }
  open(): Duplex {
    if (this.channels.size >= 64 || this.ws.readyState !== WebSocket.OPEN) throw new Error('relay_busy');
    const c = new Channel(this, randomUUID());
    this.channels.set(c.id, c);
    this.send({ type: 'open', id: c.id });
    return c;
  }
  send(message: unknown) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('relay_offline');
    if (this.ws.bufferedAmount > 8 * 1024 * 1024) { this.ws.terminate(); throw new Error('relay_backpressure'); }
    this.ws.send(JSON.stringify(message));
  }
  destroy() {
    clearInterval(this.heartbeat);
    for (const c of this.channels.values()) c.destroy(new Error('relay_disconnected'));
    this.channels.clear();
  }
}
class Channel extends Duplex {
  private available = WINDOW;
  private allowance = WINDOW;
  private withheld = 0;
  private waiting?: { data: Buffer; offset: number; done: (error?: Error | null) => void };
  constructor(private tunnel: Tunnel, readonly id: string) {
    super({ highWaterMark: WINDOW, allowHalfOpen: true });
    // A transport interruption is delivered to HTTP/net consumers; never an uncaught process error.
    this.on('error', () => {});
  }
  receive(data: Buffer) {
    if (!data.length || data.length > CHUNK || data.length > this.allowance || this.readableEnded) throw new Error('flow_control_violation');
    this.allowance -= data.length;
    this.withheld += data.length;
    if (this.push(data)) this.grant();
  }
  private grant() {
    if (!this.withheld || this.destroyed) return;
    const bytes = this.withheld; this.withheld = 0; this.allowance += bytes;
    try { this.tunnel.send({ type: 'credit', id: this.id, bytes }); } catch { this.destroy(); }
  }
  _read() { this.grant(); }
  credit(bytes: number) {
    if (!Number.isInteger(bytes) || bytes <= 0 || this.available + bytes > WINDOW) throw new Error('invalid_credit');
    this.available += bytes; this.flush();
  }
  _write(data: Buffer, _: string, done: (e?: Error | null) => void) {
    this.waiting = { data: Buffer.from(data), offset: 0, done }; this.flush();
  }
  private flush() {
    const w = this.waiting;
    if (!w) return;
    try {
      while (this.available && w.offset < w.data.length) {
        const size = Math.min(CHUNK, this.available, w.data.length - w.offset);
        this.available -= size;
        this.tunnel.send({ type: 'data', id: this.id, data: w.data.subarray(w.offset, w.offset + size).toString('base64') });
        w.offset += size;
      }
      if (w.offset === w.data.length) { this.waiting = undefined; w.done(); }
    } catch { this.waiting = undefined; w.done(new Error('relay_disconnected')); }
  }
  _final(done: (e?: Error | null) => void) {
    try { this.tunnel.send({ type: 'end', id: this.id }); done(); } catch { done(new Error('relay_disconnected')); }
  }
  _destroy(error: Error | null, done: (e?: Error | null) => void) {
    this.tunnel.channels.delete(this.id);
    try { this.tunnel.send({ type: 'close', id: this.id }); } catch {}
    if (this.waiting) { const w = this.waiting; this.waiting = undefined; w.done(error || new Error('channel_closed')); }
    done(error);
  }
}
