import tls from 'node:tls';
import dns from 'node:dns/promises';
import * as cheerio from 'cheerio';
import type { BrowserResult, CrawledPage, FindingInput, FormInfo } from './types';

/**
 * TRUST & CONVERSION LEAK CHECKS — the 16-problem catalog's deterministic core.
 *
 * Every function here is pure/side-effect-free EXCEPT checkSpfDmarc and
 * probeTlsExpiry (read-only network probes with hard timeouts; failure yields
 * NO finding — INCONCLUSIVE, never a guess).
 *
 * Problem keys (see MASTER DIRECTIVE §2):
 *  P6  mobile input keyboard misconfiguration (MEDIUM)
 *  P8  broken booking widget embed (HIGH)
 *  P10 overlapping tap targets (HIGH)
 *  P12 SSL expiry / insecure fallback (EMERGENCY <7d or expired, HIGH 7–14d)
 *  P13 mixed content on HTTPS host (MEDIUM)
 *  P14 SPF/DMARC spoofing risk (HIGH)
 */

const ev = (
  page: string,
  details: Record<string, string>,
  viewport?: string,
): FindingInput['evidence'] => ({ page, viewport, details });

// ─── P6: input keyboard misconfiguration ────────────────────────────────

function isPhoneLike(name: string): boolean {
  return /phone|tel|mobile|cell|fax/i.test(name);
}

function isEmailLike(name: string): boolean {
  return /e-?mail/i.test(name);
}

/** Flag phone/email inputs stuck on type=text (desktop QWERTY on mobile). */
export function analyzeInputKeyboards(forms: FormInfo[]): FindingInput[] {
  const out: FindingInput[] = [];
  for (const f of forms.slice(0, 5)) {
    const bad: string[] = [];
    for (const field of f.fields) {
      const t = (field.type ?? 'text').toLowerCase();
      if (isPhoneLike(field.name) && t !== 'tel') {
        bad.push(`"${field.name || '(unnamed)'}" asks for a phone number but uses type="${t || 'text'}"`);
      } else if (isEmailLike(field.name) && t !== 'email') {
        bad.push(`"${field.name || '(unnamed)'}" asks for an email but uses type="${t || 'text'}"`);
      }
    }
    if (bad.length === 0) continue;
    out.push({
      module: 'forms',
      category: 'input-keyboard',
      severity: 'MEDIUM',
      title: `Mobile keyboard misconfigured on ${bad.length} field${bad.length === 1 ? '' : 's'}`,
      description:
        'Phone/email inputs without the correct type bring up the full desktop keyboard on mobile instead of the dialpad/email pad — measurable drop-off friction. Set type="tel" for phone and type="email" for email.',
      pageUrl: f.page,
      measuredValue: bad[0]?.slice(0, 200),
      expectedValue: 'type="tel" for phone, type="email" for email',
      evidence: ev(f.page, { fields: bad.slice(0, 3).join(' | ').slice(0, 400) }),
    });
  }
  return out.slice(0, 3);
}

// ─── P8: booking widget embeds ──────────────────────────────────────────

const BOOKING_HOSTS = [
  'calendly.com',
  'housecallpro.com',
  'jobber.com',
  'getjobber.com',
  'acuityscheduling.com',
  'schedulicity.com',
  'square.site',
  'squareup.com/appointments',
  'booksy.com',
  'vagaro.com',
  'mindbodyonline.com',
  'setmore.com',
  'simplybook.me',
  'leadconnectorhq.com',
  'msgsndr.com',
  'typeform.com',
  'forms.hubspot.com',
  'servicetitan.com',
];

export interface EmbedRef {
  src: string;
  host: string;
  page: string;
  hiddenInMarkup: boolean;
}

/** Extract third-party scheduler iframes from crawled HTML. */
export function extractEmbeds(pages: CrawledPage[]): EmbedRef[] {
  const out: EmbedRef[] = [];
  for (const page of pages) {
    if (!page.html) continue;
    const $ = cheerio.load(page.html);
    $('iframe').each((_i, el) => {
      const src = ($(el).attr('src') ?? '').trim();
      if (!src) return;
      let host = '';
      try {
        host = new URL(src, page.url).hostname.toLowerCase();
      } catch {
        return;
      }
      if (!BOOKING_HOSTS.some((h) => host.includes(h))) return;
      const style = `${$(el).attr('style') ?? ''} ${$(el).attr('class') ?? ''}`.toLowerCase();
      const hidden =
        /display\s*:\s*none|visibility\s*:\s*hidden/.test(style) ||
        $(el).attr('height') === '0' ||
        $(el).attr('width') === '0';
      out.push({ src: src.slice(0, 300), host, page: page.url, hiddenInMarkup: hidden });
    });
  }
  return out.slice(0, 5);
}

