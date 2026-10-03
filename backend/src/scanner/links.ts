import { assertPublicUrl } from '../utils/ssrf';
import { proxyInit } from '../utils/proxy';
import type { DiscoveredLink, LinkCheck } from './types';

const MAX_CHECKS = 60;
const CONCURRENCY = 4;

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Transient (worth one re-try) vs definitive (claim immediately). */
export function isTransient(c: LinkCheck): boolean {
  if (c.status !== null && TRANSIENT_STATUS.has(c.status)) return true;
  const msg = (c.error ?? '').toLowerCase();
  return /timeout|timed out|abort|fetch failed|network|econn|etimedout|enotfound|socket hang up|temporary/i.test(msg);
}

async function checkOnce(link: DiscoveredLink, timeoutMs: number): Promise<LinkCheck> {
  const base: LinkCheck = {
    sourcePage: link.sourcePage,
    text: link.text,
    kind: link.kind,
    importance: link.importance,
    url: link.absoluteUrl ?? link.href,
    status: null,
    finalUrl: null,
    redirectCount: 0,
    broken: false,
    error: null,
  };
  if (!link.absoluteUrl) {
    return { ...base, broken: true, error: 'Unresolvable href' };
  }
  let current: URL;
  try {
    current = await assertPublicUrl(link.absoluteUrl);
  } catch (err) {
    return { ...base, broken: true, error: err instanceof Error ? err.message : 'Blocked target' };
  }

  for (let hop = 0; hop <= 5; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res = await fetch(current.toString(), {
        method: 'HEAD',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'ConversionLeakScanner/1.0 (+local audit)' },
        ...proxyInit(),
      });
      // Some servers reject HEAD — fall back to a ranged GET.
      // Same for 401/403: WAFs, S3 and booking portals (Housecall, Jobber)
      // often refuse HEAD but serve GET fine. A HEAD-only 403 is bot-fear,
      // not a dead page — never EMERGENCY on it.
      if (res.status === 405 || res.status === 501 || res.status === 401 || res.status === 403) {
        await res.arrayBuffer().catch(() => undefined);
        res = await fetch(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: ctrl.signal,
          headers: {
            'User-Agent': 'ConversionLeakScanner/1.0 (+local audit)',
            Range: 'bytes=0-1023',
          },
          ...proxyInit(),
        });
      }
      clearTimeout(timer);
      const status = res.status;
      await res.arrayBuffer().catch(() => undefined);
      if (status >= 300 && status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { ...base, status, broken: true, error: 'Redirect without Location' };
        base.redirectCount++;
        try {
          current = await assertPublicUrl(new URL(loc, current.toString()).toString());
        } catch (err) {
          return { ...base, status, broken: true, error: err instanceof Error ? err.message : 'Redirect blocked' };
        }
        continue;
      }
      const broken = status >= 400;
      return {
        ...base,
        status,
        finalUrl: current.toString(),
        broken,
        error: broken ? `HTTP ${status}` : null,
      };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        broken: true,
        error: /abort/i.test(msg) ? `Timeout after ${timeoutMs}ms` : msg,
      };
    }
  }
  return { ...base, broken: true, error: 'Excessive redirect chain (>5)' };
}

/**
 * Retry wrapper: transient failures (timeout/network/429/5xx) get max 2
 * extra attempts with backoff; definitive answers (404/SSRF-block/loop)
 * are claimed immediately. SSRF guard stays inside every attempt.
 */
async function checkOne(link: DiscoveredLink, timeoutMs: number): Promise<LinkCheck> {
  let pRetry: (fn: () => Promise<LinkCheck>, opts: Record<string, unknown>) => Promise<LinkCheck>;
  try {
    pRetry = (await import('p-retry')).default as typeof pRetry;
  } catch {
    return checkOnce(link, timeoutMs); // retry lib unavailable — single attempt
  }
  let attempts = 0;
  const out = await pRetry(
    async () => {
      attempts++;
      const r = await checkOnce(link, timeoutMs);
      // Throw ONLY on transient: p-retry then backs off and retries.
      // Definitive broken (404 etc.) returns straight through, no hammering.
      if (r.broken && isTransient(r)) throw new Error(r.error ?? `HTTP ${r.status ?? 'transient'}`);
      return r;
    },
    { retries: 2, factor: 2, minTimeout: 800, maxTimeout: 5000 },
  ).catch((e: unknown) => ({
    sourcePage: link.sourcePage,
    text: link.text,
    kind: link.kind,
    importance: link.importance,
    url: link.absoluteUrl ?? link.href,
    status: null,
    finalUrl: null,
    redirectCount: 0,
    broken: true,
    error: e instanceof Error ? `Still failing after retries: ${e.message.slice(0, 120)}` : 'Still failing after retries',
  }));
  return { ...out, attempts };
}

/**
 * MODULE 3 — broken-link checker. Important (nav/cta/contact) links first,
 * bounded count, small concurrency. Passive HEAD/GET only.
 */
export async function checkLinks(
  links: DiscoveredLink[],
  timeoutMs = 10000,
): Promise<LinkCheck[]> {
  const http = links.filter((l) => l.kind === 'internal' || l.kind === 'external');
  const rank = (l: DiscoveredLink) =>
    l.importance === 'cta' ? 0 : l.importance === 'contact' ? 1 : l.importance === 'nav' ? 2 : 3;
  const ordered = [...http].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_CHECKS);
  const out: LinkCheck[] = new Array(ordered.length);
  let i = 0;
  async function worker(): Promise<void> {
    while (i < ordered.length) {
      const idx = i++;
      out[idx] = await checkOne(ordered[idx]!, timeoutMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ordered.length) }, worker));
  return out;
}
