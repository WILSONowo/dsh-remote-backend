import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Creates a NEW directory; refuses legacy per-computer provisioning arguments.
const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length) throw new Error('Usage: node src/provision.mjs NEW_DIRECTORY');
const destination = resolve(directory);
mkdirSync(destination, { mode: 0o700 });
writeFileSync(join(destination, 'server.json'), JSON.stringify({
  bind: '127.0.0.1', port: 8443,
  registration: { enabled: true, database: join(destination, 'hosts.sqlite'), maxHosts: 1000 },
  tls: { cert: '/replace/with/fullchain.pem', key: '/replace/with/privkey.pem' },
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Created server.json for automatic registration. Configure TLS before starting.');
