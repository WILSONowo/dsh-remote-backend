import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, existsSync, linkSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');

/** A random installation secret determines an opaque ID, so retries are idempotent. */
export function openRegistry(file, maxHosts = 1000) {
  if (!file || !Number.isSafeInteger(maxHosts) || maxHosts < 1) throw new Error('Invalid registration configuration');
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') chmodSync(file, 0o600);
  db.exec('PRAGMA busy_timeout = 2000');
  if (db.prepare('PRAGMA user_version').get().user_version > 1) { db.close(); throw new Error('Unsupported registry schema'); }
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db.prepare('PRAGMA table_info(hosts)').all().map(row => row.name);
    if (!columns.includes('status')) db.exec("ALTER TABLE hosts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    if (!columns.includes('last_seen_at')) {
      db.exec('ALTER TABLE hosts ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0');
      db.exec('UPDATE hosts SET last_seen_at = created_at');
    }
    db.exec('PRAGMA user_version = 1; COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  const get = db.prepare('SELECT token_hash, status FROM hosts WHERE id = ?');
  const validId = id => { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid host ID'); };
  return {
    tokenHash(id) { const row = get.get(id); return row?.status === 'active' ? row.token_hash : undefined; },
    ready() { db.prepare('SELECT COUNT(*) AS n FROM hosts').get(); return true; },
    list: () => db.prepare('SELECT id, name, status, created_at, last_seen_at FROM hosts ORDER BY created_at, id').all(),
    touch(id) { db.prepare("UPDATE hosts SET last_seen_at = ? WHERE id = ? AND status = 'active'").run(Date.now(), id); },
    setStatus(id, status) {
      validId(id);
      if (!['active', 'disabled', 'revoked'].includes(status)) throw new Error('Invalid host status');
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = get.get(id);
        if (!row) throw new Error('Unknown host');
        if (row.status === 'revoked' && status !== 'revoked') throw new Error('Revoked identity cannot be reactivated');
        db.prepare('UPDATE hosts SET status = ? WHERE id = ?').run(status, id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    // Only retired identities are scrubbed. Keep tombstones to prevent re-registration.
    cleanup(before, apply = false) {
      if (!Number.isSafeInteger(before) || before < 0) throw new Error('Invalid cleanup cutoff');
      const count = db.prepare("SELECT COUNT(*) AS n FROM hosts WHERE status = 'revoked' AND last_seen_at < ? AND name != ''").get(before).n;
      if (apply) db.prepare("UPDATE hosts SET name = '' WHERE status = 'revoked' AND last_seen_at < ?").run(before);
      return count;
    },
    backup(destination) {
      if (file !== ':memory:' && resolve(destination) === resolve(file)) throw new Error('Backup destination must not exist');
      return snapshotDatabase(db, destination);
    },
    register(token, name) {
      const id = hash('dsh-remote-host-v1:' + token).slice(0, 32);
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = get.get(id);
        if (existing && existing.status !== 'active') throw new Error('identity_disabled');
        if (!existing) {
          if (db.prepare("SELECT COUNT(*) AS n FROM hosts WHERE status != 'revoked'").get().n >= maxHosts) {
            db.exec('ROLLBACK'); return null;
          }
          db.prepare('INSERT INTO hosts (id, token_hash, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(id, hash(token), name, Date.now(), Date.now());
        } else db.prepare('UPDATE hosts SET name = ? WHERE id = ?').run(name, id);
        db.exec('COMMIT');
        return id;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close: () => db.close(),
  };
}

export function verifyRegistry(file) {
  if (!existsSync(file)) throw new Error('Registry file not found');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Registry integrity check failed');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('Unsupported registry schema');
    const rows = db.prepare('SELECT * FROM hosts').all();
    for (const row of rows) if (!/^[a-f0-9]{32}$/.test(row.id) || !/^[a-f0-9]{64}$/.test(row.token_hash) || typeof row.name !== 'string' ||
      !Number.isSafeInteger(row.created_at) || (version === 1 && (!['active', 'disabled', 'revoked'].includes(row.status) || !Number.isSafeInteger(row.last_seen_at)))) throw new Error('Invalid registry record');
    return { ok: true, schema: version, hosts: rows.length };
  } finally { db.close(); }
}

/** Restore to a NEW path only; never replace a database used by a running process. */
export function restoreRegistry(source, destination) {
  verifyRegistry(source);
  if (existsSync(destination) || existsSync(destination + '-wal') || existsSync(destination + '-shm')) throw new Error('Restore destination must not exist');
  return backupRegistry(source, destination);
}

/** Works before migration too; source schema and records remain unchanged. */
export function backupRegistry(source, destination) {
  if (!existsSync(source)) throw new Error('Registry file not found');
  if (existsSync(destination) || resolve(source) === resolve(destination)) throw new Error('Backup destination must not exist');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    return snapshotDatabase(db, destination);
  } finally { db.close(); }
}

function snapshotDatabase(db, destination) {
  if (['', '-wal', '-shm'].some(suffix => existsSync(destination + suffix))) throw new Error('Backup destination must not exist');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + '.tmp-' + randomUUID();
  try {
    // Reserve a private empty file; VACUUM INTO accepts it and captures WAL contents too.
    closeSync(openSync(temporary, 'wx', 0o600));
    db.prepare('VACUUM INTO ?').run(temporary);
    const result = verifyRegistry(temporary);
    const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
    // Same-directory hard link publishes a complete file atomically and refuses overwrite.
    linkSync(temporary, destination);
    return result;
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
