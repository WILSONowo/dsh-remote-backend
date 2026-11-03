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

export function createCapacity(options) {
  const hosts = new Map();
  let requests = 0, files = 0;
  return {
    snapshot: () => ({ requests, files }),
    acquire(id, file) {
      const host = hosts.get(id) ?? { requests: 0, files: 0 };
      if (requests >= options.maxRequests || host.requests >= options.maxRequestsPerHost ||
          file && (files >= options.maxFiles || host.files >= options.maxFilesPerHost)) return;
      hosts.set(id, host); requests++; host.requests++;
      if (file) { files++; host.files++; }
      let released = false;
      return () => {
        if (released) return;
        released = true; requests--; host.requests--;
        if (file) { files--; host.files--; }
        if (!host.requests) hosts.delete(id);
      };
    },
  };
}

// Explicit file API classification; do not throttle control RPC or event streams.
export const isFileRequest = path => /^\/api\/remote-access\/fs\/(read|write)(?:\?|$)/.test(path);
export const isEventRequest = path => /^\/api\/events\.(mux|host)(?:\?|$)/.test(path);

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