/**
 * A booking embed is broken ONLY with corroborating failure evidence:
 * hidden markup, a failed/blocked request to the embed host, or a console
 * error naming the host. Embed present + clean load = NO finding.
 */
export function analyzeBookingEmbeds(
  embeds: EmbedRef[],
  browser: BrowserResult | null,
  homeUrl: string,
): FindingInput[] {
  const out: FindingInput[] = [];
  if (embeds.length === 0) return out;
  const failedHosts: string[] = [
    ...(browser?.mobile?.failedRequests ?? []).map((r) => r.url.toLowerCase()),
    ...(browser?.desktop?.failedRequests ?? []).map((r) => r.url.toLowerCase()),
  ];
  const consoleText = [
    ...(browser?.mobile?.consoleErrors ?? []),
    ...(browser?.mobile?.jsErrors ?? []),
    ...(browser?.desktop?.jsErrors ?? []),
  ]
    .join(' | ')
    .toLowerCase();
  for (const e of embeds) {
    const netFail = failedHosts.some((u) => u.includes(e.host));
    const consoleFail = consoleText.includes(e.host);
    if (!e.hiddenInMarkup && !netFail && !consoleFail) continue;
    const why = e.hiddenInMarkup
      ? 'the embed markup is hidden (display:none / zero size)'
      : netFail
        ? `a network request to ${e.host} failed or was blocked`
        : `the page console reports an error from ${e.host}`;
    out.push({
      module: 'booking',
      category: 'booking-embed',
      severity: 'HIGH',
      title: `Booking widget fails to render (${e.host})`,
      description: `A scheduler embed (${e.host}) is present but ${why}. Visitors see an empty box instead of a calendar — online bookings silently stop.`,
      pageUrl: e.page,
      measuredValue: e.hiddenInMarkup ? 'embed hidden in markup' : `embed host failure (${e.host})`,
      expectedValue: 'visible, interactive booking calendar',
      evidence: ev(e.page ?? homeUrl, { embed_src: e.src.slice(0, 300), host: e.host }),
    });
  }
  return out.slice(0, 3);
}

// ─── P10: overlapping tap targets ───────────────────────────────────────

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Gap between two boxes (0 when they intersect). */
function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.max(dx, dy);
}

function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

/**
 * Fat-finger friction: two VISIBLE tappable elements whose 390px boxes
 * intersect or sit <8px apart. Pairwise over CTA observations (the money
 * buttons) — deterministic, evidence-backed, capped.
 */
export function analyzeTapTargets(browser: BrowserResult | null, homeUrl: string): FindingInput[] {
  const out: FindingInput[] = [];
  const m = browser?.mobile;
  if (!m || m.loadError) return out;
  const vis = m.ctaObservations.filter((o) => o.verdict === 'VISIBLE' && o.box && o.box.width > 0 && o.box.height > 0);
  const seen = new Set<string>();
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i]!;
      const b = vis[j]!;
      const boxA = a.box as Box;
      const boxB = b.box as Box;
      const gap = boxGap(boxA, boxB);
      if (!boxesIntersect(boxA, boxB) && gap >= 8) continue;
      const key = [a.text, b.text].sort().join('::').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // B3 corroboration: axe target-size ran on the same live page.
      // axe violations>0 => independent engine agrees => HIGH stands.
      // axe clean (0 nodes) => hand rule may misfire => MEDIUM verify-note.
      // axe absent (null) => no corroboration either way => HIGH stands.
      const axeNodes = m.targetSize?.nodes;
      const axeClean = axeNodes === 0;
      out.push({
        module: 'mobile-ui',
        category: 'tap-targets',
        severity: axeClean ? 'MEDIUM' : 'HIGH',
        title: `Overlapping tap targets ("${a.text.slice(0, 30)}" / "${b.text.slice(0, 30)}")`,
        description: axeClean
          ? `Two tappable elements ${boxesIntersect(boxA, boxB) ? 'overlap' : `sit ${Math.round(gap)}px apart (<8px)`} at 390px width, but axe target-size (24px) found nothing — verify on a real phone before outreach.`
          : `Two tappable elements ${boxesIntersect(boxA, boxB) ? 'overlap' : `sit ${Math.round(gap)}px apart (<8px)`} at 390px width. Visitors aiming for the phone/quote button can mis-tap into the wrong action.`,
        pageUrl: homeUrl,
        measuredValue: boxesIntersect(boxA, boxB) ? 'boxes intersect' : `${Math.round(gap)}px gap`,
        expectedValue: '≥8px separation between tap targets',
        evidence: ev('Homepage', { target_a: a.text.slice(0, 80), target_b: b.text.slice(0, 80), box_json: JSON.stringify({ x: Math.round(boxA.x), y: Math.round(boxA.y), width: Math.round(boxA.width), height: Math.round(boxA.height) }), ...(axeClean ? { axe_target_size: 'clean' } : {}) }, '390x844'),
      });
      if (out.length >= 3) return out;
    }
  }
  return out;
}

