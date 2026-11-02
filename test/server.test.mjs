import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';
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
  const desktop = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + device) { res.writeHead(401); res.end(); return; }
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
    if (req.headers.authorization !== 'Bearer ' + device) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => ws.on('message', (data, binary) => ws.send(data, { binary })));
  });
  desktop.listen(0, '127.0.0.1'); await once(desktop, 'listening');
  const relay = createRelayServer({ hosts: { synthetic: createHash('sha256').update(registration).digest('hex') }, tls, allowInsecureLoopback: !secure });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const origin = `${secure ? 'https' : 'http'}://127.0.0.1:${relay.server.address().port}`;
  const agents = [], sockets = new Set();
  async function agent(token = registration) {
    const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/relay/v1/agent/synthetic', {
      headers: { Authorization: 'Bearer ' + token }, ...(tls ? { ca: tls.cert } : {}),
    });
    agents.push(ws);
    await once(ws, 'open');
    return new Tunnel(ws, channel => {
      const socket = net.connect(desktop.address().port, '127.0.0.1');
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => channel.destroy()); channel.on('error', () => socket.destroy());
      socket.on('close', hadError => { if (hadError || !socket.readableEnded) channel.destroy(); });
      channel.on('close', () => socket.destroy());
      channel.pipe(socket); socket.pipe(channel);
    });
  }
  function request(path, body, headers = {}, ca = tls?.cert) {
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
  return { relay, origin, agent, request, device, registration, tls };
}

test('health, offline isolation, authenticated registration and bounded HTTP forwarding', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(JSON.parse((await f.request('/healthz')).data), { ok: true, protocol: 1 });
  assert.equal((await f.request('/h/synthetic/api/echo')).status, 503);
  await assert.rejects(f.agent(randomBytes(32).toString('hex')), /401/);
  await f.agent(); await assert.rejects(f.agent(), /409/);
  assert.equal((await f.request('/h/other/api/echo')).status, 503);
  assert.equal((await f.request('/h/synthetic/not-api')).status, 404);
  assert.equal((await f.request('/h/synthetic/api/echo', undefined, { Authorization: 'Bearer invalid' })).status, 401);
  const payload = randomBytes(1024 * 1024 + 17);
  assert.deepEqual((await f.request('/h/synthetic/api/echo', payload)).data, payload);
  const headers = JSON.parse((await f.request('/h/synthetic/api/headers', undefined, {
    'X-Forwarded-For': '192.0.2.1', Cookie: 'synthetic=1', Origin: 'https://example.test',
    'X-DSH-Pairing-Secret': 'synthetic-pair-secret',
  })).data);
  assert.equal(headers.host, 'localhost');
  assert.equal(headers['x-forwarded-for'], undefined); assert.equal(headers.cookie, undefined);
  assert.equal(headers.origin, undefined); assert.equal(headers['x-dsh-pairing-secret'], 'synthetic-pair-secret');
});

test('WebSocket and SSE forwarding use the same synthetic host', { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.agent();
  const ws = new WebSocket(f.origin.replace(/^http/, 'ws') + '/h/synthetic/api/events.mux', { headers: { Authorization: 'Bearer ' + f.device } });
  t.after(() => ws.terminate()); await once(ws, 'open');
  const reply = once(ws, 'message'); ws.send('synthetic-message');
  assert.equal((await reply)[0].toString(), 'synthetic-message');
  await new Promise((resolve, reject) => {
    const req = http.get(f.origin + '/h/synthetic/api/events.host', { headers: { Authorization: 'Bearer ' + f.device } }, res => {
      res.once('data', chunk => {
        try { assert.match(chunk.toString(), /synthetic-event/); resolve(); } catch (error) { reject(error); }
        res.destroy();
      });
    }); req.on('error', reject); t.after(() => req.destroy());
  });
});

test('HTTPS and WSS require a trusted certificate', { timeout: 15000 }, async t => {
  const f = await fixture(t, true); await f.agent();
  assert.equal((await f.request('/h/synthetic/api/echo', 'secure')).data.toString(), 'secure');
  await assert.rejects(f.request('/healthz', undefined, {}, []), /certificate|self.signed/i);
});

test('provisioning hashes a synthetic credential and refuses to overwrite a directory', () => {
  const parent = mkdtempSync(join(tmpdir(), 'dsh-provision-test-'));
  const destination = join(parent, 'private');
  try {
    const args = ['src/provision.mjs', destination, 'synthetic', 'https://relay.example.com:8443'];
    execFileSync(process.execPath, args, { stdio: 'ignore', windowsHide: true });
    const server = JSON.parse(readFileSync(join(destination, 'server.json')));
    const plugin = JSON.parse(readFileSync(join(destination, 'plugin-secret.json')));
    assert.equal(server.hosts.synthetic, createHash('sha256').update(plugin.registrationToken).digest('hex'));
    assert.equal(server.bind, '127.0.0.1');
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'ignore', windowsHide: true }));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
