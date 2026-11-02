import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');

/** A random installation secret determines an opaque ID, so retries are idempotent. */
export function openRegistry(file, maxHosts = 1000) {
  if (!file || !Number.isSafeInteger(maxHosts) || maxHosts < 1) throw new Error('Invalid registration configuration');
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') chmodSync(file, 0o600);
  db.exec('CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)');
  const get = db.prepare('SELECT token_hash FROM hosts WHERE id = ?');
  return {
    tokenHash: id => get.get(id)?.token_hash,
    register(token, name) {
      const id = hash('dsh-remote-host-v1:' + token).slice(0, 32);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!get.get(id)) {
          if (db.prepare('SELECT COUNT(*) AS n FROM hosts').get().n >= maxHosts) {
            db.exec('ROLLBACK'); return null;
          }
          db.prepare('INSERT INTO hosts VALUES (?, ?, ?, ?)').run(id, hash(token), name, Date.now());
        } else db.prepare('UPDATE hosts SET name = ? WHERE id = ?').run(name, id);
        db.exec('COMMIT');
        return id;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close: () => db.close(),
  };
}
