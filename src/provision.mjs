import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Creates a NEW directory; refuses to overwrite any existing deployment.
const [directory, hostId, serverUrl] = process.argv.slice(2);
if (directory && !hostId && !serverUrl) {
  const destination = resolve(directory);
  mkdirSync(destination, { mode: 0o700 });
  writeFileSync(join(destination, 'server.json'), JSON.stringify({
    bind: '127.0.0.1', port: 8443,
    registration: { enabled: true, database: join(destination, 'hosts.sqlite'), maxHosts: 1000 },
    tls: { cert: '/replace/with/fullchain.pem', key: '/replace/with/privkey.pem' },
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created server.json for automatic registration. Configure TLS before starting.');
  process.exit(0);
}
if (!directory || !/^[A-Za-z0-9_-]{1,64}$/.test(hostId || '')) throw new Error('Usage: node src/provision.mjs NEW_DIRECTORY HOST_ID https://relay.example.com:8443');
const url = new URL(serverUrl);
if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Server URL must be a root HTTPS origin');
const destination = resolve(directory);
mkdirSync(destination, { mode: 0o700 });
const registrationToken = randomBytes(32).toString('hex');
const save = (name, data) => writeFileSync(join(destination, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
save('server.json', {
  bind: '127.0.0.1', port: 8443,
  hosts: { [hostId]: createHash('sha256').update(registrationToken).digest('hex') },
  tls: { cert: '/replace/with/fullchain.pem', key: '/replace/with/privkey.pem' },
});
save('plugin-secret.json', { enabled: true, serverUrl: url.origin, hostId, registrationToken, caFile: '' });
console.log('Created server.json and plugin-secret.json in ' + destination + '. Configure certificate paths before starting. Credentials were not printed.');
