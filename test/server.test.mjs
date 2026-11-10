import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';
import tlsConnect from 'node:tls';
import { openStream, phoneRequest, upgradeStatus } from './phone.mjs';

const until = async (check, maximum = 2000) => { const start = Date.now(); while (!check()) { if (Date.now() - start > maximum) throw new Error('Condition timed out'); await new Promise(r => setTimeout(r, 10)); } };
import { Tunnel } from '../lib/tunnel.js';
import { createRelayServer } from '../src/server.mjs';

// Synthetic peer and credentials. All listeners bind to ephemeral loopback ports.
async function fixture(t, secure = false) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-backend-test-'));
  const registration = randomBytes(32).toString('hex');
  const device = randomBytes(32).toString('hex');
  let tls;
  if (secure) {
    const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
    execFileSync(process.env.OPENSSL_BIN || 'openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert,
    ], { stdio: 'ignore', windowsHide: true });
    tls = { key: readFileSync(key), cert: readFileSync(cert) };
  }
  // The computer side; the relay must pass everything through without parsing it.
  const desktop = http.createServer(async (req, res) => {
    if (req.url === '/api/headers') { res.end(JSON.stringify(req.headers)); return; }
    if (req.url === '/api/events.host') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: synthetic-event\n\n');
      req.on('close', () => res.end()); return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.end(Buffer.concat(chunks));
  });
  const wss = new WebSocketServer({ noServer: true });
  desktop.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => ws.on('message', (data, binary) => ws.send(data, { binary })));
  });
  desktop.listen(0, '127.0.0.1'); await once(desktop, 'listening');
  const relay = createRelayServer({ registration: { enabled: true, database: join(directory, 'hosts.sqlite') }, tls, allowInsecureLoopback: !secure });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const origin = `${secure ? 'https' : 'http'}://127.0.0.1:${relay.server.address().port}`;
  let hostId;
  const registered = await request('/relay/v1/register', JSON.stringify({ name: 'Synthetic computer' }), { Authorization: 'Bearer ' + registration, 'Content-Type': 'application/json' });
  assert.equal(registered.status, 200);
  hostId = JSON.parse(registered.data).hostId;
  const agents = [], sockets = new Set(), carried = [];
  async function agent(token = registration, { e2e = false } = {}) {
    const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/relay/v1/agent/' + hostId, {
      headers: { Authorization: 'Bearer ' + token }, ...(tls ? { ca: tls.cert } : {}),
    });
    agents.push(ws);
    await once(ws, 'open');
    // Record exactly what crossed the relay, as the computer received it.
    ws.on('message', raw => { try { const m = JSON.parse(raw.toString()); if (m.type === 'data') carried.push(Buffer.from(m.data, 'base64')); } catch {} });
    return new Tunnel(ws, channel => {
      if (e2e) {
        const secure = new tlsConnect.TLSSocket(channel, { isServer: true, key: tls.key, cert: tls.cert, minVersion: 'TLSv1.3' });
        secure.on('error', () => channel.destroy());
        secure.once('secure', () => desktop.emit('connection', secure));
        return;
      }
      const socket = net.connect(desktop.address().port, '127.0.0.1');
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => channel.destroy()); channel.on('error', () => socket.destroy());
      socket.on('close', hadError => { if (hadError || !socket.readableEnded) channel.destroy(); });
      channel.on('close', () => socket.destroy());
      channel.pipe(socket); socket.pipe(channel);
    });
  }
  function request(path, body, headers = {}, ca = tls?.cert) {
    path = path.replace('/h/synthetic/', '/h/' + hostId + '/');
    return new Promise((resolve, reject) => {
      const req = (tls ? https : http).request(origin + path, {
        method: body === undefined ? 'GET' : 'POST', ca,
        headers: { Authorization: 'Bearer ' + device, ...headers },
      }, res => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
        res.on('aborted', () => reject(new Error('Response aborted')));
      }); req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Request timeout'))); req.end(body);
    });
  }
  t.after(async () => {
    for (const ws of agents) ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    wss.close(); await relay.close(); desktop.closeAllConnections();
    await new Promise(resolve => desktop.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  return { relay, origin, hostId, agent, request, device, registration, tls, tunnelBytes: () => carried };
}

test('health, offline isolation, registration and opaque byte relay', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(JSON.parse((await f.request('/healthz')).data), { ok: true, protocol: 2 });
  assert.equal(await upgradeStatus(f.origin, f.hostId), 503);
  const presence = async id => JSON.parse((await f.request('/relay/v2/presence/' + id)).data);
  assert.deepEqual(await presence(f.hostId), { online: false });
  await assert.rejects(f.agent(randomBytes(32).toString('hex')), /401/);
  await f.agent(); await assert.rejects(f.agent(), /409/);
  assert.deepEqual(await presence(f.hostId), { online: true });
  assert.deepEqual(await presence('0'.repeat(32)), { online: false });
  assert.equal((await f.request('/relay/v2/presence/not-an-id')).status, 404);
  assert.equal(await upgradeStatus(f.origin, '0'.repeat(32)), 503);
  assert.equal(await upgradeStatus(f.origin, f.hostId, { protocols: ['chat'] }), 400);
  // Protocol 1 plaintext forwarding is gone for HTTP and WebSocket alike.
  assert.equal((await f.request('/h/synthetic/api/echo', 'x')).status, 404);
  const legacy = new WebSocket(f.origin.replace(/^http/, 'ws') + '/h/' + f.hostId + '/api/events.mux');
  legacy.on('error', () => {});
  assert.equal((await once(legacy, 'unexpected-response'))[1].statusCode, 404);
  const payload = randomBytes(1024 * 1024 + 17);
  assert.deepEqual((await phoneRequest(f.origin, f.hostId, '/api/echo', { body: payload })).data, payload);
  // Bytes are spliced untouched: the computer sees exactly what the phone wrote, nothing added or removed.
  const headers = JSON.parse((await phoneRequest(f.origin, f.hostId, '/api/headers', { headers: {
    Authorization: 'Bearer ' + f.device, 'X-DSH-Pairing-Secret': 'synthetic-pair-secret', Cookie: 'synthetic=1' } })).data);
  assert.equal(headers.host, 'phone.e2e.dsh.invalid'); assert.equal(headers.authorization, 'Bearer ' + f.device);
  assert.equal(headers.cookie, 'synthetic=1'); assert.equal(headers['x-forwarded-for'], undefined);
  const text = openStream(f.origin, f.hostId); await once(text.ws, 'open');
  text.ws.send('not binary'); await once(text.ws, 'close');
  await until(() => f.relay.snapshot().streams === 0);
});

test('SSE and WebSocket run inside the relayed byte stream', { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.agent();
  const ws = new WebSocket('ws://phone.e2e.dsh.invalid/api/events.mux', { createConnection: () => openStream(f.origin, f.hostId) });
  t.after(() => ws.terminate()); await once(ws, 'open');
  const reply = once(ws, 'message'); ws.send('synthetic-message');
  assert.equal((await reply)[0].toString(), 'synthetic-message');
  await new Promise((resolve, reject) => {
    const req = http.get({ path: '/api/events.host', createConnection: () => openStream(f.origin, f.hostId) }, res => {
      res.once('data', chunk => {
        try { assert.match(chunk.toString(), /synthetic-event/); resolve(); } catch (error) { reject(error); }
        res.destroy();
      });
    }); req.on('error', reject); t.after(() => req.destroy());
  });
});

test('HTTPS and WSS require a trusted certificate; phone-to-computer TLS stays opaque to the relay', { timeout: 15000 }, async t => {
  const f = await fixture(t, true); await f.agent(undefined, { e2e: true });
  assert.equal(await upgradeStatus(f.origin, f.hostId, { ca: f.tls.cert }), 101);
  await assert.rejects(f.request('/healthz', undefined, {}, []), /certificate|self.signed/i);
  const secret = 'opaque-marker-' + randomBytes(8).toString('hex');
  const response = await phoneRequest(f.origin, f.hostId, '/api/echo', { body: secret, connection: () => tlsConnect.connect({
    socket: openStream(f.origin, f.hostId, { ca: f.tls.cert }), ca: f.tls.cert, servername: 'localhost', minVersion: 'TLSv1.3' }) });
  assert.equal(response.data.toString(), secret);
  const seen = Buffer.concat(f.tunnelBytes()).toString('latin1');
  assert.ok(seen.length > secret.length, 'relay carried the TLS session');
  assert.equal(seen.includes(secret), false, 'relay never sees plaintext');
  assert.equal(seen.includes('/api/echo'), false, 'relay never sees request paths');
});

test('legacy static hosts and provisioning arguments are rejected without creating files', () => {
  assert.throws(() => createRelayServer({ hosts: {}, registration: { database: ':memory:' } }), /Static hosts/);
  assert.throws(() => createRelayServer({}), /database required/);
  const parent = mkdtempSync(join(tmpdir(), 'dsh-provision-test-'));
  const destination = join(parent, 'private');
  try {
    const args = ['src/provision.mjs', destination];
    assert.throws(() => execFileSync(process.execPath, [...args, 'synthetic', 'https://relay.example.test'], { stdio: 'ignore', windowsHide: true }));
    assert.equal(existsSync(destination), false);
    execFileSync(process.execPath, args, { stdio: 'ignore', windowsHide: true });
    const server = JSON.parse(readFileSync(join(destination, 'server.json')));
    assert.equal(server.hosts, undefined);
    assert.equal(server.registration.enabled, true);
    assert.equal(server.bind, '127.0.0.1');
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'ignore', windowsHide: true }));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
