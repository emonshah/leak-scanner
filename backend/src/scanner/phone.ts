import * as cheerio from 'cheerio';
import type { CrawledPage, CtaObservation, DiscoveredLink, PhoneFinding } from './types';
import { digitsOf, matchDigits, validateDialable, validatePhone, validateTelUri } from './phone-validate';

// Candidate extractor: deliberately loose — libphonenumber decides validity.
// Requires 7+ phone-ish chars so years/zips never reach validation.
const CANDIDATE_RE = /\+?[\d().\s-]{7,}\d(?:\s*(?:ext|x)\s*\d{1,5})?/g;

const FAX_RE = /fax/i;

function digits(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * MODULE 4 — phone/call conversion (hardened).
 * - Extracts candidates from visible copy (script/style removed) plus
 *   JSON-LD telephone (code-only numbers visitors cannot tap).
 * - Validates via libphonenumber-js (US/GB/CA/AU/BD). Invalid strings dropped.
 * - hasTelLink matches on E.164 digits OR raw digits (tracking numbers that
 *   swap text/href still match when they dial the same endpoint).
 * - telMalformed = a tel: link exists for this number but its URI fails
 *   libphonenumber validation (mobile dialer would fail → EMERGENCY).
 */
export function analyzePhones(
  pages: CrawledPage[],
  links: DiscoveredLink[],
  browserObs?: Array<Pick<CtaObservation, 'href' | 'text' | 'clickEffect' | 'clickable' | 'hasOnClick' | 'hasDataAction' | 'hasClickListener'>>,
): PhoneFinding[] {
  // Dial-protocol hrefs: tel: plus callto:/wtai: equivalents (same dialer action).
  const dialHrefDigits = (href: string): string | null => {
    const m = /^(?:tel|callto|wtai):\s*([^;?]+)/i.exec(href.trim());
    return m?.[1] ? digits(m[1]) : null;
  };
  const telE164 = new Set<string>();
  const telRawDigits = new Set<string>();
  let malformedTelCount = 0;
  for (const l of links) {
    const d = dialHrefDigits(l.href);
    if (d === null) continue;
    // Dialable = mobile will attempt it. libphonenumber-assigned check is
    // only for TEXT candidates; applying it to hrefs fabricates "malformed".
    const dialable = validateDialable(l.href.replace(/^(?:callto|wtai):/i, 'tel:'));
    if (dialable !== null) {
      const v = validateTelUri(l.href.replace(/^(?:callto|wtai):/i, 'tel:'));
      telE164.add(v ? digitsOf(v.e164) : dialable);
    } else if (l.kind === 'tel') {
      malformedTelCount++;
    }
    telRawDigits.add(d);
  }

  // Browser dial-proofs (Scan 140 + BD strict fix): the crawler is fetch-only
  // and misses JS-injected / CallRail-swapped / icon-button tel: links that a
  // real phone taps fine. Any browser-observed dial signal counts as a link.
  const browserDialDigits = new Set<string>();
  for (const o of browserObs ?? []) {
    const href = (o.href ?? '').toLowerCase();
    if (/^(tel|callto|wtai):/.test(href)) browserDialDigits.add(digits(o.href ?? ''));
    if ((o.clickEffect === 'dialog' || o.clickEffect === 'popup' || o.clickEffect === 'navigation') && o.text) {
      browserDialDigits.add(digits(o.text));
    }
    if ((o.hasOnClick || o.hasDataAction || o.hasClickListener === true || o.clickable) && o.text && /\d{7,}/.test(o.text)) {
      browserDialDigits.add(digits(o.text));
    }
  }

  // Numbers wrapped in a dial link are tappable EVEN WHEN the digits
  // differ (call-tracking / vanity setup: visible "305-244-5446" dialing a
  // toll-free tracking line, "(855) 60-DAMAGE" buttons). Digit-matching
  // alone calls these "not clickable" — a 100% false positive. Collect the
  // digit runs inside every tel:/callto:/wtai: link's own text per page-set.
  const wrappedTelDigits = new Set<string>();
  for (const page of pages) {
    if (!page.html) continue;
    let $w: cheerio.CheerioAPI;
    try {
      $w = cheerio.load(page.html);
    } catch {
      continue;
    }
    $w('a[href]').each((_i, el) => {
      const href = ($w(el).attr('href') ?? '').trim();
      if (!/^(tel|callto|wtai):/i.test(href)) return;
      const txt = $w(el).text() ?? '';
      CANDIDATE_RE.lastIndex = 0;
      let wm: RegExpExecArray | null;
      while ((wm = CANDIDATE_RE.exec(txt)) !== null) {
        const d = digits(wm[0]);
        if (d.length >= 10 && d.length <= 15) wrappedTelDigits.add(d);
      }
    });
  }

  const out: PhoneFinding[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (!page.html) continue;
    const $ = cheerio.load(page.html);
    // Visible copy only: templates, hidden nodes, inline display:none /
    // visibility:hidden never count (JSON-LD already gone with script).
    // Union of header+main+footer: .first() used to scan ONLY the header,
    // so footer-only numbers vanished into false M3 "no phone anywhere".
    $('script,style,noscript,template,[hidden],[style*="display:none" i],[style*="visibility:hidden" i]').remove();
    const scopeText = ['header', 'main', 'footer', '[class*="contact"]', '[id*="contact"]']
      .map((sel) => $(sel).text())
      .filter((t) => t && t.trim())
      .join('\n');
    const fallback = scopeText.trim() ? '' : $('body').text();
    const text = `${scopeText}\n${fallback}`.replace(/\s+/g, ' ');
    CANDIDATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CANDIDATE_RE.exec(text)) !== null) {
      const raw = m[0].trim();
      // Zip-glued fragment ("33157 (855) 60…"): a leading 5-digit ZIP fused
      // to a partial number is an extraction artifact, never a dial string.
      if (/^\d{5}\s+\(\d/.test(raw)) continue;
      const d = digits(raw);
      if (d.length < 10 || d.length > 15) continue;
      if (/^(19|20)\d{2}$/.test(d)) continue;
      const ctx = text.slice(Math.max(0, m.index - 40), m.index + raw.length + 40);
      if (FAX_RE.test(ctx.slice(0, 12))) continue;
      // Dynamic call-tracking awareness (Master Directive §2): CallRail /
      // Ringba / WhatConverts swap numbers post-paint. If the page loads a
      // tracking script AND the number's digits sit near tracking-managed
      // markup, the tel: wrap resolves at runtime — never flag the snapshot.
      const htmlLower = (page.html ?? '').toLowerCase();
      const trackingOnPage = htmlLower.includes('callrail') || htmlLower.includes('ringba')
        || htmlLower.includes('whatconverts') || htmlLower.includes('invoca')
        || htmlLower.includes('calltracking') || htmlLower.includes('calltrk');
      if (trackingOnPage) {
        // Locate the number's raw text in the markup; a tracking keyword
        // within ±2000 chars means a managed swap context (runtime tel: wrap).
        const at = htmlLower.indexOf(raw.toLowerCase());
        if (at !== -1) {
          const win = htmlLower.slice(Math.max(0, at - 2000), at + raw.length + 2000);
          if (/callrail|ringba|whatconverts|invoca|calltracking|calltrk|data-swap|swap-number|tracking-number/.test(win)) continue;
        }
      }
      const valid = validatePhone(raw);
      if (!valid) continue; // strict: unparseable strings are never findings
      // One finding per dial endpoint (not per page): the same number on
      // five pages is one opportunity, and evidence keeps the first page.
      const key = digitsOf(valid.e164);
      if (seen.has(key)) continue;
      seen.add(key);
      const e164digits = digitsOf(valid.e164);
      // Trunk-normalized: text "(555) 123-4567" matches href "tel:+15551234567",
      // text "+8809638138707" matches href "tel:09638138707" (BD 880→0 trunk),
      // plus any browser-observed dial signal (JS-injected tel: the crawler missed).
      const hasTel = telE164.has(e164digits)
        || [...telE164].some((t) => matchDigits(t, e164digits))
        || [...telRawDigits].some((t) => matchDigits(t, d) || matchDigits(t, e164digits))
        || [...browserDialDigits].some((t) => matchDigits(t, d) || matchDigits(t, e164digits))
        // Wrapped in a dial link (digits may differ: tracking/vanity) —
        // tapping it dials, whatever the href digits say.
        || [...wrappedTelDigits].some((t) => matchDigits(t, d) || matchDigits(t, e164digits));
      out.push({
        raw,
        normalized: valid.e164,
        e164: valid.e164,
        isValid: true,
        page: page.url,
        hasTelLink: hasTel,
        telMalformed: false,
      });
    }
  }

  // JSON-LD / schema.org telephone: machine-readable numbers (e.g.
  // "telephone": "+8801XXXXXXXXX") that visitors can neither see nor tap.
  // Recorded as codeOnly findings — a code-only M4 ("exists but visitors
  // can't reach it"), never M3 ("no phone anywhere"). Visible-text
  // extraction above already removed <script>, so this is the only reader.
  const seenCodeOnly = new Set<string>();
  for (const page of pages) {
    if (!page.html) continue;
    let $ld: cheerio.CheerioAPI;
    try {
      $ld = cheerio.load(page.html);
    } catch {
      continue;
    }
    const collect = (node: unknown): void => {
      if (node == null) return;
      if (typeof node === 'string') {
        const d = digits(node);
        if (d.length >= 10 && d.length <= 15 && !/^(19|20)\d{2}$/.test(d)) {
          const valid = validatePhone(node.trim());
          if (valid) {
            const key = digitsOf(valid.e164);
            if (!seen.has(key) && !seenCodeOnly.has(key)) {
              seenCodeOnly.add(key);
              seen.add(key);
              out.push({
                raw: node.trim().slice(0, 40),
                normalized: valid.e164,
                e164: valid.e164,
                isValid: true,
                page: page.url,
                hasTelLink: false,
                telMalformed: false,
                codeOnly: true,
              });
            }
          }
        }
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) collect(item);
        return;
      }
      if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (/^(telephone|phone|tel|contactPoint)$/i.test(k)) collect(v);
          else if (k === '@graph' || typeof v === 'object') collect(v);
        }
      }
    };
    $ld('script[type="application/ld+json"]').each((_i, el) => {
      const rawText = $ld(el).html() ?? '';
      if (!/telephone|phone/i.test(rawText)) return;
      try {
        collect(JSON.parse(rawText));
      } catch {
        /* malformed JSON-LD — not our claim */
      }
    });
  }
  // Malformed tel: URIs are their own finding signal (dialer fails).
  // Surface one synthetic entry per page-set so buildFindings can flag EMERGENCY.
  if (malformedTelCount > 0) {
    const firstPage = pages.find((p) => p.isHomepage) ?? pages[0];
    if (firstPage) {
      for (const l of links.filter((x) => x.kind === 'tel').slice(0, 3)) {
        if (validateDialable(l.href) !== null) continue;
        const key = `${firstPage.url}::malformed::${l.href.slice(0, 40)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          raw: l.href.slice(0, 40),
          normalized: digits(l.href),
          e164: null,
          isValid: false,
          page: firstPage.url,
          hasTelLink: true,
          telMalformed: true,
        });
      }
    }
  }
  return out;
}

/**
 * Post-browser reconcile (BD strict fix): the content stage runs BEFORE the
 * browser pass, so analyzePhones() only sees crawler links. After runBrowser,
 * re-check every hasTelLink=false number against browser-observed dial
 * signals (tel: hrefs incl. JS-swapped, synthetic-click dialog/popup,
 * JS call-handlers). A match flips hasTelLink=true so buildFindings emits
 * nothing — a number your real phone dials is never a finding.
 * Returns the count reconciled (for logging/quality).
 */
export function reconcilePhoneDialProofs(
  phones: PhoneFinding[],
  observations: Array<Pick<CtaObservation, 'href' | 'text' | 'clickEffect' | 'clickable' | 'hasOnClick' | 'hasDataAction' | 'hasClickListener'>>,
): number {
  const proofs = new Set<string>();
  for (const o of observations) {
    const href = (o.href ?? '').toLowerCase();
    if (/^(tel|callto|wtai):/.test(href)) proofs.add(digits(o.href ?? ''));
    if ((o.clickEffect === 'dialog' || o.clickEffect === 'popup' || o.clickEffect === 'navigation') && o.text) {
      proofs.add(digits(o.text));
    }
    if ((o.hasOnClick || o.hasDataAction || o.hasClickListener === true || o.clickable) && o.text && /\d{7,}/.test(o.text)) {
      proofs.add(digits(o.text));
    }
  }
  if (proofs.size === 0) return 0;
  let fixed = 0;
  for (const p of phones) {
    if (p.hasTelLink || p.telMalformed) continue;
    const d = digits(p.e164 ?? p.normalized ?? p.raw);
    if ([...proofs].some((t) => matchDigits(t, d))) {
      p.hasTelLink = true;
      fixed++;
    }
  }
  return fixed;
}
