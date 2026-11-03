import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { X509Certificate, createPrivateKey } from 'node:crypto';

export function readTls(config) {
  if (!config) return undefined;
  const key = readFileSync(config.key), cert = readFileSync(config.cert);
  const certificate = new X509Certificate(cert);
  if (!certificate.checkPrivateKey(createPrivateKey(key))) throw new Error('tls_key_mismatch');
  if (Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now()) throw new Error('tls_certificate_expired_or_not_yet_valid');
  return { key, cert };
}

export function statusPath(config, configFile) {
  if (!config.registration || typeof config.registration.database !== 'string') throw new Error('Registration database required');
  if (config.statusFile !== undefined && (typeof config.statusFile !== 'string' || !config.statusFile.trim())) throw new Error('Invalid statusFile');
  const path = config.statusFile ?? (config.registration.database === ':memory:' ? undefined : config.registration.database + '.status.json');
  if (path && ['', '-wal', '-shm'].some(suffix => resolve(path) === resolve(config.registration.database + suffix))) throw new Error('Status file overlaps registry');
  if (path && [configFile, config.tls?.key, config.tls?.cert].filter(Boolean).some(file => resolve(path) === resolve(file))) throw new Error('Status file overlaps configuration or certificate');
  return path;
}

/** Private aggregate snapshot; no IPs, host IDs, names, paths, credentials or request data. */
export function startStatusWriter(file, snapshot, interval = 5000) {
  if (!file) return { close: async () => {}, flush: async () => {} };
  let pending = Promise.resolve(), failed = false;
  const write = () => {
    pending = pending.then(async () => {
      const temporary = file + '.tmp-' + process.pid;
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify({ ...snapshot(), statusWriteFailed: failed }) + '\n', { mode: 0o600 });
        await rename(temporary, file); failed = false;
      } catch { failed = true; await unlink(temporary).catch(() => {}); }
    });
    return pending;
  };
  const timer = setInterval(write, interval); timer.unref(); void write();
  return { flush: write, async close() { clearInterval(timer); await write(); } };
}
