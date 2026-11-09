// Test-only phone side of relay protocol 2: one WebSocket (dsh-e2e.1) per byte stream.
import http from 'node:http';
import WebSocket, { createWebSocketStream } from 'ws';

export const PROTOCOL = 'dsh-e2e.1';
export const connectUrl = (origin, hostId) => origin.replace(/^http/, 'ws') + '/relay/v2/connect/' + hostId;

/** Opens the relay stream; resolves with the HTTP status the relay answered the upgrade with (101 on success). */
export function upgradeStatus(origin, hostId, { protocols = [PROTOCOL], ca } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(connectUrl(origin, hostId), protocols, { perMessageDeflate: false, ...(ca ? { ca } : {}) });
    ws.once('upgrade', () => { resolve(101); ws.terminate(); });
    ws.once('unexpected-response', (_, res) => { resolve(res.statusCode); res.resume(); ws.terminate(); });
    ws.once('error', error => { if (ws.readyState !== WebSocket.CLOSED) reject(error); });
  });
}

/** Raw duplex over the relay; writes wait for the WebSocket to open. */
export function openStream(origin, hostId, { ca } = {}) {
  const ws = new WebSocket(connectUrl(origin, hostId), PROTOCOL, { perMessageDeflate: false, ...(ca ? { ca } : {}) });
  const stream = limitFrames(createWebSocketStream(ws));
  stream.on('error', () => {});
  stream.ws = ws;
  return stream;
}

/** One HTTP exchange whose bytes (opaque to the relay) travel through a fresh relay stream. */
export function phoneRequest(origin, hostId, path, { method, body, headers = {}, ca, connection } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ path, method: method || (body === undefined ? 'GET' : 'POST'),
      createConnection: connection || (() => openStream(origin, hostId, { ca })),
      headers: { host: 'phone.e2e.dsh.invalid', ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks) }));
      res.on('aborted', () => reject(new Error('Response aborted')));
      res.on('error', reject);
    });
    // Plain WebSocket streams have no socket timeouts; bound the exchange explicitly.
    const timer = setTimeout(() => req.destroy(new Error('Request timeout')), 5000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(body);
  });
}

/** Phones split writes so no WebSocket frame exceeds the 32 KiB relay/plugin frame limit (the app uses 16 KiB). */
export function limitFrames(stream, size = 16384) {
  const write = stream._write.bind(stream);
  stream._write = (chunk, encoding, done) => {
    let offset = 0;
    const next = error => {
      if (error || offset >= chunk.length) return done(error);
      const piece = chunk.subarray(offset, offset + size); offset += size;
      write(piece, encoding, next);
    };
    next();
  };
  return stream;
}
