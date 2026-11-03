import { BlockList, isIP } from 'node:net';

export const DEFAULTS = Object.freeze({
  maxSockets: 512, maxAgents: 256, maxRequests: 256, maxRequestsPerHost: 48,
  maxFiles: 8, maxFilesPerHost: 2, fileBytesPerSecond: 262144,
  requestsPerMinute: 600, registrationsPerMinute: 20, maxRateEntries: 4096,
  requestTimeout: 60000, fileIdleTimeout: 60000, streamIdleTimeout: 120000,
  handshakeTimeout: 15000, duplicateProbeTimeout: 1500, revocationInterval: 500,
  shutdownTimeout: 5000, maxBodyBytes: 67108864,
});

export function normalizeOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('Invalid server configuration');
  if (Object.hasOwn(options, 'hosts')) throw new Error('Static hosts are no longer supported; back up and remove hosts, then configure registration.database');
  if (!options.registration?.database) throw new Error('Registration database required');
  const result = { ...options };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = options[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error(`Invalid ${key}`);
    result[key] = value;
  }
  if (result.maxRequestsPerHost > 64) throw new Error('maxRequestsPerHost exceeds protocol channel limit (64)');
  if (result.maxFilesPerHost >= result.maxRequestsPerHost || result.maxFiles >= result.maxRequests) throw new Error('File limits must leave capacity for control requests');
  if (options.registration.enabled !== undefined && typeof options.registration.enabled !== 'boolean') throw new Error('Invalid registration.enabled');
  if (options.allowInsecureLoopback !== undefined && typeof options.allowInsecureLoopback !== 'boolean') throw new Error('Invalid allowInsecureLoopback');
  result.trustProxy = trustedProxy(options.trustedProxies ?? []);
  return result;
}

export const normalizeIp = value => typeof value === 'string' && value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
export const isLoopback = value => ['127.0.0.1', '::1'].includes(normalizeIp(value));

function trustedProxy(entries) {
  if (!Array.isArray(entries) || entries.length > 128) throw new Error('Invalid trustedProxies');
  const list = new BlockList();
  for (const entry of entries) {
    if (typeof entry !== 'string') throw new Error('Invalid proxy address');
    const parts = entry.split('/'), address = normalizeIp(parts[0]), family = isIP(address);
    if (!family || parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) throw new Error('Invalid proxy CIDR');
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (parts.length === 1) list.addAddress(address, type);
    else {
      const prefix = Number(parts[1]);
      if (prefix < 1 || prefix > (family === 4 ? 32 : 128)) throw new Error('Invalid proxy prefix');
      list.addSubnet(address, prefix, type);
    }
  }
  return value => { const ip = normalizeIp(value), family = isIP(ip || ''); return !!family && list.check(ip, family === 4 ? 'ipv4' : 'ipv6'); };
}

/** Walk from the directly connected proxy toward the first untrusted hop. */
export function clientAddress(req, trust) {
  const peer = normalizeIp(req.socket.remoteAddress);
  if (!trust(peer)) return peer;
  const header = req.headers['x-forwarded-for'];
  if (header === undefined) return peer;
  if (typeof header !== 'string' || header.length > 2048) throw new Error('Invalid forwarded address');
  const chain = header.split(',').map(x => normalizeIp(x.trim()));
  if (chain.length > 16 || chain.some(ip => !isIP(ip))) throw new Error('Invalid forwarded address');
  let current = peer;
  for (let i = chain.length - 1; i >= 0 && trust(current); i--) current = chain[i];
  return current;
}
