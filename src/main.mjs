import { readFileSync } from 'node:fs';
import { createRelayServer } from './server.mjs';

const file = process.env.DSH_RELAY_CONFIG;
if (!file) throw new Error('Set DSH_RELAY_CONFIG to the server configuration JSON file');
const config = JSON.parse(readFileSync(file, 'utf8'));
const tls = config.tls ? { key: readFileSync(config.tls.key), cert: readFileSync(config.tls.cert) } : undefined;
if (!tls && !config.allowInsecureLoopback) throw new Error('TLS certificate required (loopback-only development is explicitly opt-in)');
const bind = !tls ? '127.0.0.1' : config.bind || '127.0.0.1';
const relay = createRelayServer({ ...config, tls });
relay.server.listen(config.port ?? 8443, bind, () => console.log(`DSH relay listening on ${bind}:${relay.server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await relay.close(); process.exit(0); });
