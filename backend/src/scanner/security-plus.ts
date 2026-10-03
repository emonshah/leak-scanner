import dns from 'node:dns/promises';
import tls from 'node:tls';
import * as cheerio from 'cheerio';
import { assertPublicUrl } from '../utils/ssrf';
import { proxyInit } from '../utils/proxy';
import type { FindingInput, ScanArtifacts, SecurityCheck, SecurityStatus } from './types';

/**
 * Defensive security assessment — PASSIVE ONLY. Every check returns an
 * explicit status; "could not verify" is NEVER reported as missing/secure.
 * No exploitation, no brute force, no form submission, no payloads.
 * Well-known public files (robots/security/sitemap) are the only extra
 * fetches, allowlisted and size-capped. Discovered /api/* references are
 * OBSERVED, never probed.
 */

type Risk = SecurityCheck['risk'];

interface Ctx {
  a: ScanArtifacts;
  homeUrl: string;
  host: string;
  isHttps: boolean;
  headers: Record<string, string>;
  headersAvailable: boolean;
}

function mk(
  checkId: string,
  title: string,
  status: SecurityStatus,
  rest: Partial<SecurityCheck> & { owasp: string; automated: SecurityCheck['automated'] },
): SecurityCheck {
  return {
    checkId,
    title,
    status,
    observed: rest.observed ?? null,
    expected: rest.expected ?? '',
    risk: rest.risk ?? 'Info',
    recommendation: rest.recommendation ?? '',
    evidence: rest.evidence ?? {},
    owasp: rest.owasp,
    automated: rest.automated,
  };
}

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const gate = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([p, gate]);
  } finally {
    clearTimeout(timer!);
  }
};

/**
 * Per-record SPF isolation (NOT flat join): a zoho-verification TXT next to
 * the SPF record must never bleed into the SPF evaluation.
 */
export function isolateSpf(txt: string[][]): string | null {
  for (const parts of txt) {
    const rec = parts.join('').trim();
    if (/^v=spf1/i.test(rec)) return rec.slice(0, 200);
  }
  return null;
}

/** Manual-redirect verdict: 3xx counts ONLY when Location targets https. */
export function redirectVerdict(status: number, location: string): 'pass' | 'fail' | 'other' {
  if (status >= 300 && status < 400) {
    return /^https:\/\//i.test(location.trim()) ? 'pass' : 'fail';
  }
  return 'other';
}

async function tinyGet(url: string, ms = 8000, manualRedirect = false): Promise<{ status: number; text: string; headers: Record<string, string> } | null> {
  try {
    await assertPublicUrl(url);
  } catch {
    return null;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: manualRedirect ? 'manual' : 'follow',
      headers: { 'User-Agent': 'ConversionLeakScanner/1.0 (+local audit)' },
      ...proxyInit(),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v.slice(0, 300);
    });
    const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
    return { status: res.status, text: Buffer.from(buf).toString('utf8').slice(0, 8000), headers };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function certInfo(hostname: string): Promise<{
  ok: boolean;
  daysLeft: number | null;
  issuer: string | null;
  subject: string | null;
  note: string;
}> {
  return new Promise((resolve) => {
    const done = (v: { ok: boolean; daysLeft: number | null; issuer: string | null; subject: string | null; note: string }) => resolve(v);
    const timer = setTimeout(() => {
      socket.destroy();
      done({ ok: false, daysLeft: null, issuer: null, subject: null, note: 'TLS handshake timed out' });
    }, 8000);
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname }, () => {
      clearTimeout(timer);
      try {
        // authorize errors surface as socket.authorizationError; still read the cert.
        const cert = socket.getPeerCertificate(true) as unknown as {
          valid_to?: string;
          issuer?: Record<string, string>;
          subject?: Record<string, string>;
        };
        const authErr = (socket as unknown as { authorizationError?: string }).authorizationError;
        const daysLeft = cert.valid_to
          ? Math.round((new Date(cert.valid_to).getTime() - Date.now()) / 86400000)
          : null;
        const flat = (o?: Record<string, string>) =>
          o ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join(',').slice(0, 200) : null;
        done({
          ok: !authErr,
          daysLeft,
          issuer: flat(cert.issuer),
          subject: flat(cert.subject),
          note: authErr ?? 'chain verified by platform trust store',
        });
      } catch (e) {
        done({ ok: false, daysLeft: null, issuer: null, subject: null, note: e instanceof Error ? e.message : 'cert read failed' });
      } finally {
        socket.destroy();
      }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, daysLeft: null, issuer: null, subject: null, note: e.message.slice(0, 120) });
    });
  });
}

function parseHsts(v: string): { maxAge: number; subdomains: boolean; preload: boolean } {
  const low = v.toLowerCase();
  const m = /max-age\s*=\s*(\d+)/.exec(low);
  return {
    maxAge: m ? Number(m[1]) : 0,
    subdomains: low.includes('includesubdomains'),
    preload: low.includes('preload'),
  };
}

