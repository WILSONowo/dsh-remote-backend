import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTls, statusPath } from '../src/operations.mjs';
import { createRelayServer } from '../src/server.mjs';

test('certificate reload accepts matching renewed pair and rejects mismatch without replacing context', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cert-reload-'));
  let relay;
  try {
    const pairs = [1, 2].map(n => {
      const key = join(dir, 'key' + n + '.pem'), cert = join(dir, 'cert' + n + '.pem');
      execFileSync(process.env.OPENSSL_BIN || 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore', windowsHide: true });
      return { key, cert };
    });
    relay = createRelayServer({ registration: { database: ':memory:' }, tls: readTls(pairs[0]) });
    relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
    const request = pair => new Promise((resolve, reject) => {
      const req = https.get('https://127.0.0.1:' + relay.server.address().port + '/healthz', { ca: readFileSync(pair.cert), agent: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
    });
    assert.equal(await request(pairs[0]), 200);
    relay.server.setSecureContext(readTls(pairs[1]));
    assert.equal(await request(pairs[1]), 200); await assert.rejects(request(pairs[0]), /certificate|self.signed/i);
    assert.throws(() => relay.server.setSecureContext(readTls({ key: pairs[0].key, cert: pairs[1].cert })), /mismatch/);
    assert.equal(await request(pairs[1]), 200);
    const bad = join(dir, 'bad.pem'); writeFileSync(bad, 'synthetic invalid certificate');
    assert.throws(() => readTls({ key: pairs[0].key, cert: bad }));
    assert.equal(await request(pairs[1]), 200);
  } finally { await relay?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('status path cannot overwrite database or WAL', () => {
  for (const suffix of ['', '-wal', '-shm']) assert.throws(() => statusPath({ registration: { database: 'synthetic.sqlite' }, statusFile: 'synthetic.sqlite' + suffix }));
  assert.equal(statusPath({ registration: { database: ':memory:' } }), undefined);
  assert.throws(() => statusPath({ registration: { database: ':memory:' }, statusFile: false }));
  assert.throws(() => statusPath({ registration: { database: 'synthetic.sqlite' }, statusFile: 'server.json' }, 'server.json'));
});

test('actual entry point starts from private config and writes draining status on graceful stop', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-entry-'));
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const file = join(dir, 'server.json'), database = join(dir, 'hosts.sqlite');
  writeFileSync(file, JSON.stringify({ port, allowInsecureLoopback: true, registration: { enabled: true, database } }));
  // IPC emits the same signal handler on Windows, where child.kill is forceful.
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import './src/main.mjs'; process.on('message', signal => process.emit(signal));"], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, DSH_RELAY_CONFIG: file }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const exited = once(child, 'exit');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Startup timed out')), 3000);
      child.stdout.on('data', data => { if (data.toString().includes('DSH server started')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.deepEqual(await (await fetch('http://127.0.0.1:' + port + '/readyz')).json(), { ok: true });
    child.send('SIGTERM'); assert.equal((await exited)[0], 0);
    const status = JSON.parse(readFileSync(database + '.status.json', 'utf8'));
    assert.equal(status.draining, true); assert.equal(status.ready, false);
    assert.equal(status.requests, 0); assert.equal(status.sockets, 0);
  } finally {
    if (child.exitCode === null) { child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});
