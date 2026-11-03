import http from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Tunnel, MAX_FRAME } from '../lib/tunnel.js';
import { openRegistry } from './registry.mjs';
import { normalizeOptions, clientAddress, isLoopback } from './config.mjs';
import { createLimiter, createCapacity, Transfer, isFileRequest, isEventRequest } from './resources.mjs';

const digest = s => createHash('sha256').update(s).digest();
const safeHeaders = headers => Object.fromEntries(Object.entries(headers).filter(([k]) =>
  ['authorization', 'content-type', 'accept', 'content-length', 'last-event-id', 'x-dsh-pairing-secret', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol'].includes(k)));
const sendError = (res, status, error) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error })); };
const rejectSocket = (socket, status) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie']);

/** Only dynamically registered computers can authenticate. */
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
  function destination(req) {
    // Match the raw path: no normalization may turn a different route into /api.
    const match = /^\/h\/([a-f0-9]{32})(\/api\/[A-Za-z0-9._/-]+(?:\?[^\r\n#]*)?)$/.exec(req.url || '');
    if (!match || match[2].split('?')[0].split('/').includes('..')) return;
    const tunnel = online.get(match[1]);
    return { id: match[1], tunnel, path: match[2] };
  }
  function upstream(req, dest, upgrade = false) {
    const channel = dest.tunnel.open();
    const headers = { ...safeHeaders(req.headers), host: 'localhost', connection: upgrade ? 'Upgrade' : 'close' };
    if (upgrade) headers.upgrade = 'websocket';
    const out = http.request({ hostname: 'localhost', path: dest.path, method: req.method, headers, createConnection: () => channel });
    out.on('close', () => { if (!upgrade) channel.destroy(); });
    return { out, channel };
  }
  server.on('request', (req, res) => { void request(req, res).catch(() => {
    metrics.errors++;
    if (!res.headersSent && !res.destroyed) respond(res, 503, 'server_unavailable'); else res.destroy();
  }); });
  async function request(req, res) {
    if (!transportAllowed(req)) return respond(res, 403, 'tls_required');
    if (closing) return fail(res, 503, 'server_draining');
    let ip; try { ip = source(req); } catch { return fail(res, 400, 'invalid_forwarded_address'); }
    if (!limit(ip)) return fail(res, 429, 'rate_limited');
    if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"protocol":1}'); return; }
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
    const dest = destination(req);
    if (!dest) return respond(res, 404, 'not_found');
    if (!['GET', 'POST', 'HEAD'].includes(req.method)) return respond(res, 405, 'method_not_allowed');
    if (!dest.tunnel) return respond(res, 503, 'host_offline');
    if (Number(req.headers['content-length'] || 0) > options.maxBodyBytes) return fail(res, 413, 'payload_too_large');
    const file = isFileRequest(dest.path), event = isEventRequest(dest.path);
    const release = capacity.acquire(dest.id, file);
    if (!release) return fail(res, 429, 'relay_busy');
    let out, channel;
    try { ({ out, channel } = upstream(req, dest)); } catch { release(); return fail(res, 503, 'relay_busy'); }
    metrics.accepted++;
    let totalTimer, idleTimer, incoming, download, finished = false;
    const abort = (status, error) => {
      if (finished) return;
      if (status === 504) metrics.timeouts++; else metrics.errors++;
      if (!res.headersSent) respond(res, status, error); else res.destroy();
      cleanup();
    };
    const activity = () => {
      if (!file && !event) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abort(504, 'stream_idle_timeout'), file ? options.fileIdleTimeout : options.streamIdleTimeout);
    };
    const upload = new Transfer({ rate: file ? options.fileBytesPerSecond : 0, maximum: options.maxBodyBytes,
      progress: bytes => { metrics.uploadedBytes += bytes; activity(); } });
    function cleanup() {
      if (finished) return;
      finished = true; clearTimeout(totalTimer); clearTimeout(idleTimer);
      req.unpipe(upload); upload.destroy(); download?.destroy(); incoming?.destroy(); out.destroy(); channel.destroy(); release();
    }
    if (!file) totalTimer = setTimeout(() => abort(504, 'request_timeout'), options.requestTimeout);
    activity();
    out.on('response', response => {
      incoming = response;
      // Streams/files use an idle budget after headers, ordinary RPC keeps its total deadline.
      if (file || event) clearTimeout(totalTimer);
      activity();
      const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([k]) => !hop.has(k)));
      res.writeHead(incoming.statusCode, { ...headers, 'Cache-Control': 'no-store' });
      download = new Transfer({ rate: file ? options.fileBytesPerSecond : 0,
        progress: bytes => { metrics.downloadedBytes += bytes; activity(); } });
      incoming.on('error', () => abort(502, 'relay_disconnected'));
      download.on('error', () => abort(502, 'relay_disconnected'));
      incoming.pipe(download).pipe(res);
    });
    upload.on('error', error => abort(error.code === 'BODY_LIMIT' ? 413 : 502, error.code === 'BODY_LIMIT' ? 'payload_too_large' : 'relay_disconnected'));
    out.on('error', () => abort(502, 'relay_disconnected'));
    req.on('aborted', cleanup); res.on('close', cleanup); res.on('finish', cleanup);
    req.pipe(upload).pipe(out);
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
    const dest = destination(req);
    if (!dest || !/^\/api\/events\.(mux|host)$/.test(dest.path)) return reject(socket, 404);
    if (!dest.tunnel) return reject(socket, 503);
    const release = capacity.acquire(dest.id, false);
    if (!release) return reject(socket, 429);
    socket.once('close', release);
    let out, channel;
    try { ({ out, channel } = upstream(req, dest, true)); } catch { release(); return reject(socket, 503); }
    metrics.accepted++;
    const timer = setTimeout(() => { reject(socket, 504); out.destroy(); channel.destroy(); }, options.handshakeTimeout);
    socket.once('close', () => { clearTimeout(timer); out.destroy(); channel.destroy(); });
    out.on('error', () => { clearTimeout(timer); socket.destroy(); });
    out.on('response', response => { clearTimeout(timer); reject(socket, response.statusCode); out.destroy(); channel.destroy(); });
    out.on('upgrade', (response, remote, remoteHead) => {
      clearTimeout(timer);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n` + Object.entries(response.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.setTimeout(options.streamIdleTimeout, () => { metrics.timeouts++; socket.destroy(); });
      socket.pipe(remote).pipe(socket);
      remote.once('close', () => socket.destroy());
      remote.on('error', () => socket.destroy());
    });
    out.end();
  }
  server.headersTimeout = Math.min(15000, options.requestTimeout);
  // Body deadlines are handled above, so a healthy throttled upload is not cut off.
  server.requestTimeout = 0;
  server.setTimeout(Math.max(options.requestTimeout, options.fileIdleTimeout, options.streamIdleTimeout), socket => socket.destroy());
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
          for (const socket of sockets) socket.destroy();
        };
        const deadline = setTimeout(finishSockets, options.shutdownTimeout);
        const drain = setInterval(() => { if (!capacity.snapshot().requests) finishSockets(); }, 25);
        server.close(() => {
          clearTimeout(deadline); clearInterval(drain); agents.close(); registry.close(); resolve();
        });
        if (!capacity.snapshot().requests) finishSockets();
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
