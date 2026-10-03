import type { AvailabilityResult, FindingInput, SecurityResult } from './types';

/**
 * 16-PROBLEM CATALOG slice: P12 transport fallback + P16 clickjacking ONLY.
 * P12 expiry comes from the direct TLS probe (trust.ts) — this module never
 * duplicates it. HSTS/CSP-general/content-type/referrer/cookies are NOT in
 * the catalog — suppressed. Passive headers only, no probing.
 */
export function evaluateSecurity(
  sec: SecurityResult | null,
  avail: AvailabilityResult | null,
): FindingInput[] {
  const out: FindingInput[] = [];
  const ev = (details: Record<string, string>): FindingInput['evidence'] => ({
    page: 'Homepage',
    details,
  });
  if (!sec) return out;
  // P12: insecure fallback — plain HTTP kills trust + form safety.
  if (!sec.https) {
    out.push({
      module: 'security',
      category: 'transport',
      severity: 'EMERGENCY',
      title: 'Site not served over HTTPS',
      description:
        'The final page URL uses plain HTTP. Browsers warn visitors, forms submit unencrypted, and trust collapses — direct friction for every quote/call conversion.',
      measuredValue: 'http',
      expectedValue: 'https',
      evidence: ev({}),
    });
    return out; // framing checks are meaningless without HTTPS
  }
  // P16: clickjacking — needs BOTH frame controls missing to claim.
  const csp = sec.csp ?? '';
  const hasFrameAncestors = /frame-ancestors/i.test(csp);
  if (!sec.frameOptions && !hasFrameAncestors) {
    out.push({
      module: 'security',
      category: 'framing',
      severity: 'MEDIUM',
      title: 'Missing clickjacking protection',
      description:
        'No X-Frame-Options and no CSP frame-ancestors. The site can be invisibly embedded in an attacker iframe for phishing — add DENY/SAMEORIGIN at server/CDN level.',
      measuredValue: 'no framing controls',
      expectedValue: 'X-Frame-Options: DENY/SAMEORIGIN or CSP frame-ancestors',
      evidence: ev({}),
    });
  }
  void avail;
  return out;
}

/** Build the SecurityResult from a live availability response (headers only). */
export function securityFromAvailability(avail: AvailabilityResult): SecurityResult {
  const h = avail.headers;
  const setCookies = Object.entries(h)
    .filter(([k]) => k === 'set-cookie')
    .map(([, v]) => v);
  // Note: fetch merges duplicate headers; parse what we have.
  const insecure = setCookies
    .flatMap((v) => v.split(/,(?=[^;]+?=)/))
    .map((c) => c.trim())
    .filter((c) => c && (!/secure/i.test(c) || !/httponly/i.test(c)))
    .map((c) => c.split(';')[0] ?? c);
  return {
    https: avail.https,
    hsts: h['strict-transport-security'] ?? null,
    csp: h['content-security-policy'] ?? null,
    frameOptions: h['x-frame-options'] ?? null,
    contentTypeOptions: h['x-content-type-options'] ?? null,
    referrerPolicy: h['referrer-policy'] ?? null,
    insecureCookies: insecure.slice(0, 5),
    certExpiry: avail.certExpiry,
  };
}
