import http from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { Tunnel, MAX_FRAME } from '../lib/tunnel.js';
import { openRegistry } from './registry.mjs';
import { normalizeOptions, clientAddress, isLoopback } from './config.mjs';
import { createLimiter, createCapacity, Transfer } from './resources.mjs';

/** Must match the computer plugin and the app (dsh-remote docs/e2e-secure-channel.md). */
export const SECURE_PROTOCOL = 'dsh-e2e.1';
export const RELAY_PROTOCOL = 2;
const SECURE_MAX_FRAME = 32768;

const digest = s => createHash('sha256').update(s).digest();
const sendError = (res, status, error) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error })); };
const rejectSocket = (socket, status) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };

/**
 * Only dynamically registered computers can authenticate. Phones reach a computer through
 * /relay/v2/connect/<hostId>: a WebSocket whose binary frames carry TLS records that terminate
 * on the computer. The relay never sees HTTP, credentials or content.
 */
export function createRelayServer(options) {
  options = normalizeOptions(options);
  const { registration, tls, allowInsecureLoopback = false } = options;
  const online = new Map(), sockets = new Set(), probes = new Set();
  const registry = openRegistry(registration.database, registration.maxHosts ?? 1000);
  const rate = createLimiter(options.maxRateEntries), enrollRate = createLimiter(options.maxRateEntries);
  const capacity = createCapacity(options);
  const metrics = { accepted: 0, rejected: 0, timeouts: 0, errors: 0, uploadedBytes: 0, downloadedBytes: 0, revokedConnections: 0, staleConnections: 0 };
  let closing = false, closePromise, registryHealthy = true, lastTouch = 0;
  const agents = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const clients = new WebSocketServer({ noServer: true, maxPayload: SECURE_MAX_FRAME, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(SECURE_PROTOCOL) ? SECURE_PROTOCOL : false });
  const server = tls ? https.createServer(tls) : http.createServer();
  const transportAllowed = req => !!tls || allowInsecureLoopback && isLoopback(req.socket.remoteAddress);
  server.on('connection', socket => {
    if (closing || sockets.size >= options.maxSockets) { metrics.rejected++; socket.destroy(); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  const respond = (res, status, error) => { metrics.rejected++; sendError(res, status, error); };
  const fail = respond;
  const reject = (socket, status) => { metrics.rejected++; rejectSocket(socket, status); };
  const drop = tunnel => { tunnel.destroy(); tunnel.ws.terminate(); };
  const checkRegistry = () => {
    try {
      registry.ready(); registryHealthy = true;
      const touch = Date.now() - lastTouch >= 30000;
      for (const [id, tunnel] of online) {
        if (!registry.tokenHash(id)) { metrics.revokedConnections++; drop(tunnel); }
        else if (touch) registry.touch(id);
      }
      if (touch) lastTouch = Date.now();
    } catch {
      registryHealthy = false;
      for (const tunnel of online.values()) drop(tunnel);
    }
  };
  const registryTimer = setInterval(checkRegistry, options.revocationInterval); registryTimer.unref();
  function source(req) { return clientAddress(req, options.trustProxy); }
  function limit(ip) { return rate(ip, options.requestsPerMinute); }
  server.on('request', (req, res) => { void request(req, res).catch(() => {
    metrics.errors++;
    if (!res.headersSent && !res.destroyed) respond(res, 503, 'server_unavailable'); else res.destroy();
  }); });
  async function request(req, res) {
    if (!transportAllowed(req)) return respond(res, 403, 'tls_required');
    if (closing) return fail(res, 503, 'server_draining');
    let ip; try { ip = source(req); } catch { return fail(res, 400, 'invalid_forwarded_address'); }
    if (!limit(ip)) return fail(res, 429, 'rate_limited');
    if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, protocol: RELAY_PROTOCOL })); return; }
    if (req.url === '/readyz' && req.method === 'GET') {
      try { registry.ready(); registryHealthy = true; } catch { registryHealthy = false; }
      res.writeHead(registryHealthy ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: registryHealthy })); return;
    }
    if (req.url === '/relay/v1/register' && req.method === 'POST') {
      if (!registry || !registration.enabled) return respond(res, 403, 'registration_disabled');
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      if (!token) return respond(res, 401, 'invalid_registration_credential');
      if (!enrollRate(ip, options.registrationsPerMinute)) return fail(res, 429, 'registration_rate_limited');
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return respond(res, 400, 'invalid_request');
      let name;
      const bodyTimer = setTimeout(() => { metrics.timeouts++; req.destroy(); }, options.requestTimeout);
      try {
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          if ((size += chunk.length) > 2048) { respond(res, 413, 'payload_too_large'); return; }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 64 || /[\x00-\x1f\x7f]/.test(body.name)) throw new Error('invalid');
        name = body.name.trim();
      } catch { if (!res.destroyed) respond(res, 400, 'invalid_request'); return; }
      finally { clearTimeout(bodyTimer); }
      try {
        // Client-generated identity prevents credential loss when a response is lost.
        const hostId = registry.register(token, name);
        if (!hostId) return respond(res, 503, 'registration_capacity_reached');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, hostId }));
      } catch (error) { fail(res, error.message === 'identity_disabled' ? 403 : 503, error.message === 'identity_disabled' ? 'identity_disabled' : 'registry_unavailable'); }
      return;
    }
    // Presence for the phone's computer list: whether that computer's agent is connected right now.
    // Unknown ids answer like offline ones, so this does not reveal which ids are registered.
    const presence = /^\/relay\/v2\/presence\/([a-f0-9]{32})$/.exec(req.url || '');
    if (presence && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ online: online.has(presence[1]) })); return;
    }
    // The plaintext /h/<hostId>/api forwarding of protocol 1 is gone: it exposed tokens to the relay.
    return respond(res, 404, 'not_found');
  }
  server.on('upgrade', (req, socket, head) => { void upgrade(req, socket, head).catch(() => { metrics.errors++; socket.destroy(); }); });
  async function upgrade(req, socket, head) {
    socket.on('error', () => {});
    if (!transportAllowed(req)) return reject(socket, 403);
    if (closing) return reject(socket, 503);
    let ip; try { ip = source(req); } catch { return reject(socket, 400); }
    if (!limit(ip)) return reject(socket, 429);
    const match = /^\/relay\/v1\/agent\/([a-f0-9]{32})$/.exec(req.url || '');
    if (match) {
      const id = match[1], token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      let expected; try { expected = registry.tokenHash(id); } catch { return reject(socket, 503); }
      if (!token || !expected || !timingSafeEqual(digest(token), Buffer.from(expected, 'hex'))) return reject(socket, 401);
      if (probes.has(id)) return reject(socket, 503);
      const previous = online.get(id);
      if (previous) {
        probes.add(id);
        let alive;
        try { alive = await probe(previous.ws, options.duplicateProbeTimeout); } finally { probes.delete(id); }
        if (socket.destroyed || closing) return socket.destroy();
        if (alive) return reject(socket, 409);
        metrics.staleConnections++; drop(previous);
        if (online.get(id) === previous) online.delete(id);
      }
      if (!registry.tokenHash(id)) return reject(socket, 401);
      if (online.size >= options.maxAgents) return reject(socket, 503);
      registry.touch(id);
      return agents.handleUpgrade(req, socket, head, ws => {
        const tunnel = new Tunnel(ws); online.set(id, tunnel);
        ws.once('close', () => { if (online.get(id) === tunnel) online.delete(id); });
      });
    }
    const connect = /^\/relay\/v2\/connect\/([a-f0-9]{32})$/.exec(req.url || '');
    if (!connect) return reject(socket, 404);
    const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map(p => p.trim());
    if (!offered.includes(SECURE_PROTOCOL)) return reject(socket, 400);
    const id = connect[1], tunnel = online.get(id);
    if (!tunnel) return reject(socket, 503);
    const release = capacity.acquire(id);
    if (!release) return reject(socket, 429);
    socket.once('close', release);
    const timer = setTimeout(() => { metrics.timeouts++; socket.destroy(); }, options.handshakeTimeout);
    clients.handleUpgrade(req, socket, head, ws => {
      clearTimeout(timer);
      let channel;
      try { channel = tunnel.open(); } catch { ws.close(1013, 'relay_busy'); return; }
      metrics.accepted++;
      splice(ws, channel, release);
    });
  }
  /** Opaque byte splice between the phone's WebSocket and one tunnel channel. */
  function splice(ws, channel, release) {
    const stream = createWebSocketStream(ws);
    let idle, finished = false;
    const up = new Transfer({ rate: options.streamBytesPerSecond, progress: bytes => { metrics.uploadedBytes += bytes; activity(); } });
    const down = new Transfer({ rate: options.streamBytesPerSecond, progress: bytes => { metrics.downloadedBytes += bytes; activity(); } });
    function finish() {
      if (finished) return;
      finished = true; clearTimeout(idle);
      up.destroy(); down.destroy(); stream.destroy(); channel.destroy(); ws.terminate(); release();
    }
    function activity() {
      clearTimeout(idle);
      idle = setTimeout(() => { metrics.timeouts++; finish(); }, options.streamIdleTimeout);
    }
    ws.on('message', (_, binary) => { if (!binary) { metrics.errors++; finish(); } });
    for (const part of [stream, channel, up, down]) part.on('error', finish);
    // The phone's WebSocket is the session: once it is gone, everything goes.
    stream.once('close', finish);
    // A clean end from the computer flows through `down` (which may still hold throttled bytes)
    // and closes the WebSocket after the last byte; only an abort without end tears down at once.
    channel.once('close', () => { if (!channel.readableEnded) finish(); });
    activity();
    stream.pipe(up).pipe(channel);
    channel.pipe(down).pipe(stream);
  }
  server.headersTimeout = Math.min(15000, options.requestTimeout);
  server.requestTimeout = 0;
  server.setTimeout(Math.max(options.requestTimeout, options.streamIdleTimeout), socket => socket.destroy());
  server.keepAliveTimeout = 5000;
  server.on('clientError', (_, socket) => socket.destroy());
  return {
    server, online,
    snapshot: () => ({ updatedAt: Date.now(), draining: closing, ready: registryHealthy, online: online.size,
      sockets: sockets.size, ...capacity.snapshot(), ...metrics }),
    close() {
      if (closePromise) return closePromise;
      closing = true; registryHealthy = false; clearInterval(registryTimer);
      closePromise = new Promise(resolve => {
        const finishSockets = () => {
          for (const tunnel of online.values()) drop(tunnel);
          for (const client of clients.clients) client.terminate();
          for (const socket of sockets) socket.destroy();
        };
        const deadline = setTimeout(finishSockets, options.shutdownTimeout);
        const drain = setInterval(() => { if (!capacity.snapshot().streams) finishSockets(); }, 25);
        server.close(() => {
          clearTimeout(deadline); clearInterval(drain); agents.close(); clients.close(); registry.close(); resolve();
        });
        if (!capacity.snapshot().streams) finishSockets();
      });
      return closePromise;
    },
  };
}

function probe(ws, timeout) {
  if (ws.readyState !== 1) return Promise.resolve(false);
  return new Promise(resolve => {
    const nonce = randomBytes(16);
    const done = alive => { clearTimeout(timer); ws.off('pong', pong); ws.off('close', closed); resolve(alive); };
    const pong = data => { if (data.equals(nonce)) done(true); };
    const closed = () => done(false);
    const timer = setTimeout(closed, timeout);
    ws.on('pong', pong); ws.once('close', closed);
    try { ws.ping(nonce); } catch { closed(); }
  });
}
