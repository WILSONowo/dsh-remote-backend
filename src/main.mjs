import { readFileSync } from 'node:fs';
import { createRelayServer } from './server.mjs';
import { normalizeOptions } from './config.mjs';
import { readTls, statusPath, startStatusWriter } from './operations.mjs';
import { isIP } from 'node:net';

const file = process.env.DSH_RELAY_CONFIG;
if (!file) throw new Error('Set DSH_RELAY_CONFIG to the server configuration JSON file');
const config = JSON.parse(readFileSync(file, 'utf8'));
const tls = readTls(config.tls);
if (!tls && !config.allowInsecureLoopback) throw new Error('TLS certificate required (loopback-only development is explicitly opt-in)');
const bind = !tls ? '127.0.0.1' : config.bind || '127.0.0.1';
if (!isIP(bind) || !Number.isInteger(config.port ?? 8443) || (config.port ?? 8443) < 1 || (config.port ?? 8443) > 65535) throw new Error('Invalid bind or port');
const statusFile = statusPath(config, file);
const relay = createRelayServer({ ...config, tls });
const ignored = normalizeOptions({ ...config, tls }).ignoredOptions;
if (ignored.length) console.warn('Ignoring options from relay protocol 1 (the server no longer sees HTTP): ' + ignored.join(', '));
const status = startStatusWriter(statusFile, relay.snapshot);
relay.server.listen(config.port ?? 8443, bind, () => console.log('DSH server started'));
let stopping;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping ??= (async () => { await relay.close(); await status.close(); process.exit(0); })();
});
process.on('SIGHUP', () => {
  if (!tls || stopping) return;
  try { relay.server.setSecureContext(readTls(config.tls)); console.log('TLS certificate reloaded'); }
  catch { console.error('TLS reload failed; existing certificate retained'); }
});
