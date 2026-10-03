import { ProxyAgent } from 'undici';

/**
 * Optional egress proxy for bot-sensitive audits (Phase 2).
 * Set HTTP_PROXY / HTTPS_PROXY (e.g. your own residential/mobile proxy)
 * to route scanner traffic through it. Unset = direct, unchanged behavior.
 * Applies to Playwright launch + all undici fetch call sites. Raw-socket
 * probes (TLS expiry, MX/SMTP verification) stay direct by design.
 */
export function proxyServer(): string | null {
  const raw =
    process.env['HTTP_PROXY'] ??
    process.env['HTTPS_PROXY'] ??
    process.env['http_proxy'] ??
    process.env['https_proxy'] ??
    '';
  const server = raw.trim();
  if (!server) return null;
  try {
    const u = new URL(server.includes('://') ? server : `http://${server}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

let cached: ProxyAgent | null | undefined;

export function proxyDispatcher(): ProxyAgent | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const server = proxyServer();
  if (!server) {
    cached = null;
    return undefined;
  }
  try {
    cached = new ProxyAgent(server);
  } catch {
    cached = null;
  }
  return cached ?? undefined;
}

/** Extra fetch init when a proxy is configured (else {} — zero overhead). */
export function proxyInit(): { dispatcher: ProxyAgent } | Record<string, never> {
  const d = proxyDispatcher();
  return d ? { dispatcher: d } : {};
}
