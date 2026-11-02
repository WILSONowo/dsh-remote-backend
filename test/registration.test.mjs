import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { createRelayServer } from '../src/server.mjs';

test('automatic registration: retries, rename, restart, isolation, credential checks and capacity', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-register-'));
  const database = join(directory, 'hosts.sqlite');
  const config = { allowInsecureLoopback: true, registration: { enabled: true, database, maxHosts: 2 } };
  let relay, origin;
  const clients = [];
  async function start() {
    relay = createRelayServer(config); relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
    origin = 'http://127.0.0.1:' + relay.server.address().port;
  }
  async function register(token, name = 'Synthetic computer') {
    const res = await fetch(origin + '/relay/v1/register', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer ' + token,
    }, body: JSON.stringify({ name }) });
    return { status: res.status, body: await res.json() };
  }
  async function agent(id, token) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/relay/v1/agent/' + id, { headers: { Authorization: 'Bearer ' + token } });
    clients.push(ws); await once(ws, 'open'); return ws;
  }
  t.after(async () => { for (const ws of clients) ws.terminate(); await relay.close(); rmSync(directory, { recursive: true, force: true }); });
  await start();
  const secretA = randomBytes(32).toString('hex'), secretB = randomBytes(32).toString('hex');
  assert.equal((await register('invalid')).status, 401);
  assert.equal((await register(secretA, '\ninvalid')).status, 400);
  const first = await register(secretA);
  assert.equal(first.status, 200); assert.match(first.body.hostId, /^[a-f0-9]{32}$/);
  const id = first.body.hostId;
  assert.deepEqual((await register(secretA, 'Renamed computer')).body, first.body);
  const second = await register(secretB); assert.notEqual(second.body.hostId, id);
  assert.equal((await register(randomBytes(32).toString('hex'))).body.error, 'registration_capacity_reached');
  await assert.rejects(agent(id, secretB), /401/);
  await agent(id, secretA);
  await assert.rejects(agent(id, secretA), /409/);
  await relay.close();
  assert.equal(readFileSync(database).includes(Buffer.from(secretA)), false);
  await start();
  assert.deepEqual((await register(secretA)).body, first.body);
  await agent(id, secretA);
  await relay.close();
  config.registration.enabled = false;
  await start();
  assert.equal((await register(secretA)).body.error, 'registration_disabled');
  await agent(id, secretA);
});

test('registration is opt-in, rate limited and provisioning needs no computer information', async t => {
  let relay = createRelayServer({ allowInsecureLoopback: true });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  assert.equal((await fetch('http://127.0.0.1:' + relay.server.address().port + '/relay/v1/register', { method: 'POST' })).status, 403);
  await relay.close();
  relay = createRelayServer({ allowInsecureLoopback: true, registration: { enabled: true, database: ':memory:' } });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  t.after(() => relay.close());
  const secret = randomBytes(32).toString('hex');
  for (let i = 0; i < 21; i++) {
    const res = await fetch('http://127.0.0.1:' + relay.server.address().port + '/relay/v1/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret }, body: JSON.stringify({ name: 'Synthetic' }),
    });
    assert.equal(res.status, i === 20 ? 429 : 200); await res.arrayBuffer();
  }
  const directory = mkdtempSync(join(tmpdir(), 'dsh-init-'));
  try {
    const out = join(directory, 'private');
    execFileSync(process.execPath, ['src/provision.mjs', out], { stdio: 'ignore', windowsHide: true });
    assert.equal(JSON.parse(readFileSync(join(out, 'server.json'))).registration.enabled, true);
    assert.equal(existsSync(join(out, 'plugin-secret.json')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
