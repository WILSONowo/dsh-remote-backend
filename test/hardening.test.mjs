import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { Tunnel } from '../lib/tunnel.js';
import { createRelayServer } from '../src/server.mjs';
import { openRegistry } from '../src/registry.mjs';
import { normalizeOptions, clientAddress } from '../src/config.mjs';
import { createCapacity } from '../src/resources.mjs';
import { openStream, phoneRequest, upgradeStatus } from './phone.mjs';
import { startStatusWriter } from '../src/operations.mjs';
import { administer } from '../src/admin.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, maximum = 2000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > maximum) throw new Error('Condition timed out'); await delay(10); }
}

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-hardening-'));
  const database = join(directory, 'hosts.sqlite'), sockets = new Set(), peers = [];
  let writes = 0;
  const desktop = http.createServer(async (req, res) => {
    if (req.url === '/api/stall') { res.writeHead(200); res.write('{'); return; }
    if (req.url === '/api/remote-access/fs/read?stall=1') { res.writeHead(200); res.write('x'); return; }
    if (req.url === '/api/events.host') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 20);
      res.on('close', () => clearInterval(timer)); return;
    }
    if (req.url === '/api/remote-access/fs/read') { res.end(Buffer.alloc(16384, 7)); return; }
    if (req.method === 'POST') { writes++; for await (const _ of req) {} }
    res.end('ok');
  });
  const wss = new WebSocketServer({ noServer: true });
  desktop.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => ws.on('message', data => ws.send(data))));
  desktop.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  desktop.listen(0, '127.0.0.1'); await once(desktop, 'listening');
  const relay = createRelayServer({ registration: { enabled: true, database }, allowInsecureLoopback: true, ...options });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const base = 'http://127.0.0.1:' + relay.server.address().port;
  const secret = randomBytes(32).toString('hex');
  const registration = await fetch(base + '/relay/v1/register', { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic desktop' }) });
  const { hostId } = await registration.json();
  async function agent(autoPong = true, id = hostId, credential = secret) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/relay/v1/agent/' + id, { autoPong, headers: { Authorization: 'Bearer ' + credential } });
    peers.push(ws); await once(ws, 'open');
    new Tunnel(ws, channel => {
      const socket = net.connect(desktop.address().port, '127.0.0.1');
      socket.on('error', () => channel.destroy()); channel.on('close', () => socket.destroy());
      socket.pipe(channel).pipe(socket);
    });
    return ws;
  }
  const phone = (path, options) => phoneRequest(base, hostId, path, options);
  const stream = () => openStream(base, hostId);
  t.after(async () => {
    for (const ws of peers) ws.terminate();
    for (const ws of wss.clients) ws.terminate(); wss.close();
    await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => desktop.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  return { relay, agent, phone, stream, base, database, hostId, directory, writes: () => writes };
}

test('silent streams expire; streams with traffic outlive the idle limit and release capacity', { timeout: 8000 }, async t => {
  const f = await fixture(t, { streamIdleTimeout: 100 }); await f.agent();
  await assert.rejects(f.phone('/api/stall'));
  await until(() => f.relay.snapshot().streams === 0);
  assert.equal(f.relay.snapshot().timeouts, 1);
  const events = await new Promise((resolve, reject) => {
    const req = http.get({ path: '/api/events.host', createConnection: () => f.stream() }, resolve); req.on('error', reject);
  });
  const start = Date.now(); let received = 0;
  events.on('data', () => { received++; });
  await delay(300); assert.ok(Date.now() - start >= 280); assert.ok(received > 3); assert.equal(events.destroyed, false);
  events.destroy(); await until(() => f.relay.snapshot().streams === 0);
});

test('streamBytesPerSecond throttles each stream; zero means unthrottled', { timeout: 8000 }, async t => {
  const slow = await fixture(t, { streamBytesPerSecond: 32768 }); await slow.agent();
  let start = Date.now();
  assert.equal((await slow.phone('/api/remote-access/fs/read')).data.length, 16384);
  assert.ok(Date.now() - start >= 400, 'download throttled');
  start = Date.now();
  assert.equal((await slow.phone('/api/upload', { body: Buffer.alloc(16384) })).data.toString(), 'ok');
  assert.ok(Date.now() - start >= 400, 'upload throttled');
  const fast = await fixture(t); await fast.agent();
  start = Date.now();
  assert.equal((await fast.phone('/api/remote-access/fs/read')).data.length, 16384);
  assert.ok(Date.now() - start < 400);
  assert.throws(() => normalizeOptions({ registration: { database: ':memory:' }, streamBytesPerSecond: -1 }), /streamBytesPerSecond/);
});

test('WebSocket heartbeat inside the stream keeps it alive; idle stream closes and releases capacity', { timeout: 8000 }, async t => {
  const f = await fixture(t, { streamIdleTimeout: 150 }); await f.agent();
  const ws = new WebSocket('ws://phone.e2e.dsh.invalid/api/events.mux', { createConnection: () => f.stream() });
  t.after(() => ws.terminate()); await once(ws, 'open');
  const timer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30);
  t.after(() => clearInterval(timer)); await delay(350); assert.equal(ws.readyState, WebSocket.OPEN);
  clearInterval(timer); await until(() => ws.readyState === WebSocket.CLOSED);
  await until(() => f.relay.snapshot().streams === 0);
});

test('online computer limit rejects another identity without evicting the first', { timeout: 8000 }, async t => {
  const f = await fixture(t, { maxAgents: 1 }); const first = await f.agent();
  const secret = randomBytes(32).toString('hex');
  const response = await fetch(f.base + '/relay/v1/register', { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic second' }) });
  const { hostId } = await response.json(); await assert.rejects(f.agent(true, hostId, secret), /503/);
  assert.equal(first.readyState, WebSocket.OPEN); assert.equal(f.relay.snapshot().online, 1);
});

test('registry failure reports unready and fails closed for connected computers', { timeout: 8000 }, async t => {
  const f = await fixture(t, { revocationInterval: 30 }); const ws = await f.agent();
  const db = new DatabaseSync(f.database); db.exec('DROP TABLE hosts'); db.close();
  const ready = await fetch(f.base + '/readyz'); assert.equal(ready.status, 503); assert.deepEqual(await ready.json(), { ok: false });
  await until(() => ws.readyState === WebSocket.CLOSED);
  assert.equal(f.relay.snapshot().ready, false);
});

test('stale agent is replaced, live duplicate is rejected, concurrent probes retry with 503', { timeout: 8000 }, async t => {
  const f = await fixture(t, { duplicateProbeTimeout: 150 });
  const old = await f.agent(false);
  const replacement = f.agent(); await delay(30);
  await assert.rejects(f.agent(), /503/);
  const next = await replacement;
  await until(() => old.readyState === WebSocket.CLOSED);
  assert.equal(next.readyState, WebSocket.OPEN);
  assert.equal(f.relay.snapshot().staleConnections, 1);
  await assert.rejects(f.agent(), /409/);
  assert.equal((await f.phone('/api/echo')).data.toString(), 'ok');
});

test('administrator disable disconnects live agent; enable works; revoke cannot re-enroll', { timeout: 8000 }, async t => {
  const f = await fixture(t, { revocationInterval: 30 }); const ws = await f.agent();
  const admin = openRegistry(f.database);
  try {
  admin.setStatus(f.hostId, 'disabled');
  await until(() => ws.readyState === WebSocket.CLOSED);
  await assert.rejects(f.agent(), /401/);
  admin.setStatus(f.hostId, 'active'); const second = await f.agent();
  admin.setStatus(f.hostId, 'revoked'); await until(() => second.readyState === WebSocket.CLOSED);
  assert.throws(() => admin.setStatus(f.hostId, 'active'), /cannot be reactivated/);
  assert.equal(f.relay.snapshot().revokedConnections, 2);
  } finally { admin.close(); }
});

test('trusted proxy rates separate clients; untrusted forwarded headers cannot evade limits', { timeout: 8000 }, async t => {
  const f = await fixture(t, { trustedProxies: ['127.0.0.1/32'], requestsPerMinute: 3 });
  for (const ip of ['192.0.2.1', '192.0.2.2']) for (let i = 0; i < 4; i++) {
    const response = await fetch(f.base + '/healthz', { headers: { 'X-Forwarded-For': ip } });
    assert.equal(response.status, i === 3 ? 429 : 200); await response.text();
  }
  const malformed = await fetch(f.base + '/healthz', { headers: { 'X-Forwarded-For': 'not-an-ip' } });
  assert.equal(malformed.status, 400); await malformed.text();
  const g = await fixture(t, { requestsPerMinute: 3 });
  for (let i = 0; i < 3; i++) {
    const response = await fetch(g.base + '/healthz', { headers: { 'X-Forwarded-For': '192.0.2.' + i } });
    assert.equal(response.status, i === 2 ? 429 : 200); await response.text();
  }
});

test('proxy chain stops at first untrusted hop and configuration fails closed', () => {
  const config = normalizeOptions({ registration: { database: ':memory:' }, trustedProxies: ['127.0.0.1', '2001:db8:1::/48'] });
  const req = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '192.0.2.1, 192.0.2.2, 2001:db8:1::2' } };
  assert.equal(clientAddress(req, config.trustProxy), '192.0.2.2');
  for (const bad of [{ requestTimeout: 0 }, { maxRequestsPerHost: 65 }, { trustedProxies: ['0.0.0.0/0'] }, { trustedProxies: ['127.0.0.1/33'] }, { registration: { database: ':memory:', enabled: 'true' } }]) {
    assert.throws(() => normalizeOptions({ registration: { database: ':memory:' }, ...bad }));
  }
});

test('stream capacity is bounded globally and per host; release is idempotent; HTTP-era options are ignored', () => {
  const capacity = createCapacity({ maxRequests: 3, maxRequestsPerHost: 2 });
  const a = capacity.acquire('a'), b = capacity.acquire('a'), c = capacity.acquire('b');
  assert.equal(capacity.acquire('a'), undefined); assert.equal(capacity.acquire('c'), undefined);
  a(); a(); assert.deepEqual(capacity.snapshot(), { streams: 2 }); b(); c();
  assert.deepEqual(capacity.snapshot(), { streams: 0 });
  const legacy = normalizeOptions({ registration: { database: ':memory:' }, maxFiles: 0, fileBytesPerSecond: 'x', maxBodyBytes: 1 });
  assert.deepEqual(legacy.ignoredOptions, ['maxFiles', 'fileBytesPerSecond', 'maxBodyBytes']);
  assert.equal(legacy.maxFiles, undefined); assert.equal(legacy.streamBytesPerSecond, 0);
});

test('shutdown drains completed requests, bounds streams and is idempotent', { timeout: 8000 }, async t => {
  const f = await fixture(t, { shutdownTimeout: 120 }); await f.agent();
  const events = await new Promise((resolve, reject) => {
    const req = http.get({ path: '/api/events.host', createConnection: () => f.stream() }, resolve); req.on('error', reject);
  });
  await once(events, 'data'); events.on('error', () => {});
  const started = Date.now(), closed = f.relay.close(); assert.equal(f.relay.close(), closed);
  await closed; assert.ok(Date.now() - started < 1500);
  assert.equal(f.relay.snapshot().draining, true);
});

test('private status contains aggregate counters, and ready endpoint is minimal', { timeout: 8000 }, async t => {
  const f = await fixture(t); await f.agent();
  assert.deepEqual(await (await fetch(f.base + '/readyz')).json(), { ok: true });
  const file = join(f.directory, 'status.json'); const writer = startStatusWriter(file, f.relay.snapshot);
  await writer.close();
  const text = readFileSync(file, 'utf8');
  assert.equal(text.includes(f.hostId), false); assert.equal(text.includes('Synthetic'), false); assert.equal(text.includes('127.0.0.1'), false);
  const status = administer(['status', '--file', file]); assert.equal(status.online, 1); assert.equal(status.stale, false);
});

test('socket cap bounds idle connections and releases them', { timeout: 8000 }, async t => {
  const f = await fixture(t, { maxSockets: 4 }); const connections = [];
  for (let i = 0; i < 8; i++) { const socket = net.connect(f.relay.server.address().port, '127.0.0.1'); socket.on('error', () => {}); connections.push(socket); }
  t.after(() => connections.forEach(s => s.destroy()));
  await until(() => connections.filter(s => s.destroyed).length >= 4);
  assert.ok(f.relay.snapshot().sockets <= 4); connections.forEach(s => s.destroy());
});

test('global and per-host stream admission refuses excess streams and recovers after cancel', { timeout: 8000 }, async t => {
  const f = await fixture(t, { maxRequests: 2, maxRequestsPerHost: 2 }); await f.agent();
  const held = [f.stream(), f.stream()];
  t.after(() => held.forEach(s => s.destroy()));
  await Promise.all(held.map(s => once(s.ws, 'open')));
  await until(() => f.relay.snapshot().streams === 2);
  assert.equal(await upgradeStatus(f.base, f.hostId), 429);
  held[0].destroy(); await until(() => f.relay.snapshot().streams === 1);
  assert.equal((await f.phone('/api/echo')).data.toString(), 'ok');
  held[1].destroy(); await until(() => f.relay.snapshot().streams === 0);
});

test('registration body has a bounded deadline even without Content-Length', { timeout: 8000 }, async t => {
  const f = await fixture(t, { requestTimeout: 100 });
  const socket = net.connect(f.relay.server.address().port, '127.0.0.1');
  t.after(() => socket.destroy()); await once(socket, 'connect');
  const closed = once(socket, 'close');
  socket.write('POST /relay/v1/register HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ' + randomBytes(32).toString('hex') + '\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n');
  await closed; assert.equal(f.relay.snapshot().timeouts, 1);
});
