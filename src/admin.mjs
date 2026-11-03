import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openRegistry, restoreRegistry, verifyRegistry, backupRegistry } from './registry.mjs';

export function administer(args) {
  const [command, ...rest] = args, options = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!['--database', '--id', '--out', '--source', '--before', '--file', '--apply'].includes(key) || key in options) throw new Error('Invalid command arguments');
    options[key] = key === '--apply' ? true : rest[++i];
    if (!options[key] || typeof options[key] === 'string' && options[key].startsWith('--')) throw new Error('Missing command argument');
  }
  const requireOption = name => { if (!options[name]) throw new Error(`Required: ${name}`); return options[name]; };
  if (command === 'verify') return verifyRegistry(requireOption('--source'));
  if (command === 'backup') return backupRegistry(requireOption('--database'), requireOption('--out'));
  if (command === 'restore') return restoreRegistry(requireOption('--source'), requireOption('--out'));
  if (command === 'status') {
    const value = JSON.parse(readFileSync(requireOption('--file'), 'utf8'));
    const ageMs = Date.now() - value.updatedAt;
    if (!Number.isFinite(ageMs) || ageMs < 0) throw new Error('Invalid status snapshot');
    return { ...value, ageMs, stale: ageMs > 15000 };
  }
  if (!['list', 'disable', 'enable', 'revoke', 'cleanup', 'backup'].includes(command)) throw new Error('Commands: list, disable, enable, revoke, cleanup, backup, verify, restore, status');
  const file = requireOption('--database');
  if (!existsSync(file)) throw new Error('Registry file not found');
  const registry = openRegistry(file);
  try {
    if (command === 'list') return registry.list();
    if (command === 'backup') return registry.backup(requireOption('--out'));
    if (command === 'cleanup') {
      const before = Date.parse(requireOption('--before'));
      if (!Number.isSafeInteger(before) || before > Date.now()) throw new Error('Invalid cleanup date');
      return { matched: registry.cleanup(before, !!options['--apply']), applied: !!options['--apply'] };
    }
    registry.setStatus(requireOption('--id'), { disable: 'disabled', enable: 'active', revoke: 'revoked' }[command]);
    return { ok: true };
  } finally { registry.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(administer(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.code ? 'Registry operation failed (' + error.code + ')' : error.message); process.exitCode = 1; }
}