function cspIssues(v: string): string[] {
  const issues: string[] = [];
  const low = v.toLowerCase();
  if (/unsafe-inline/.test(low)) issues.push('allows unsafe-inline scripts/styles');
  if (/unsafe-eval/.test(low)) issues.push('allows unsafe-eval');
  if (/(script-src|default-src)[^;]*\*/.test(low)) issues.push('wildcard source in script/default-src');
  if (/data:/.test(low)) issues.push('data: URIs allowed');
  if (/http:/.test(low)) issues.push('plain-http sources allowed');
  if (!/default-src|script-src/.test(low)) issues.push('no default-src/script-src directive');
  return issues;
}

export async function runSecuritySuite(a: ScanArtifacts, homeUrl: string): Promise<SecurityCheck[]> {
  const out: SecurityCheck[] = [];
  const avail = a.availability;
  const home = a.pages.find((p) => p.isHomepage) ?? a.pages[0];
  let host = '';
  try {
    host = new URL(homeUrl).hostname;
  } catch {
    return [mk('target', 'Target URL', 'INCONCLUSIVE', {
      owasp: 'A05', automated: 'AUTOMATED', expected: 'parseable URL',
      recommendation: 'Re-run with a valid http/https URL.',
    })];
  }
  const ctx: Ctx = {
    a,
    homeUrl,
    host,
    isHttps: homeUrl.toLowerCase().startsWith('https'),
    headers: avail?.headers ?? {},
    headersAvailable: !!avail?.ok && Object.keys(avail?.headers ?? {}).length > 0,
  };

  // ---- Transport ----
  if (!avail) {
    out.push(mk('https', 'HTTPS available', 'NOT_TESTED', {
      owasp: 'A02', automated: 'NOT_TESTED', expected: 'site served over HTTPS',
      evidence: { reason: 'no probe response' },
      recommendation: 'Re-run the scan; transport could not be verified.',
    }));
  } else if (!ctx.isHttps) {
    out.push(mk('https', 'HTTPS available', 'FAIL', {
      risk: 'High', owasp: 'A02', automated: 'AUTOMATED',
      observed: 'final URL uses plain HTTP', expected: 'https',
      evidence: { final_url: avail.finalUrl ?? '' },
      recommendation: 'Serve the whole site over HTTPS and redirect HTTP to HTTPS.',
    }));
  } else {
    out.push(mk('https', 'HTTPS available', 'PASS', {
      risk: 'Info', owasp: 'A02', automated: 'AUTOMATED',
      observed: avail.finalUrl, expected: 'https',
      evidence: { final_url: avail.finalUrl ?? '' },
      recommendation: 'Keep enforcing HTTPS everywhere.',
    }));
  }

  // HTTP→HTTPS redirect (one extra safe GET only when seed wasn't http already).
  if (ctx.isHttps && avail?.ok) {
    const probe = await tinyGet(`http://${host}/`, 8000, true);
    if (!probe) {
      out.push(mk('http-redirect', 'HTTP → HTTPS redirect', 'INCONCLUSIVE', {
        owasp: 'A02', automated: 'AUTOMATED', expected: 'http redirects to https',
        evidence: { reason: 'plain-HTTP probe unreachable' },
        recommendation: 'Verify manually that http:// redirects to https://.',
      }));
    } else if (probe.status >= 300 && probe.status < 400) {
      const loc = probe.headers['location'] ?? '';
      if (redirectVerdict(probe.status, loc) === 'pass') {
        out.push(mk('http-redirect', 'HTTP → HTTPS redirect', 'PASS', {
          risk: 'Info', owasp: 'A02', automated: 'AUTOMATED',
          observed: `HTTP ${probe.status} → https`, expected: 'redirect to https',
          evidence: {}, recommendation: 'Keep the redirect in place.',
        }));
      } else {
        out.push(mk('http-redirect', 'HTTP → HTTPS redirect', 'FAIL', {
          risk: 'Medium', owasp: 'A02', automated: 'AUTOMATED',
          observed: `HTTP ${probe.status} redirects elsewhere — not https`,
          expected: 'redirect to https',
          evidence: loc ? { location: loc.slice(0, 120) } : {},
          recommendation: 'Redirect all plain-HTTP traffic to HTTPS.',
        }));
      }
    } else if (probe.status >= 200 && probe.status < 300) {
      out.push(mk('http-redirect', 'HTTP → HTTPS redirect', 'FAIL', {
        risk: 'Medium', owasp: 'A02', automated: 'AUTOMATED',
        observed: `plain HTTP answers HTTP ${probe.status} without redirect`,
        expected: 'redirect to https',
        evidence: {}, recommendation: 'Redirect all plain-HTTP traffic to HTTPS.',
      }));
    } else {
      out.push(mk('http-redirect', 'HTTP → HTTPS redirect', 'WARNING', {
        risk: 'Low', owasp: 'A02', automated: 'AUTOMATED',
        observed: `plain HTTP answers HTTP ${probe.status} (no usable content either)`,
        expected: 'redirect to https',
        evidence: {}, recommendation: 'Redirect all plain-HTTP traffic to HTTPS.',
      }));
    }
  } else {
    out.push(mk('http-redirect', 'HTTP → HTTPS redirect', avail?.ok ? 'WARNING' : 'NOT_TESTED', {
      risk: 'Medium', owasp: 'A02', automated: 'AUTOMATED',
      observed: avail?.ok ? 'site served over plain HTTP' : null,
      expected: 'redirect to https',
      evidence: {}, recommendation: 'Serve over HTTPS first, then enforce the redirect.',
    }));
  }

  // TLS certificate (handshake only — safe).
  if (ctx.isHttps) {
    const cert = await certInfo(host);
    if (cert.daysLeft == null) {
      out.push(mk('tls-cert', 'TLS certificate valid', 'INCONCLUSIVE', {
        owasp: 'A02', automated: 'AUTOMATED', expected: 'valid, matching certificate',
        observed: cert.note, evidence: {},
        recommendation: 'Check the certificate manually in a browser.',
      }));
    } else if (!cert.ok || cert.daysLeft < 0) {
      out.push(mk('tls-cert', 'TLS certificate valid', 'FAIL', {
        risk: 'Critical', owasp: 'A02', automated: 'AUTOMATED',
        observed: cert.note, expected: 'valid, matching certificate',
        evidence: { issuer: cert.issuer ?? '', subject: cert.subject ?? '' },
        recommendation: 'Replace the certificate immediately — browsers block the site.',
      }));
    } else if (cert.daysLeft < 30) {
      out.push(mk('tls-cert', 'TLS certificate valid', 'WARNING', {
        risk: 'Medium', owasp: 'A02', automated: 'AUTOMATED',
        observed: `expires in ${cert.daysLeft} days`, expected: 'valid 30+ days',
        evidence: { issuer: cert.issuer ?? '' },
        recommendation: 'Renew before expiry to avoid a sudden outage.',
      }));
    } else {
      out.push(mk('tls-cert', 'TLS certificate valid', 'PASS', {
        risk: 'Info', owasp: 'A02', automated: 'AUTOMATED',
        observed: `valid ~${cert.daysLeft} more days`, expected: 'valid certificate',
        evidence: { issuer: cert.issuer ?? '' },
        recommendation: 'Renew on schedule.',
      }));
    }
  } else {
    out.push(mk('tls-cert', 'TLS certificate valid', 'NOT_TESTED', {
      owasp: 'A02', automated: 'NOT_TESTED', expected: 'HTTPS first',
      evidence: {}, recommendation: 'Enable HTTPS, then assess the certificate.',
    }));
  }

  // ---- Headers (only when headers were actually retrieved) ----
  const H = (name: string): string | null => ctx.headers[name] ?? null;
  const needHeaders = !ctx.headersAvailable;
  const headerCheck = (
    id: string, title: string, value: string | null, assess: (v: string) => { status: SecurityStatus; observed: string; risk: Risk; recommendation: string },
  ): void => {
    if (needHeaders) {
      out.push(mk(id, title, 'NOT_TESTED', {
        owasp: 'A05', automated: 'NOT_TESTED', expected: 'response headers required',
        evidence: { reason: 'no response headers retrieved' },
        recommendation: 'Re-run; headers could not be verified, not assumed missing.',
      }));
      return;
    }
    if (!value) {
      const d = assess('');
      out.push(mk(id, title, 'FAIL', {
        risk: d.risk, owasp: 'A05', automated: 'AUTOMATED',
        observed: 'header absent', expected: d.observed || 'present',
        evidence: {}, recommendation: d.recommendation,
      }));
      return;
    }
    const d = assess(value);
    out.push(mk(id, title, d.status, {
      risk: d.risk, owasp: 'A05', automated: 'AUTOMATED',
      observed: value.slice(0, 300), expected: d.observed,
      evidence: {}, recommendation: d.recommendation,
    }));
  };

  headerCheck('hsts', 'HSTS enforced', H('strict-transport-security'), (v) => {
    if (!v) return { status: 'FAIL', observed: 'Strict-Transport-Security with long max-age', risk: 'Medium', recommendation: 'Add HSTS with max-age ≥ 31536000; consider includeSubDomains.' };
    const h = parseHsts(v);
    if (h.maxAge < 31536000) return { status: 'WARNING', observed: 'max-age ≥ 31536000', risk: 'Low', recommendation: 'Raise HSTS max-age to at least one year.' };
    return { status: 'PASS', observed: `max-age=${h.maxAge}${h.subdomains ? ' + subdomains' : ''}${h.preload ? ' + preload' : ''}`, risk: 'Info', recommendation: 'Keep HSTS enforced.' };
  });
  headerCheck('csp', 'Content-Security-Policy', H('content-security-policy'), (v) => {
    if (!v) return { status: 'FAIL', observed: 'restrictive policy', risk: 'Low', recommendation: 'Add a restrictive CSP appropriate to the site.' };
    const issues = cspIssues(v);
    if (issues.length > 0) return { status: 'WARNING', observed: 'tight policy without broad sources', risk: 'Low', recommendation: `Tighten CSP: ${issues.join('; ')}.` };
    return { status: 'PASS', observed: 'present without broad sources', risk: 'Info', recommendation: 'Keep the policy restrictive.' };
  });
  headerCheck('framing', 'Clickjacking framing control', H('x-frame-options') ?? (H('content-security-policy')?.includes('frame-ancestors') ? H('content-security-policy')! : null), (v) => {
    if (!v) return { status: 'FAIL', observed: 'X-Frame-Options or frame-ancestors', risk: 'Low', recommendation: 'Deny framing or allow only trusted origins.' };
    return { status: 'PASS', observed: v.slice(0, 120), risk: 'Info', recommendation: 'Keep framing restricted.' };
  });
  headerCheck('content-type', 'MIME-sniffing protection', H('x-content-type-options'), (v) => {
    if (!v) return { status: 'FAIL', observed: 'nosniff', risk: 'Low', recommendation: 'Send X-Content-Type-Options: nosniff.' };
    return { status: /nosniff/i.test(v) ? 'PASS' : 'WARNING', observed: 'nosniff', risk: 'Low', recommendation: 'Send X-Content-Type-Options: nosniff.' };
  });
  headerCheck('referrer', 'Referrer policy', H('referrer-policy'), (v) => {
    if (!v) return { status: 'FAIL', observed: 'restrictive policy', risk: 'Low', recommendation: 'Set a restrictive Referrer-Policy.' };
    return { status: /unsafe-url|no-referrer-when-downgrade/.test(v) ? 'WARNING' : 'PASS', observed: v.slice(0, 120), risk: 'Low', recommendation: 'Prefer strict-origin-when-cross-origin or stricter.' };
  });
  headerCheck('permissions', 'Permissions policy', H('permissions-policy'), (v) => {
    if (!v) return { status: 'FAIL', observed: 'policy restricting camera/mic/geolocation', risk: 'Low', recommendation: 'Consider a Permissions-Policy for sensitive features.' };
    return { status: 'PASS', observed: v.slice(0, 120), risk: 'Info', recommendation: 'Keep least-privilege permissions.' };
  });
  for (const [id, title, hdr] of [
    ['coop', 'Cross-Origin-Opener-Policy', 'cross-origin-opener-policy'],
    ['coep', 'Cross-Origin-Embedder-Policy', 'cross-origin-embedder-policy'],
    ['corp', 'Cross-Origin-Resource-Policy', 'cross-origin-resource-policy'],
  ] as const) {
    headerCheck(id, title, H(hdr), (v) => {
      if (!v) return { status: 'WARNING', observed: 'header present for isolation', risk: 'Low', recommendation: 'Evaluate COOP/COEP/CORP if the site handles sensitive flows.' };
      return { status: 'PASS', observed: v.slice(0, 120), risk: 'Info', recommendation: 'Keep cross-origin isolation headers.' };
    });
  }
  // Server disclosure + CORS (observed headers only).
  const server = H('server');
  const powered = H('x-powered-by') ?? H('x-aspnet-version');
  if (!ctx.headersAvailable) {
    out.push(mk('banner', 'Server version disclosure', 'NOT_TESTED', {
      owasp: 'A05', automated: 'NOT_TESTED', expected: 'headers required',
      evidence: { reason: 'no response headers retrieved' },
      recommendation: 'Re-run; not assumed either way.',
    }));
  } else if (server || powered) {
    out.push(mk('banner', 'Server version disclosure', 'WARNING', {
      risk: 'Low', owasp: 'A05', automated: 'AUTOMATED',
      observed: [server, powered].filter(Boolean).join(' / ')?.slice(0, 200) ?? null,
      expected: 'minimal banners', evidence: {},
      recommendation: 'Hide version details in Server/X-Powered-By headers.',
    }));
  } else {
    out.push(mk('banner', 'Server version disclosure', 'PASS', {
      risk: 'Info', owasp: 'A05', automated: 'AUTOMATED',
      observed: 'no version banner observed', expected: 'minimal banners', evidence: {},
      recommendation: 'Keep banners minimal.',
    }));
  }
  const acao = H('access-control-allow-origin');
  if (acao === '*') {
    out.push(mk('cors', 'CORS wildcard on document', 'WARNING', {
      risk: 'Low', owasp: 'A05', automated: 'AUTOMATED',
      observed: 'Access-Control-Allow-Origin: *', expected: 'scoped origins for credentialed APIs',
      evidence: {}, recommendation: 'Scope CORS to trusted origins where credentials matter. Full CORS posture needs manual review.',
    }));
  } else {
    out.push(mk('cors', 'CORS wildcard on document', ctx.headersAvailable ? 'PASS' : 'NOT_TESTED', {
      risk: 'Info', owasp: 'A05', automated: ctx.headersAvailable ? 'AUTOMATED' : 'NOT_TESTED',
      observed: acao, expected: 'no wildcard on sensitive responses',
      evidence: {}, recommendation: 'Full CORS posture needs manual review.',
    }));
  }

  // ---- Cookies (observable set-cookie only) ----
  const rawCookies = Object.entries(ctx.headers)
    .filter(([k]) => k === 'set-cookie')
    .flatMap(([, v]) => v.split(/,(?=[^;]+?=)/))
    .map((c) => c.trim())
    .filter(Boolean);
  if (rawCookies.length === 0) {
    out.push(mk('cookies', 'Cookie security flags', 'NOT_TESTED', {
      owasp: 'A02', automated: 'NOT_TESTED', expected: 'cookies to inspect',
      evidence: { reason: 'homepage set no observable cookies' },
      recommendation: 'Authenticated cookie posture requires manual review.',
    }));
  } else {
    const bad = rawCookies.filter((c) => !/secure/i.test(c) || !/samesite/i.test(c)).slice(0, 3);
    const broad = rawCookies.filter((c) => /domain=\.[^;]+/i.test(c)).slice(0, 3);
    if (bad.length === 0 && broad.length === 0) {
      out.push(mk('cookies', 'Cookie security flags', 'PASS', {
        risk: 'Info', owasp: 'A02', automated: 'AUTOMATED',
        observed: `${rawCookies.length} cookie(s) with Secure/SameSite`, expected: 'Secure + SameSite',
        evidence: {}, recommendation: 'Keep flags on every cookie.',
      }));
    } else {
      out.push(mk('cookies', 'Cookie security flags', 'WARNING', {
        risk: 'Low', owasp: 'A02', automated: 'AUTOMATED',
        observed: [...bad, ...broad].map((c) => c.split(';')[0] ?? '').join(', ').slice(0, 300) || 'flag gaps',
        expected: 'Secure + HttpOnly + SameSite, narrow Domain',
        evidence: {}, recommendation: 'Add Secure/HttpOnly/SameSite and narrow Domain scope.',
      }));
    }
  }

  // ---- Forms (static, never submitted) ----
  if (a.forms.length === 0) {
    out.push(mk('form-transport', 'Form transport security', 'NOT_TESTED', {
      owasp: 'A02', automated: 'NOT_TESTED', expected: 'forms to inspect',
      evidence: { reason: 'no forms detected' },
      recommendation: 'Nothing to assess automatically.',
    }));
  } else {
    const insecure = a.forms.filter((f) => f.action && /^http:/i.test(f.action));
    const external = a.forms.filter((f) => {
      if (!f.action || !/^https?:/i.test(f.action)) return false;
      try {
        return new URL(f.action).hostname !== host;
      } catch {
        return false;
      }
    });
    const withPassword = home ? /type=["']?password/i.test(home.html) : false;
    if (insecure.length > 0) {
      out.push(mk('form-transport', 'Form transport security', 'FAIL', {
        risk: withPassword ? 'High' : 'Medium', owasp: 'A02', automated: 'AUTOMATED',
        observed: `${insecure.length} form(s) post over plain HTTP`, expected: 'https actions',
        evidence: { pages: insecure.map((f) => f.page).join(', ').slice(0, 300) },
        recommendation: 'Post every form over HTTPS.',
      }));
    } else {
      out.push(mk('form-transport', 'Form transport security', 'PASS', {
        risk: 'Info', owasp: 'A02', automated: 'AUTOMATED',
        observed: 'no plain-HTTP form actions observed', expected: 'https actions',
        evidence: {}, recommendation: 'Keep all form actions on HTTPS.',
      }));
    }
    if (external.length > 0) {
      out.push(mk('form-external', 'External form destination', 'WARNING', {
        risk: 'Low', owasp: 'A08', automated: 'AUTOMATED',
        observed: external.map((f) => f.action).join(', ').slice(0, 300),
        expected: 'known, trusted endpoints',
        evidence: {}, recommendation: 'Confirm each third-party endpoint is expected; never submit test data.',
      }));
    }
    const tokenish = home ? /name=["']?[^"']*(csrf|_token|authenticity)[^"']*["']?/i.test(home.html) : false;
    out.push(mk('csrf', 'CSRF protection indicator', 'REQUIRES_MANUAL_REVIEW', {
      owasp: 'A01', automated: 'MANUAL_REQUIRED',
      observed: tokenish ? 'token-like hidden field observed' : 'no token-like field observed',
      expected: 'server-validated anti-CSRF tokens',
      evidence: {},
      recommendation: 'Verify server-side token validation manually; presence of a field proves nothing.',
    }));
    if (withPassword) {
      out.push(mk('auth', 'Authentication behavior', 'REQUIRES_MANUAL_REVIEW', {
        owasp: 'A07', automated: 'MANUAL_REQUIRED',
        observed: 'password field present', expected: 'manual assessment',
        evidence: {},
        recommendation: 'Credential handling, lockout and session behavior need manual testing. No credential attacks performed.',
      }));
    }
  }

  // ---- Client-side (browser evidence) ----
  const mob = a.browser?.mobile;
  const allResources = [
    ...(mob?.resources ?? []),
    ...(a.browser?.desktop.resources ?? []),
  ];
  const insecureRes = allResources.filter((r) => r.url.startsWith('http://')).slice(0, 5);
  if (!mob || mob.loadError) {
    out.push(mk('mixed-content', 'Mixed content', 'NOT_TESTED', {
      owasp: 'A02', automated: 'NOT_TESTED', expected: 'rendered page required',
      evidence: { reason: mob?.loadError ?? 'browser pass missing' },
      recommendation: 'Re-run; not assumed either way.',
    }));
  } else if (insecureRes.length > 0 || !ctx.isHttps) {
    out.push(mk('mixed-content', 'Mixed content', ctx.isHttps ? 'FAIL' : 'WARNING', {
      risk: 'Medium', owasp: 'A02', automated: 'AUTOMATED',
      observed: insecureRes.map((r) => r.url.slice(0, 120)).join(', ') || 'page itself is plain HTTP',
      expected: 'all sub-resources over https',
      evidence: {}, recommendation: 'Serve every sub-resource over HTTPS.',
    }));
  } else {
    out.push(mk('mixed-content', 'Mixed content', 'PASS', {
      risk: 'Info', owasp: 'A02', automated: 'AUTOMATED',
      observed: 'no plain-HTTP sub-resources observed', expected: 'https-only sub-resources',
      evidence: {}, recommendation: 'Keep third-party embeds on HTTPS.',
    }));
  }
  const thirdParty = [...new Set(
    allResources.map((r) => {
      try {
        const u = new URL(r.url);
        return u.hostname !== host ? u.hostname : null;
      } catch {
        return null;
      }
    }).filter((h): h is string => !!h),
  )].slice(0, 15);
  out.push(mk('third-party', 'Third-party script/resource domains', thirdParty.length > 8 ? 'WARNING' : 'PASS', {
    risk: 'Low', owasp: 'A08', automated: 'AUTOMATED',
    observed: thirdParty.length > 0 ? thirdParty.join(', ').slice(0, 400) : 'none observed',
    expected: 'minimal, known vendors',
    evidence: {}, recommendation: 'Audit each vendor; use SRI for critical scripts. Integrity/supply-chain needs manual review.',
  }));
  const secConsole = [...(mob?.consoleErrors ?? []), ...(a.browser?.desktop.consoleErrors ?? [])]
    .filter((m) => /csp|mixed content|certificate|ssl|blocked/i.test(m))
    .slice(0, 3);
  if (secConsole.length > 0) {
    out.push(mk('console-sec', 'Browser security warnings', 'WARNING', {
      risk: 'Low', owasp: 'A05', automated: 'AUTOMATED',
      observed: secConsole.join(' | ').slice(0, 400), expected: 'clean console',
      evidence: {}, recommendation: 'Resolve each warning; CSP violations especially.',
    }));
  }
  // Source maps: observed references only, never fetched blindly.
  const htmlAll = a.pages.map((p) => p.html).join('\n').slice(0, 500000);
  const mapRefs = [
    ...htmlAll.matchAll(/sourceMappingURL=([^\s'"]+)/g),
    ...allResources.filter((r) => r.url.endsWith('.map')).map((r) => ({ 1: r.url }) as unknown as RegExpMatchArray),
  ].map((m) => (m[1] ?? '').slice(0, 150)).filter(Boolean).slice(0, 3);
  if (mapRefs.length > 0) {
    out.push(mk('sourcemap', 'Source-map exposure', 'WARNING', {
      risk: 'Low', owasp: 'A05', automated: 'AUTOMATED',
      observed: mapRefs.join(', '), expected: 'no public source maps for app bundles',
      evidence: {}, recommendation: 'Remove public source maps or restrict them; verify what they expose.',
    }));
  }
  // Generator meta / disclosure in HTML actually retrieved.
  if (home?.html) {
    const $ = cheerio.load(home.html);
    const gen = ($('meta[name="generator"]').attr('content') ?? '').trim().slice(0, 200);
    if (gen) {
      out.push(mk('generator', 'Generator disclosure', 'WARNING', {
        risk: 'Low', owasp: 'A05', automated: 'AUTOMATED',
        observed: gen, expected: 'no version disclosure',
        evidence: {}, recommendation: 'Remove the generator meta tag or strip versions.',
      }));
    }
    const errPage = /stack trace|traceback|at .*\(.*:\d+:\d+\)|fatal error|exception in/i.test(
      a.pages.map((p) => (p.statusCode ?? 0) >= 500 ? p.html : '').join('\n').slice(0, 100000),
    );
    if (errPage) {
      out.push(mk('verbose-errors', 'Verbose error disclosure', 'WARNING', {
        risk: 'Medium', owasp: 'A05', automated: 'AUTOMATED',
        observed: 'error page contains stack-trace-like text', expected: 'generic error pages',
        evidence: {}, recommendation: 'Replace verbose errors with generic pages; log details server-side.',
      }));
    }
  }

  // ---- Well-known public files (allowlisted, size-capped GETs) ----
  for (const [id, pth, title] of [
    ['robots', '/robots.txt', 'robots.txt present'],
    ['security-txt', '/.well-known/security.txt', 'security.txt present'],
    ['sitemap', '/sitemap.xml', 'sitemap.xml present'],
  ] as const) {
    const r = await tinyGet(`https://${host}${pth}`).catch(() => null);
    if (!r) {
      out.push(mk(id, title, 'INCONCLUSIVE', {
        owasp: 'A05', automated: 'AUTOMATED', expected: 'retrievable or absent',
        evidence: { reason: 'request failed' },
        recommendation: 'Check manually if the file should exist.',
      }));
    } else if (r.status >= 200 && r.status < 300 && r.text.trim().length > 0) {
      out.push(mk(id, title, 'PASS', {
        risk: 'Info', owasp: 'A05', automated: 'AUTOMATED',
        observed: `HTTP ${r.status}, ${r.text.length} bytes`, expected: 'present where useful',
        evidence: {}, recommendation: id === 'security-txt' ? 'Keep contact details current.' : 'Review exposed paths for sensitivity.',
      }));
    } else {
      out.push(mk(id, title, id === 'security-txt' ? 'WARNING' : 'PASS', {
        risk: 'Low', owasp: 'A05', automated: 'AUTOMATED',
        observed: `HTTP ${r.status}`, expected: id === 'security-txt' ? 'present' : 'optional',
        evidence: {}, recommendation: id === 'security-txt' ? 'Consider publishing security.txt.' : 'No action required.',
      }));
    }
  }

  // ---- API surface: OBSERVED ONLY, never probed ----
  const apiRefs = [...new Set([
    ...htmlAll.matchAll(/["'`](\/api\/[^\s"'`]{1,80})/g),
    ...htmlAll.matchAll(/["'`](\/graphql[^\s"'`]{0,40})/g),
  ].map((m) => m[1]).filter(Boolean))].slice(0, 10) as string[];
  if (apiRefs.length > 0) {
    out.push(mk('api-surface', 'Client-referenced API surface', 'REQUIRES_MANUAL_REVIEW', {
      owasp: 'A01', automated: 'MANUAL_REQUIRED',
      observed: apiRefs.join(', ').slice(0, 400), expected: 'reviewed endpoints',
      evidence: {},
      recommendation: 'Review each endpoint manually (auth, rate limits, data exposure). Endpoints were observed, never called.',
    }));
  }

  // ---- DNS / email auth (passive resolution only) ----
  try {
    const [aRecs, mx, txt, ns, caa] = await Promise.all([
      withTimeout(dns.resolve4(host).catch(() => [] as string[]), 6000),
      withTimeout(dns.resolveMx(host).catch(() => [] as { exchange: string }[]), 6000),
      withTimeout(dns.resolveTxt(host).catch(() => [] as string[][]), 6000),
      withTimeout(dns.resolveNs(host).catch(() => [] as string[]), 6000),
      withTimeout(dns.resolveCaa(host).catch(() => [] as unknown[]), 6000),
    ]);
    const spf = isolateSpf(txt);
    let dmarc: string | null = null;
    try {
      const dm = await withTimeout(dns.resolveTxt(`_dmarc.${host}`), 6000);
      dmarc = dm.flat().find((t) => t.startsWith('v=DMARC1'))?.slice(0, 200) ?? null;
    } catch {
      dmarc = null;
    }
    out.push(mk('dns-basic', 'DNS resolution', aRecs.length > 0 ? 'PASS' : 'WARNING', {
      risk: 'Info', owasp: 'A05', automated: 'AUTOMATED',
      observed: `A:${aRecs.length} MX:${mx.length} NS:${ns.length} CAA:${(caa as unknown[]).length}`,
      expected: 'resolvable records', evidence: {},
      recommendation: 'No action unless records look wrong.',
    }));
    if (!spf) {
      out.push(mk('spf', 'SPF record', 'WARNING', {
        risk: 'Low', owasp: 'A05', automated: 'AUTOMATED',
        observed: 'no SPF record', expected: 'v=spf1 policy',
        evidence: {}, recommendation: 'Publish SPF if the domain sends mail; hard-fail (-all) when possible.',
      }));
    } else if (/[+?](all)/.test(spf)) {
      out.push(mk('spf', 'SPF record', 'WARNING', {
        risk: 'Medium', owasp: 'A05', automated: 'AUTOMATED',
        observed: spf, expected: 'restrictive mechanisms, -all preferred',
        evidence: {}, recommendation: 'Tighten SPF; wide-open mechanisms invite spoofing.',
      }));
    } else if (/\~all/.test(spf)) {
      // Softfail is normal small-biz posture — audit trail only, never a
      // client finding (no one buys a patch for "~all"). Low risk is
      // suppressed from findings by RISK_SEV, stays in security_checks.
      out.push(mk('spf', 'SPF record', 'WARNING', {
        risk: 'Low', owasp: 'A05', automated: 'AUTOMATED',
        observed: spf, expected: '-all when ready',
        evidence: {}, recommendation: 'Optional hardening only.',
      }));
    } else {
      out.push(mk('spf', 'SPF record', 'PASS', {
        risk: 'Info', owasp: 'A05', automated: 'AUTOMATED',
        observed: spf, expected: 'restrictive SPF', evidence: {},
        recommendation: 'Keep SPF restrictive.',
      }));
    }
    if (!dmarc) {
      out.push(mk('dmarc', 'DMARC policy', 'WARNING', {
        risk: 'Low', owasp: 'A05', automated: 'AUTOMATED',
        observed: 'no DMARC record', expected: 'v=DMARC1 policy',
        evidence: {}, recommendation: 'Publish DMARC, start at p=none, move to quarantine/reject.',
      }));
    } else {
      const strong = /p=(quarantine|reject)/.test(dmarc);
      out.push(mk('dmarc', 'DMARC policy', strong ? 'PASS' : 'WARNING', {
        risk: strong ? 'Info' : 'Low', owasp: 'A05', automated: 'AUTOMATED',
        observed: dmarc, expected: 'p=quarantine or p=reject',
        evidence: {}, recommendation: strong ? 'Keep enforcing.' : 'Strengthen DMARC toward quarantine/reject.',
      }));
    }
  } catch {
    out.push(mk('dns-basic', 'DNS resolution', 'INCONCLUSIVE', {
      owasp: 'A05', automated: 'AUTOMATED', expected: 'resolvable records',
      evidence: { reason: 'DNS queries failed' },
      recommendation: 'Check DNS manually.',
    }));
  }

  // Injection/authz areas are explicitly out of automation scope.
  out.push(mk('injection', 'Injection testing', 'REQUIRES_MANUAL_REVIEW', {
    owasp: 'A03', automated: 'MANUAL_REQUIRED',
    observed: 'not performed', expected: 'manual assessment',
    evidence: {},
    recommendation: 'SQLi/XSS require authorized manual testing. This tool never sends payloads.',
  }));
  out.push(mk('access-control', 'Access control review', 'REQUIRES_MANUAL_REVIEW', {
    owasp: 'A01', automated: 'MANUAL_REQUIRED',
    observed: 'not performed', expected: 'manual assessment',
    evidence: {},
    recommendation: 'Broken access control cannot be judged from public pages alone.',
  }));

  return out;
}

const RISK_SEV: Record<Risk, FindingInput['severity'] | null> = {
  Critical: 'EMERGENCY',
  High: 'HIGH',
  Medium: 'MEDIUM',
  // Low/Info risks are suppressed from findings (still in security_checks).
  Low: null,
  Info: null,
};

/**
 * Convert suite checks into findings — MONEY-LEAK LAW (see money-leaks.ts).
 * The suite still records every check in security_checks (audit trail for
 * the Security tab), but findings/score/brief only ever carry catalog
 * module::category pairs. The pipeline enforces this with leakFor(), so
 * this legacy allowlist below is advisory only — anything not in the
 * 11-leak catalog is dropped downstream no matter what.
 */
const CATALOG_CHECKS = new Set([
  'https', // P12 insecure fallback
  'http-redirect', // P12 redirect to HTTPS
  'tls-cert', // P12 expiry
  'mixed-content', // P13
  'spf', // P14
  'dmarc', // P14
  'form-transport', // P5 form over insecure transport
]);

export function securityFindings(checks: SecurityCheck[], homeUrl?: string | null): FindingInput[] {
  const out: FindingInput[] = [];
  const home = homeUrl || 'Homepage';
  for (const c of checks) {
    if (c.status !== 'FAIL' && c.status !== 'WARNING') continue;
    if (!CATALOG_CHECKS.has(c.checkId)) continue;
    const sev = RISK_SEV[c.risk];
    if (!sev) continue;
    out.push({
      module: 'security',
      category: c.checkId,
      severity: sev,
      title: c.title,
      description: `${c.observed ?? c.status}. ${c.recommendation}`.slice(0, 500),
      pageUrl: home,
      measuredValue: c.observed?.slice(0, 200),
      evidence: {
        page: 'Homepage',
        details: {
          check: c.checkId,
          status: c.status,
          observed: (c.observed ?? '').slice(0, 300),
          owasp: c.owasp,
        },
      },
    });
  }
  return out;
}
