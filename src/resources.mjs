import { Transform } from 'node:stream';

export function createLimiter(maxEntries) {
  const entries = new Map();
  return (key, maximum, now = Date.now()) => {
    for (const [k, record] of entries) if (now - record.at >= 60000) entries.delete(k);
    let record = entries.get(key);
    if (!record) {
      if (entries.size >= maxEntries) return false;
      record = { at: now, count: 0 }; entries.set(key, record);
    }
    return ++record.count <= maximum;
  };
}

/** Concurrent phone streams (each one TLS session = one tunnel channel), bounded globally and per computer. */
export function createCapacity(options) {
  const hosts = new Map();
  let streams = 0;
  return {
    snapshot: () => ({ streams }),
    acquire(id) {
      const host = hosts.get(id) ?? { streams: 0 };
      if (streams >= options.maxRequests || host.streams >= options.maxRequestsPerHost) return;
      hosts.set(id, host); streams++; host.streams++;
      let released = false;
      return () => {
        if (released) return;
        released = true; streams--; host.streams--;
        if (!host.streams) hosts.delete(id);
      };
    },
  };
}

/** Each transform has at most one incoming chunk and one timer in flight. */
export class Transfer extends Transform {
  constructor({ rate = 0, maximum = Infinity, progress = () => {} } = {}) {
    super({ highWaterMark: 32768 });
    this.rate = rate; this.maximum = maximum; this.progress = progress; this.bytes = 0;
  }
  _transform(data, encoding, done) {
    this.bytes += data.length;
    if (this.bytes > this.maximum) { const error = new Error('payload_too_large'); error.code = 'BODY_LIMIT'; done(error); return; }
    if (!this.rate) { this.progress(data.length); done(null, data); return; }
    let offset = 0;
    const step = () => {
      if (this.destroyed) return;
      const end = Math.min(data.length, offset + Math.max(1, Math.floor(this.rate / 10)));
      const piece = data.subarray(offset, end); offset = end;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.destroyed) return;
        this.progress(piece.length);
        const ready = this.push(piece);
        if (offset === data.length) { this.pending = undefined; done(); }
        else if (ready) step();
        else this.resumeChunk = step;
      }, Math.ceil(piece.length / this.rate * 1000));
    };
    this.pending = done; step();
  }
  _read(size) {
    super._read(size);
    if (this.resumeChunk) { const next = this.resumeChunk; this.resumeChunk = undefined; next(); }
  }
  _destroy(error, done) {
    clearTimeout(this.timer); this.resumeChunk = undefined;
    if (this.pending) { const pending = this.pending; this.pending = undefined; pending(error ?? new Error('transfer_closed')); }
    done(error);
  }
}