// ─── P13: mixed content ─────────────────────────────────────────────────

const HTTP_URL_RE = /http:\/\//i;

/** http:// sub-resources on an HTTPS host (DOM + observed network). */
export function analyzeMixedContent(
  pages: CrawledPage[],
  browser: BrowserResult | null,
  https: boolean,
  homeUrl: string,
): FindingInput[] {
  const out: FindingInput[] = [];
  if (!https) return out; // plain-HTTP sites own a bigger problem (P12 transport)
  const hits = new Map<string, string>(); // url -> page
  for (const page of pages.slice(0, 12)) {
    if (!page.html) continue;
    const $ = cheerio.load(page.html);
    $('script[src],img[src],link[href],iframe[src],form[action]').each((_i, el) => {
      const u = ($(el).attr('src') ?? $(el).attr('href') ?? $(el).attr('action') ?? '').trim();
      if (!HTTP_URL_RE.test(u)) return;
      try {
        const abs = new URL(u, page.url);
        if (abs.protocol !== 'http:') return;
        if (!hits.has(abs.toString())) hits.set(abs.toString(), page.url);
      } catch {
        /* skip unparseable */
      }
    });
    if (hits.size >= 5) break;
  }
  for (const r of browser?.mobile.resources ?? []) {
    if (/^http:\/\//i.test(r.url) && hits.size < 8) {
      try {
        const u = new URL(r.url);
        if (!hits.has(r.url)) hits.set(r.url.slice(0, 300), homeUrl);
        void u;
      } catch {
        /* skip */
      }
    }
  }
  let n = 0;
  for (const [url, page] of hits) {
    out.push({
      module: 'security',
      category: 'mixed-content',
      severity: 'MEDIUM',
      title: `Mixed content over HTTP (${url.slice(0, 60)}…)`,
      description:
        'An HTTPS page loads a script, form, or asset over plain HTTP. Browsers can block it or show a security shield — the affected section silently breaks.',
      pageUrl: page,
      measuredValue: url.slice(0, 200),
      expectedValue: 'all sub-resources over https://',
      evidence: ev(page, { insecure_url: url.slice(0, 300) }),
    });
    if (++n >= 3) break;
  }
  return out;
}

// ─── P14: SPF / DMARC (async probes, INCONCLUSIVE on failure) ───────────

