import http from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Tunnel, MAX_FRAME } from '../lib/tunnel.js';
import { openRegistry } from './registry.mjs';

const digest = s => createHash('sha256').update(s).digest();
const safeHeaders = headers => Object.fromEntries(Object.entries(headers).filter(([k]) =>
  ['authorization', 'content-type', 'accept', 'content-length', 'last-event-id', 'x-dsh-pairing-secret', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol'].includes(k)));
const respond = (res, status, error) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error })); };
const reject = (socket, status) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie']);

/** Only dynamically registered computers can authenticate. */
export function createRelayServer(options) {
  if (Object.hasOwn(options, 'hosts')) throw new Error('Static hosts are no longer supported; back up and remove hosts, then configure registration.database');
  const { registration, tls, allowInsecureLoopback = false, requestTimeout = 60000 } = options;
  if (!registration?.database) throw new Error('Registration database required');
  const online = new Map();
  const registry = openRegistry(registration.database, registration.maxHosts ?? 1000);
  const enrollRates = new Map();
  const rates = new Map();
  const agents = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const server = tls ? https.createServer(tls) : http.createServer();
  const transportAllowed = req => !!tls || allowInsecureLoopback && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  function limit(req) {
    const now = Date.now();
    for (const [ip, r] of rates) if (now - r.at >= 60000) rates.delete(ip);
    const ip = req.socket.remoteAddress;
    const r = rates.get(ip) || { at: now, count: 0 };
    if (rates.size >= 4096 && !rates.has(ip)) return false;
    rates.set(ip, r);
    return ++r.count <= 600;
  }
  function destination(req) {
    // Match the raw path: no normalization may turn a different route into /api.
    const match = /^\/h\/([a-f0-9]{32})(\/api\/[A-Za-z0-9._/-]+(?:\?[^\r\n#]*)?)$/.exec(req.url || '');
    if (!match || match[2].split('?')[0].split('/').includes('..')) return;
    const tunnel = online.get(match[1]);
    return { tunnel, path: match[2] };
  }
  function upstream(req, dest, upgrade = false) {
    const channel = dest.tunnel.open();
    const headers = { ...safeHeaders(req.headers), host: 'localhost', connection: upgrade ? 'Upgrade' : 'close' };
    if (upgrade) headers.upgrade = 'websocket';
    const out = http.request({ hostname: 'localhost', path: dest.path, method: req.method, headers, createConnection: () => channel });
    out.on('close', () => { if (!upgrade) channel.destroy(); });
    return { out, channel };
  }
  server.on('request', async (req, res) => {
    if (!transportAllowed(req)) return respond(res, 403, 'tls_required');
    if (!limit(req)) return respond(res, 429, 'rate_limited');
    if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"protocol":1}'); return; }
    if (req.url === '/relay/v1/register' && req.method === 'POST') {
      if (!registry || !registration.enabled) return respond(res, 403, 'registration_disabled');
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      if (!token) return respond(res, 401, 'invalid_registration_credential');
      const now = Date.now(), ip = req.socket.remoteAddress;
      for (const [key, value] of enrollRates) if (now - value.at >= 60000) enrollRates.delete(key);
      const rate = enrollRates.get(ip) || { at: now, count: 0 };
      if ((!enrollRates.has(ip) && enrollRates.size >= 4096) || ++rate.count > 20) return respond(res, 429, 'registration_rate_limited');
      enrollRates.set(ip, rate);
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return respond(res, 400, 'invalid_request');
      let name;
      try {
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          if ((size += chunk.length) > 2048) { respond(res, 413, 'payload_too_large'); return; }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 64 || /[\x00-\x1f\x7f]/.test(body.name)) throw new Error('invalid');
        name = body.name.trim();
      } catch { return respond(res, 400, 'invalid_request'); }
      try {
        // Client-generated identity prevents credential loss when a response is lost.
        const hostId = registry.register(token, name);
        if (!hostId) return respond(res, 503, 'registration_capacity_reached');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, hostId }));
      } catch { respond(res, 503, 'registry_unavailable'); }
      return;
    }
    const dest = destination(req);
    if (!dest) return respond(res, 404, 'not_found');
    if (!['GET', 'POST', 'HEAD'].includes(req.method)) return respond(res, 405, 'method_not_allowed');
    if (!dest.tunnel) return respond(res, 503, 'host_offline');
    if (Number(req.headers['content-length'] || 0) > 64 * 1024 * 1024) return respond(res, 413, 'payload_too_large');
    let out, channel;
    try { ({ out, channel } = upstream(req, dest)); } catch { return respond(res, 503, 'relay_busy'); }
    let size = 0;
    const timer = setTimeout(() => { out.destroy(); channel.destroy(); if (!res.headersSent) respond(res, 504, 'request_timeout'); else res.destroy(); }, requestTimeout);
    out.on('response', incoming => {
      clearTimeout(timer);
      const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([k]) => !hop.has(k)));
      res.writeHead(incoming.statusCode, { ...headers, 'Cache-Control': 'no-store' });
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
    });
    out.on('error', () => { clearTimeout(timer); if (!res.headersSent) respond(res, 502, 'relay_disconnected'); else res.destroy(); });
    req.on('data', chunk => { if ((size += chunk.length) > 64 * 1024 * 1024) { out.destroy(); if (!res.headersSent) respond(res, 413, 'payload_too_large'); } });
    req.on('aborted', () => out.destroy());
    res.on('close', () => { clearTimeout(timer); out.destroy(); channel.destroy(); });
    req.pipe(out);
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (!transportAllowed(req)) return reject(socket, 403);
    if (!limit(req)) return reject(socket, 429);
    const match = /^\/relay\/v1\/agent\/([a-f0-9]{32})$/.exec(req.url || '');
    if (match) {
      const id = match[1], token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      const expected = registry.tokenHash(id);
      if (!token || !expected || !timingSafeEqual(digest(token), Buffer.from(expected, 'hex'))) return reject(socket, 401);
      if (online.has(id)) return reject(socket, 409);
      return agents.handleUpgrade(req, socket, head, ws => {
        const tunnel = new Tunnel(ws); online.set(id, tunnel);
        ws.once('close', () => { if (online.get(id) === tunnel) online.delete(id); });
      });
    }
    const dest = destination(req);
    if (!dest || !/^\/api\/events\.(mux|host)$/.test(dest.path)) return reject(socket, 404);
    if (!dest.tunnel) return reject(socket, 503);
    let out, channel;
    try { ({ out, channel } = upstream(req, dest, true)); } catch { return reject(socket, 503); }
    const timer = setTimeout(() => { reject(socket, 504); out.destroy(); channel.destroy(); }, 15000);
    socket.once('close', () => { clearTimeout(timer); out.destroy(); channel.destroy(); });
    out.on('error', () => { clearTimeout(timer); socket.destroy(); });
    out.on('response', response => { clearTimeout(timer); reject(socket, response.statusCode); out.destroy(); channel.destroy(); });
    out.on('upgrade', (response, remote, remoteHead) => {
      clearTimeout(timer);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n` + Object.entries(response.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
      remote.once('close', () => socket.destroy());
      remote.on('error', () => socket.destroy());
    });
    out.end();
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 60000;
  server.on('clientError', (_, socket) => socket.destroy());
  return {
    server, online,
    async close() {
      for (const tunnel of online.values()) { tunnel.destroy(); tunnel.ws.terminate(); }
      agents.close(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      registry?.close();
    },
  };
}
