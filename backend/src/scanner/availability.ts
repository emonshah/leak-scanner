import tls from 'node:tls';
import { assertPublicUrl } from '../utils/ssrf';
import { proxyInit } from '../utils/proxy';
import type { AvailabilityResult, RedirectHop } from './types';

const MAX_REDIRECTS = 5;
const BLOCK_MARKERS = [
  'captcha',
  'cloudflare',
  'just a moment',
  'verify you are human',
  'are you a robot',
  'request blocked',
  'access denied',
  'datadome',
  'perimeterx',
  'kasada',
  'attention required',
  'cf-chl',
  '__cf_bm',
  'incapsula',
  'akamai',
  'sucuri',
  'challenge-platform',
  'human verification',
  'unusual traffic',
  'rate limited',
  'error code: 1015',
];
// Statuses whose body is worth sniffing for bot-protection markers.
// Cloudflare's "Just a moment" challenge rides on 503 — without the sniff
// it falls through to 'unavailable' and becomes a false "site is down".
const SNIFF_STATUSES = new Set([403, 429, 503]);

function certExpiry(hostname: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname }, () => {
      clearTimeout(timer);
      try {
        const cert = socket.getPeerCertificate();
        const exp = (cert as { valid_to?: string }).valid_to ?? null;
        resolve(exp ? new Date(exp).toISOString() : null);
      } catch {
        resolve(null);
      } finally {
        socket.destroy();
      }
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

const RETRY_DELAY_MS = 2500;

/**
 * Retry policy (pure, unit-tested): only transient network outcomes are
 * retried. Deterministic outcomes are trusted on first sight —
 * 'blocked' (bot protection won't lift in 2.5s; retrying is rude),
 * 'unavailable' (a real HTTP status is an answer, not a flake).
 * EXCEPTION (handled in checkAvailability, not here): a bare 5xx gets one
 * confirmation probe — cheap shared hosts flap single 500/502s, and one
 * hiccup must never become a "your site is down" cold email.
 */
export function shouldRetryAvailability(status: AvailabilityResult['status']): boolean {
  return status === 'timeout' || status === 'failed';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * MODULE 1 — passive availability probe with one retry on transient
 * network failure. A single timeout/DNS blip must never become a
 * "your site is down" cold email: EMERGENCY fires only when TWO
 * attempts fail. The final error names both attempts as evidence.
 */
export async function checkAvailability(
  seedUrl: string,
  timeoutMs = 20000,
): Promise<AvailabilityResult> {
  const first = await probeOnce(seedUrl, timeoutMs);
  // Single 5xx blip guard: a lone 500/502/503/504 from a cheap host gets
  // one confirmation probe before anyone claims the site is down.
  const flaky5xx =
    first.status === 'unavailable' &&
    (first.httpStatus ?? 0) >= 500 &&
    (first.httpStatus ?? 0) < 600;
  // Rate-limit blocks (429/1015-style, bare 503) often lift within seconds —
  // one delayed retry earns real scans. Challenge pages (the 'Blocked by
  // bot protection' errors) never lift: retrying those is rude AND useless.
  // NOTE: match the error PREFIX, not keywords — the no-marker message
  // itself contains the word "verify" ("verify manually").
  const rateLimitBlocked =
    first.status === 'blocked' &&
    /^(HTTP (429|503))/.test(first.error ?? '');
  if (!shouldRetryAvailability(first.status) && !flaky5xx && !rateLimitBlocked) {
    return { ...first, attempts: 1 };
  }
  await sleep(rateLimitBlocked ? 15000 : RETRY_DELAY_MS);
  const second = await probeOnce(seedUrl, timeoutMs);
  if (second.ok) return { ...second, attempts: 2 };
  const firstErr = first.error ?? first.status;
  const secondErr = second.error ?? second.status;
  return {
    ...second,
    attempts: 2,
    error: `${secondErr} (confirmed on 2 attempts; first: ${firstErr})`,
    incompleteReason: second.incompleteReason ?? secondErr,
  };
}

async function probeOnce(
  seedUrl: string,
  timeoutMs = 20000,
): Promise<AvailabilityResult> {
  const fail = (
    status: AvailabilityResult['status'],
    error: string,
    partial?: Partial<AvailabilityResult>,
  ): AvailabilityResult => ({
    ok: false,
    status,
    httpStatus: null,
    finalUrl: null,
    https: seedUrl.toLowerCase().startsWith('https'),
    redirectChain: [],
    redirectCount: 0,
    responseTimeMs: null,
    ttfbMs: null,
    headers: {},
    certExpiry: null,
    error,
    incomplete: true,
    incompleteReason: error,
    attempts: 1,
    ...partial,
  });

  let current: URL;
  try {
    current = await assertPublicUrl(seedUrl);
  } catch (err) {
    return fail('failed', err instanceof Error ? err.message : 'Invalid target');
  }

  const chain: RedirectHop[] = [];
  const started = Date.now();
  let firstByteAt = 0;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const hopStart = Date.now();
    try {
      const res = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'ConversionLeakScanner/1.0 (+local audit; contact site owner)',
          Accept: 'text/html,application/xhtml+xml',
        },
        ...proxyInit(),
      });
      clearTimeout(timer);
      if (firstByteAt === 0) firstByteAt = Date.now();

      const status = res.status;
      if (status >= 300 && status < 400) {
        const loc = res.headers.get('location');
        await res.arrayBuffer().catch(() => undefined);
        if (!loc) {
          return fail('failed', `Redirect (${status}) without Location header`, {
            redirectChain: chain,
            redirectCount: chain.length,
          });
        }
        chain.push({ url: current.toString(), status });
        if (chain.length > MAX_REDIRECTS) {
          return fail('failed', `Excessive redirect chain (>${MAX_REDIRECTS})`, {
            redirectChain: chain,
            redirectCount: chain.length,
          });
        }
        let next: URL;
        try {
          next = new URL(loc, current.toString());
        } catch {
          return fail('failed', 'Unparseable redirect Location', {
            redirectChain: chain,
            redirectCount: chain.length,
          });
        }
        try {
          current = await assertPublicUrl(next.toString());
        } catch (err) {
          return fail('blocked', err instanceof Error ? err.message : 'Redirect target blocked', {
            redirectChain: chain,
            redirectCount: chain.length,
          });
        }
        continue;
      }

      // Final response
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (JSON.stringify(headers).length < 20000) headers[k.toLowerCase()] = v.slice(0, 500);
      });
      const cfMitigated = (res.headers.get('cf-mitigated') ?? '').toLowerCase();
      const bodyText =
        SNIFF_STATUSES.has(status)
          ? (await res.text().catch(() => '')).slice(0, 4000).toLowerCase()
          : '';
      await res.arrayBuffer().catch(() => undefined);
      const totalMs = Date.now() - started;

      if (SNIFF_STATUSES.has(status) || cfMitigated === 'challenge') {
        const marker = BLOCK_MARKERS.find((m) => bodyText.includes(m));
        if (marker || cfMitigated === 'challenge') {
          return {
            ok: false,
            status: 'blocked',
            httpStatus: status,
            finalUrl: current.toString(),
            https: current.protocol === 'https:',
            redirectChain: chain,
            redirectCount: chain.length,
            responseTimeMs: totalMs,
            ttfbMs: firstByteAt - started,
            headers,
            certExpiry: null,
            error: `Blocked by bot protection (${marker ?? 'cf-mitigated: challenge'})`,
            incomplete: true,
            incompleteReason: 'blocked',
            attempts: 1,
          };
        }
        // Refused without a block marker (WAF geo-block, scanner-IP deny,
        // login wall): the scanner cannot audit it, but no human-facing
        // outage is proven. 'blocked' = silence, never a "site is down"
        // cold email. Genuine persistent 5xx stays 'unavailable' below.
        if (status === 403 || status === 429) {
          return {
            ok: false,
            status: 'blocked',
            httpStatus: status,
            finalUrl: current.toString(),
            https: current.protocol === 'https:',
            redirectChain: chain,
            redirectCount: chain.length,
            responseTimeMs: totalMs,
            ttfbMs: firstByteAt - started,
            headers,
            certExpiry: null,
            error: `HTTP ${status} without page content (likely bot/WAF refusal — verify manually)`,
            incomplete: true,
            incompleteReason: 'blocked',
            attempts: 1,
          };
        }
      }

      const u = new URL(current.toString());
      const cert =
        current.protocol === 'https:' ? await certExpiry(u.hostname, 8000) : null;
      const ok = status >= 200 && status < 400;
      return {
        ok,
        status: ok ? 'available' : 'unavailable',
        httpStatus: status,
        finalUrl: current.toString(),
        https: current.protocol === 'https:',
        redirectChain: chain,
        redirectCount: chain.length,
        responseTimeMs: totalMs,
        ttfbMs: firstByteAt - started,
        headers,
        certExpiry: cert,
        error: ok ? null : `HTTP ${status}`,
        incomplete: false,
        incompleteReason: null,
        attempts: 1,
      };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      void hopStart;
      if (/abort/i.test(msg)) {
        return fail('timeout', `No response within ${timeoutMs}ms`, {
          redirectChain: chain,
          redirectCount: chain.length,
        });
      }
      return fail('failed', msg, { redirectChain: chain, redirectCount: chain.length });
    }
  }
  return fail('failed', `Excessive redirect chain (>${MAX_REDIRECTS})`, {
    redirectChain: chain,
    redirectCount: chain.length,
  });
}