export interface MailAuthResult {
  host: string;
  spf: string | null;
  dmarc: string | null;
  error: string | null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Passive DNS TXT lookup. Never throws — failure means "not testable". */
export async function checkSpfDmarc(hostname: string): Promise<MailAuthResult> {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  let spf: string | null = null;
  let dmarc: string | null = null;
  try {
    const txts = await withTimeout(dns.resolveTxt(host), 5000);
    for (const parts of txts) {
      const rec = parts.join('').trim();
      if (/^v=spf1/i.test(rec) && !spf) spf = rec.slice(0, 300);
    }
  } catch {
    /* INCONCLUSIVE — no finding */
    return { host, spf: null, dmarc: null, error: 'spf lookup failed' };
  }
  try {
    const dm = await withTimeout(dns.resolveTxt(`_dmarc.${host}`), 5000);
    for (const parts of dm) {
      const rec = parts.join('').trim();
      if (/^v=dmarc1/i.test(rec) && !dmarc) dmarc = rec.slice(0, 300);
    }
  } catch {
    /* SPF known, DMARC unknown — still reportable as missing DMARC */
  }
  return { host, spf, dmarc, error: null };
}

export function spfDmarcFindings(r: MailAuthResult, homeUrl: string): FindingInput[] {
  const out: FindingInput[] = [];
  if (r.error && !r.spf && !r.dmarc) return out; // INCONCLUSIVE — never guess
  if (!r.spf) {
    out.push({
      module: 'security',
      category: 'email-auth',
      severity: 'HIGH',
      title: `Missing SPF record (${r.host})`,
      description:
        'No SPF record published. Spammers can send fake mail as info@<domain> and receivers cannot tell — the domain risks blacklisting and lost quote replies.',
      pageUrl: homeUrl,
      measuredValue: 'no v=spf1 TXT record',
      expectedValue: 'valid v=spf1 record',
      evidence: ev(homeUrl, { host: r.host, check: 'TXT/v=spf1' }),
    });
  }
  if (!r.dmarc) {
    out.push({
      module: 'security',
      category: 'email-auth',
      severity: 'HIGH',
      title: `Missing DMARC policy (${r.host})`,
      description:
        'No DMARC policy at _dmarc.<domain>. Even with SPF, receivers cannot enforce spoof rejection — phishing mail keeps landing in client inboxes.',
      pageUrl: homeUrl,
      measuredValue: 'no _dmarc TXT record',
      expectedValue: 'v=DMARC1 with p=quarantine/reject',
      evidence: ev(homeUrl, { host: r.host, check: 'TXT/_dmarc' }),
    });
  } else if (/p\s*=\s*none/i.test(r.dmarc)) {
    out.push({
      module: 'security',
      category: 'email-auth',
      severity: 'HIGH',
      title: `DMARC policy not enforced (${r.host})`,
      description:
        'DMARC exists but stays at p=none (report-only). Spoofed mail is still delivered — move to quarantine/reject once legitimate senders are aligned.',
      pageUrl: homeUrl,
      measuredValue: 'p=none',
      expectedValue: 'p=quarantine or p=reject',
      evidence: ev(homeUrl, { host: r.host, dmarc: r.dmarc.slice(0, 200) }),
    });
  }
  return out.slice(0, 2);
}

// ─── P12: TLS expiry probe ──────────────────────────────────────────────

export interface TlsProbe {
  host: string;
  daysLeft: number | null;
  issuer: string | null;
  error: string | null;
}

/** Direct tls.connect expiry read. Failure → INCONCLUSIVE (no finding). */
export function probeTlsExpiry(hostname: string, port = 443, ms = 8000): Promise<TlsProbe> {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: TlsProbe): void => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish({ host, daysLeft: null, issuer: null, error: 'timeout' }), ms);
    try {
      const sock = tls.connect(
        { host, port, servername: host, rejectUnauthorized: false, timeout: ms },
        () => {
          try {
            const cert = sock.getPeerCertificate(true) as { valid_to?: string; issuer?: Record<string, string> };
            if (!cert || !cert.valid_to) {
              finish({ host, daysLeft: null, issuer: null, error: 'no certificate' });
            } else {
              const daysLeft = Math.round((new Date(cert.valid_to).getTime() - Date.now()) / 86400000);
              const issuer = cert.issuer ? Object.values(cert.issuer).join(' ').slice(0, 120) : null;
              finish({ host, daysLeft, issuer, error: null });
            }
          } catch {
            finish({ host, daysLeft: null, issuer: null, error: 'parse failed' });
          } finally {
            clearTimeout(timer);
            sock.destroy();
          }
        },
      );
      sock.on('error', () => {
        clearTimeout(timer);
        finish({ host, daysLeft: null, issuer: null, error: 'connect failed' });
      });
      sock.on('timeout', () => {
        clearTimeout(timer);
        sock.destroy();
        finish({ host, daysLeft: null, issuer: null, error: 'timeout' });
      });
    } catch {
      clearTimeout(timer);
      finish({ host, daysLeft: null, issuer: null, error: 'probe failed' });
    }
  });
}

export function tlsFindings(p: TlsProbe, homeUrl: string): FindingInput[] {
  if (p.error != null || p.daysLeft == null) return [];
  if (p.daysLeft < 0) {
    return [
      {
        module: 'security',
        category: 'tls',
        severity: 'EMERGENCY',
        title: 'TLS certificate expired',
        description: `The certificate for ${p.host} expired ${Math.abs(p.daysLeft)} days ago. Browsers show a full-page "connection is not private" warning — 100% of incoming leads bounce until fixed.`,
        pageUrl: homeUrl,
        measuredValue: `expired ${Math.abs(p.daysLeft)} days ago`,
        expectedValue: 'valid certificate',
        evidence: ev(homeUrl, { host: p.host }),
      },
    ];
  }
  if (p.daysLeft < 7) {
    return [
      {
        module: 'security',
        category: 'tls',
        severity: 'EMERGENCY',
        title: `TLS certificate expires in ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}`,
        description: `Only ${p.daysLeft} days left on ${p.host}. A lapse triggers the browser warning wall — renew now before leads flatline.`,
        pageUrl: homeUrl,
        measuredValue: `${p.daysLeft} days left`,
        expectedValue: '>14 days validity',
        evidence: ev(homeUrl, { host: p.host }),
      },
    ];
  }
  if (p.daysLeft < 14) {
    return [
      {
        module: 'security',
        category: 'tls',
        severity: 'HIGH',
        title: `TLS certificate expires in ${p.daysLeft} days`,
        description: `Renew ${p.host} within two weeks to avoid a sudden outage that stops all conversions.`,
        pageUrl: homeUrl,
        measuredValue: `${p.daysLeft} days left`,
        expectedValue: '>14 days validity',
        evidence: ev(homeUrl, { host: p.host }),
      },
    ];
  }
  return [];
}
