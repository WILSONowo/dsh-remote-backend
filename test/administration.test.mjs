import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRegistry, verifyRegistry, restoreRegistry } from '../src/registry.mjs';
import { administer } from '../src/admin.mjs';

test('old registry migrates without changing identity; backup/restore preserves revocations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-admin-'));
  const file = join(dir, 'hosts.sqlite'), backup = join(dir, 'backup.sqlite'), restored = join(dir, 'restored.sqlite');
  const token = randomBytes(32).toString('hex'), hash = value => createHash('sha256').update(value).digest('hex');
  const id = hash('dsh-remote-host-v1:' + token).slice(0, 32);
  const legacy = new DatabaseSync(file);
  legacy.exec('CREATE TABLE hosts (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)');
  legacy.prepare('INSERT INTO hosts VALUES (?, ?, ?, ?)').run(id, hash(token), 'Synthetic legacy', 1000); legacy.close();
  let registry;
  try {
    const before = join(dir, 'before.sqlite');
    assert.equal(administer(['backup', '--database', file, '--out', before]).schema, 0);
    const unchanged = new DatabaseSync(file, { readOnly: true });
    assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 0); unchanged.close();
    registry = openRegistry(file, 1);
    assert.equal(registry.register(token, 'Synthetic renamed'), id);
    assert.equal(registry.tokenHash(id), hash(token));
    registry.setStatus(id, 'revoked'); assert.throws(() => registry.register(token, 'retry'), /identity_disabled/);
    assert.equal(registry.cleanup(2000), 1); assert.equal(registry.list()[0].name, 'Synthetic renamed');
    assert.equal(registry.cleanup(2000, true), 1); assert.equal(registry.list()[0].name, '');
    assert.ok(registry.register(randomBytes(32).toString('hex'), 'Replacement'));
    assert.deepEqual(registry.backup(backup), { ok: true, schema: 1, hosts: 2 });
    assert.throws(() => registry.backup(backup), /must not exist/);
    assert.equal(readFileSync(backup).includes(Buffer.from(token)), false);
    assert.equal(restoreRegistry(backup, restored).hosts, 2);
    // A live WAL database also restores from a consistent snapshot, not a bare file copy.
    const liveCopy = join(dir, 'live-copy.sqlite');
    assert.equal(restoreRegistry(file, liveCopy).hosts, 2);
    assert.throws(() => restoreRegistry(backup, restored), /must not exist/);
    const next = openRegistry(restored); try { assert.throws(() => next.register(token, 'retry'), /identity_disabled/); } finally { next.close(); }
    const list = administer(['list', '--database', file]); assert.equal(list.some(x => 'token_hash' in x), false);
    assert.throws(() => administer(['enable', '--database', file, '--id', id]), /cannot be reactivated/);
    const corrupt = join(dir, 'corrupt.sqlite'); writeFileSync(corrupt, 'synthetic invalid data');
    assert.throws(() => verifyRegistry(corrupt));
    assert.throws(() => restoreRegistry(corrupt, join(dir, 'bad-restore.sqlite')));
  } finally { registry?.close(); rmSync(dir, { recursive: true, force: true }); }
});
