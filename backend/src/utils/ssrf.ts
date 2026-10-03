import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
]);

const METADATA_PREFIXES = ['169.254.', '100.100.100.200', 'fd00:ec2::254'];

/** True for loopback / private / link-local / reserved ranges. */
export function isPrivateIp(ip: string): boolean {
  if (!net.isIP(ip)) return false;
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    const [a, b] = o as [number, number, number, number];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a >= 224) return true; // multicast + reserved
    for (const p of METADATA_PREFIXES) if (ip.startsWith(p)) return true;
    return false;
  }
  // IPv6: loopback, unique-local, link-local
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fc') || low.startsWith('fd')) return true;
  if (low.startsWith('fe80')) return true;
  return false;
}

export function hostnameLooksInternal(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h === 'localhost') return true;
  if (net.isIP(h)) return isPrivateIp(h);
  // Single-label hostnames (intranet) are out of scope for public audits
  if (!h.includes('.')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  return false;
}

/**
 * Resolve + verify the target is a public host. Throws on SSRF risk.
 * MUST be called for the seed URL and every redirect hop (rebinding-safe).
 *
 * Test escape hatch: SCAN_ALLOW_PRIVATE=1 disables private-IP/port checks so
 * the operator can scan a local fixture server. NEVER enable in any other
 * context; default is deny.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`SSRF guard: malformed URL (${rawUrl.slice(0, 80)})`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('SSRF guard: only http/https targets allowed');
  }
  if (u.username || u.password) {
    throw new Error('SSRF guard: credentials in URL are not allowed');
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  const allowPrivate = process.env['SCAN_ALLOW_PRIVATE'] === '1';
  if (!allowPrivate && ![80, 443, 8080, 8443].includes(port)) {
    throw new Error(`SSRF guard: port ${port} is not allowed`);
  }
  if (!allowPrivate && hostnameLooksInternal(u.hostname)) {
    throw new Error(`SSRF guard: internal hostname blocked (${u.hostname})`);
  }
  let addrs: string[];
  try {
    addrs = (await dns.lookup(u.hostname, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    throw new Error(`SSRF guard: DNS resolution failed (${u.hostname})`);
  }
  if (!allowPrivate && (addrs.length === 0 || addrs.some(isPrivateIp))) {
    throw new Error(`SSRF guard: target resolves to a private address (${u.hostname})`);
  }
  return u;
}
