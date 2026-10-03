import { evaluatePerformance } from './performance';
import { evaluateSecurity } from './security';
import { megaGroupFor } from './niches';
import { leakFor } from './money-leaks';
import { matchDigits, validateDialable } from './phone-validate';
import { analyzeBookingEmbeds, analyzeTapTargets, extractEmbeds } from './trust';
import { selectHiddenCtaClaims } from './visibility';
import type {
  FindingInput,
  FormInfo,
  OpportunityBreakdown,
  ScanArtifacts,
  Severity,
} from './types';

/**
 * Deterministic finding engine + opportunity score.
 *
 * STRICT MONEY-LEAK CATALOG (see money-leaks.ts). Only problems a small
 * business will pay to fix are ever emitted:
 *  M1 site down/timeout · M2 trust warning (HTTP/dying cert) ·
 *  M3 no callable phone anywhere · M4 phone not tappable/malformed ·
 *  M5 blocked/hidden mobile CTA · M6 no CTA above the fold ·
 *  M7 dead quote/call/booking destination · M8 form goes nowhere /
 *  dead contact path · M9 long friction form · M10 mobile slowness ·
 *  M11 broken mobile layout · M12 colliding tap targets ·
 *  M13 unlabeled form fields · M14 missing SPF/DMARC.
 *
 * Dropped for good: clickjacking, CVE/version disclosures,
 * xmlrpc, author enumeration, directory listing, input keyboards,
 * mixed content, generic JS errors. A final catalog
 * guard in buildFindings() enforces this fail-closed.
 *
 * TRIAGE: EMERGENCY = 30 pts, HIGH = 15, MEDIUM = 6. LOW/INFO suppressed.
 * Score = min(100, sum). Same input → same score. Conflicting evidence →
 * INCONCLUSIVE (no finding), never a guess.
 */
const WEIGHTS: Record<Severity, number> = {
  EMERGENCY: 30,
  HIGH: 15,
  MEDIUM: 6,
};

const ev = (
  page: string,
  details: Record<string, string>,
  viewport?: string,
): FindingInput['evidence'] => ({ page, viewport, details });

interface EvBox { x: number; y: number; width: number; height: number }
interface EvShot { file: string; kind: string; box: EvBox }

/** All close-up clips captured in the mobile pass (may be undefined). */
function evShotsOf(a: ScanArtifacts): EvShot[] {
  const shots = a.browser?.mobile.evShots;
  return Array.isArray(shots) ? (shots as EvShot[]) : [];
}

function boxIoU(x: EvBox, y: EvBox): number {
  const ix = Math.max(0, Math.min(x.x + x.width, y.x + y.width) - Math.max(x.x, y.x));
  const iy = Math.max(0, Math.min(x.y + x.height, y.y + y.height) - Math.max(x.y, y.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const union = x.width * x.height + y.width * y.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Link a finding to its red-marked close-up clip: same-kind best IoU match
 * first (≥0.3), else any-kind strong overlap (≥0.5). Returns the filename or
 * undefined when no clip covers the box (e.g. capped targets).
 */
function shotFor(shots: EvShot[], kind: string, box: EvBox | null | undefined): string | undefined {
  if (!box || box.width <= 0 || box.height <= 0) return undefined;
  let best: EvShot | null = null;
  let bestScore = 0;
  for (const s of shots) {
    if (s.kind !== kind) continue;
    const score = boxIoU(box, s.box);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  if (best && bestScore >= 0.3) return best.file;
  for (const s of shots) {
    const score = boxIoU(box, s.box);
    if (score >= 0.5) return s.file;
  }
  return undefined;
}

function availabilityFindings(a: ScanArtifacts, out: FindingInput[]): void {
  const av = a.availability;
  // LOW/INFO suppressed: untested/blocked probes are represented by scan
  // status (failed/blocked) + quality counts, never by noise findings.
  if (!av || av.status === 'blocked') return;
  if (av.status === 'timeout') {
    out.push({
      module: 'availability', category: 'reachability', severity: 'EMERGENCY',
      title: `Website timed out (no response within limit)`,
      description: 'The server never answered. Visitors on mobile networks will abandon before any call or quote action.',
      measuredValue: av.error ?? 'timeout',
      evidence: ev('Homepage', { attempts: String(av.attempts ?? 1) }),
    });
    return;
  }
  if (av.status === 'unavailable' || av.status === 'failed' || !av.ok) {
    out.push({
      module: 'availability', category: 'reachability', severity: 'EMERGENCY',
      title: `Website unavailable (${av.httpStatus != null ? `HTTP ${av.httpStatus}` : av.error ?? 'connection failed'})`,
      description: 'The site cannot be reached or returns an error page. Every conversion path is broken until this is fixed.',
      pageUrl: av.finalUrl ?? undefined,
      measuredValue: av.httpStatus != null ? `HTTP ${av.httpStatus}` : av.error ?? 'failed',
      evidence: ev('Homepage', { attempts: String(av.attempts ?? 1) }),
    });
    return;
  }
  // Redirect chains are NOT in the 16-problem catalog — suppressed.
}

/** Canonical destination key: /quote, /quote/, /quote?fbclid=.. are ONE
 *  dead page — one finding, first evidence kept (mirror of formSig). */
function destKey(url: string): string {
  try {
    const u = new URL(url);
    const path = (u.pathname.replace(/\/$/, '') || '/').toLowerCase();
    return `${u.protocol}//${u.hostname.toLowerCase().replace(/^www\./, '')}${path}`;
  } catch {
    return url.replace(/\/$/, '').toLowerCase();
  }
}

function linkFindings(a: ScanArtifacts, out: FindingInput[]): void {
  // P4 ONLY: broken primary quote/call action links. Generic nav/internal/
  // external broken links are NOT in the catalog — suppressed.
  const seenDest = new Set<string>();
  for (const c of a.linkChecks.filter((l) => l.broken).slice(0, 25)) {
    const conv = c.importance === 'cta' || c.importance === 'contact';
    if (!conv) continue;
    const key = destKey(c.url);
    if (seenDest.has(key)) continue;
    seenDest.add(key);
    const severity: Severity = 'EMERGENCY';
    out.push({
      module: 'links',
      category: 'conversion-link',
      severity,
      title: `Broken quote/contact link (${c.status != null ? `HTTP ${c.status}` : c.error ?? 'failed'})`,
      description: `"${c.text.slice(0, 80) || '(no link text)'}" on ${c.sourcePage} points to a ${c.status != null ? `page returning HTTP ${c.status}` : 'destination that could not be loaded'}. High-intent visitors hit a dead end.`,
      pageUrl: c.sourcePage,
      measuredValue: c.status != null ? `HTTP ${c.status}` : c.error ?? 'failed',
      evidence: ev(c.sourcePage, { destination: c.url.slice(0, 300), link_text: c.text.slice(0, 120) }),
    });
  }
}

function phoneFindings(a: ScanArtifacts, out: FindingInput[], home: string, mega: 'EMERGENCY' | 'BOOKING'): void {
  // Malformed tel: URIs stay EMERGENCY (dialer fails everywhere).
  const malformed = a.phones.filter((p) => p.telMalformed).slice(0, 3);
  for (const p of malformed) {
    out.push({
      module: 'phone',
      category: 'call',
      severity: 'EMERGENCY',
      title: `Phone link is malformed — mobile dialer will fail (${p.raw.slice(0, 30)})`,
      description:
        'A tel: link was found but its number fails validation (US/UK/CA/AU/BD). Tapping it on mobile produces a dialer error — direct call loss.',
      pageUrl: p.page,
      measuredValue: p.raw,
      expectedValue: 'valid tel:+E.164 number',
      evidence: ev(p.page, { phone: p.raw, tel_link: 'malformed' }, '390x844'),
    });
  }
  // Preferred truth: browser hit-test offenders (real visibility + box).
  // EMERGENCY for emergency niches, HIGH for others.
  // Anti-false-positive filter (call-tracking reality): an offender is NOT
  // a leak when (a) its digits trunk-match a known dial path (proof or any
  // crawler/browser dial href), or (b) the site already has a working
  // tap-to-call path and the offender is NOT the header number (footer/body
  // plain-text mentions next to working Call buttons are not money leaks —
  // owners tap the button and it dials). Fully filtered => fall through to
  // crawler logic instead of returning.
  const sev: FindingInput['severity'] = mega === 'EMERGENCY' ? 'EMERGENCY' : 'HIGH';
  const stripDigits = (s: string): string => (s ?? '').replace(/\D/g, '');
  const siteDialDigits = new Set<string>();
  for (const l of a.links) {
    const href = (l.href ?? '').trim();
    if (/^(tel|callto|wtai):/i.test(href) && validateDialable(href) !== null) {
      siteDialDigits.add(stripDigits(href));
    }
  }
  for (const vp of [a.browser?.mobile, a.browser?.tablet, a.browser?.desktop]) {
    for (const o of vp?.ctaObservations ?? []) {
      const href = (o.href ?? '').trim();
      if (/^(tel|callto|wtai):/i.test(href)) siteDialDigits.add(stripDigits(href));
    }
  }
  const hitProofs = a.browser?.mobile.phoneHitTest?.proofs ?? [];
  for (const p of hitProofs) siteDialDigits.add(stripDigits(p.tel));
  const siteHasWorkingTel = siteDialDigits.size > 0;
  const hit = a.browser?.mobile.phoneHitTest;
  const shots = evShotsOf(a);
  if (hit && hit.offenders.length > 0) {
    const live = hit.offenders.filter((o) => {
      const d = stripDigits(o.text);
      if (d && [...siteDialDigits].some((t) => matchDigits(t, d))) return false;
      if (siteHasWorkingTel && o.scope !== 'header') return false;
      return true;
    });
    if (live.length > 0) {
    for (const o of live.slice(0, 3)) {
      const details: Record<string, string> = { phone_text: o.text, selector: o.selector, box_json: JSON.stringify(o.box) };
      const shot = shotFor(shots, 'phone', o.box);
      if (shot) details['screenshot'] = shot;
      out.push({
        module: 'phone',
        category: 'call',
        severity: sev,
        title: 'Broken Phone Dialer: Plain-Text Header Number',
        description:
          'A phone number is visibly rendered in the header/hero with no working tel: link on it or its direct ancestor (verified in a real mobile viewport). Visitors must memorize or copy the number instead of tapping to call — direct call loss.',
        pageUrl: home,
        measuredValue: o.text,
        expectedValue: `tel:+E.164 number`,
        evidence: ev('Homepage', details, '390x844'),
      });
    }
    return;
    }
  }
  // Code-only numbers (JSON-LD/schema telephone): the number exists in
  // page code but no visitor can see or tap it. Sharper than M3 — the
  // owner HAS a number, it just never reaches a thumb. HIGH, capped.
  const codeOnly = a.phones.filter((p) => p.codeOnly && !p.hasTelLink && !p.telMalformed).slice(0, 3);
  for (const p of codeOnly) {
    out.push({
      module: 'phone',
      category: 'call',
      severity: sev,
      title: `Phone number exists but visitors can't reach it (${p.raw.slice(0, 30)})`,
      description:
        'The number lives only in page code (structured data) with no visible, tappable phone link anywhere on the site. Search engines may know it, but mobile visitors cannot tap-to-call — add a visible tel: link in the header.',
      pageUrl: p.page,
      measuredValue: p.raw,
      expectedValue: `visible tel:${p.e164 ?? p.normalized}`,
      evidence: ev(p.page, { phone: p.raw, e164: p.e164 ?? p.normalized, tel_link: 'not detected', source: 'json-ld' }, '390x844'),
    });
  }
  // Site-level rule: when a working tap-to-call path exists anywhere on
  // the site, stray plain-text number mentions are secondary copy — not a
  // money leak (owners tap the Call button and it dials). Leaky-M4 fires
  // only when zero working tel: exists. Header-specific gaps are still
  // caught by the hit-test branch above.
  const leaky = siteHasWorkingTel
    ? []
    : a.phones.filter((p) => !p.hasTelLink && !p.telMalformed && p.isValid && !p.codeOnly).slice(0, 3);
  for (const p of leaky) {
    out.push({
      module: 'phone',
      category: 'call',
      severity: sev,
      title: `Phone number is not clickable (${p.raw.slice(0, 30)})`,
      description:
        'A validated phone number appears in page text with no working tel: link (checked incl. parent wrappers, onclick/data-action and CDP listeners). On mobile this forces visitors to memorize or copy the number instead of tapping to call — direct call loss.',
      pageUrl: p.page,
      measuredValue: p.raw,
      expectedValue: `tel:${p.e164 ?? p.normalized}`,
      evidence: ev(p.page, { phone: p.raw, e164: p.e164 ?? p.normalized, tel_link: 'not detected' }, '390x844'),
    });
  }
  // M3: no callable phone ANYWHERE on the site. Fires only when the crawl
  // found zero phone numbers at all, no tel:/callto:/wtai: link exists in
  // discovered links, no dial-protocol observation came from any browser
  // viewport, and the mobile pass loaded clean (silence there is not
  // evidence). EMERGENCY for call-is-life niches, HIGH otherwise.
  if (a.phones.length === 0 && a.pages.length > 0) {
    const mobile = a.browser?.mobile;
    if (mobile && !mobile.loadError) {
      const hasTelLink = a.links.some((l) => l.kind === 'tel');
      let dialObserved = hasTelLink;
      if (!dialObserved) {
        for (const vp of [mobile, a.browser?.tablet, a.browser?.desktop]) {
          for (const o of vp?.ctaObservations ?? []) {
            if (/^(tel|callto|wtai):/i.test(o.href ?? '')) {
              dialObserved = true;
              break;
            }
          }
          if (dialObserved) break;
        }
      }
      if (!dialObserved) {
        const contactPages = a.pages.filter((p) => !p.isHomepage && CONTACT_PATH_RE.test(p.url)).length;
        // WhatsApp/chat-only sites (common in BD market): there IS a human
        // to reach, but no tap-to-call path. M3 ("no phone anywhere") would
        // be false — emit the sharper M4 instead: tap-to-call is missing.
        const waChat = a.links.some((l) => /wa\.me\/|whatsapp\.com\/send|m\.me\//i.test(l.href ?? ''));
        if (waChat) {
          out.push({
            module: 'phone',
            category: 'call',
            severity: mega === 'EMERGENCY' ? 'EMERGENCY' : 'HIGH',
            title: 'No tap-to-call number — chat apps only',
            description:
              'The site offers WhatsApp/chat contact but no tappable phone number exists anywhere (markup and all browser viewports checked). Mobile visitors who want to call — still the highest-intent action — cannot. Add a visible tel: link next to the chat option.',
            pageUrl: home,
            measuredValue: 'chat-only contact',
            expectedValue: 'tappable tel:+E.164 number in header',
            evidence: ev('Homepage', { pages_crawled: String(a.pages.length), contact_pages_crawled: String(contactPages), chat: 'whatsapp/messenger' }, '390x844'),
          });
          return;
        }
        out.push({
          module: 'phone',
          category: 'call-missing',
          severity: mega === 'EMERGENCY' ? 'EMERGENCY' : 'HIGH',
          title: 'No callable phone number found anywhere on the site',
          description:
            'No phone number was detected in crawled page text and no tap-to-call link exists anywhere (markup and all browser viewports checked). Mobile visitors have no way to call — verify visually in case the number is baked into an image, then add a tel: link.',
          pageUrl: home,
          measuredValue: 'no phone detected',
          expectedValue: 'tappable tel:+E.164 number in header',
          evidence: ev('Homepage', { pages_crawled: String(a.pages.length), contact_pages_crawled: String(contactPages) }, '390x844'),
        });
      }
    }
  }
}

function ctaFindings(a: ScanArtifacts, out: FindingInput[], home: string): void {
  for (const c of a.ctas.slice(0, 10)) {
    if (c.destinationOk === false) {
      const conv = c.kind === 'quote' || c.kind === 'booking' || c.kind === 'contact';
      out.push({
        module: 'cta',
        category: 'conversion-cta',
        severity: conv ? 'EMERGENCY' : 'HIGH',
        title: `CTA points to a broken destination ("${c.text.slice(0, 50)}")`,
        description: `The "${c.text}" button links to ${c.href} which returns HTTP ${c.destinationStatus ?? 'an error'}. The primary conversion path is dead.`,
        pageUrl: c.page,
        measuredValue: c.destinationStatus != null ? `HTTP ${c.destinationStatus}` : 'unreachable',
        evidence: ev(c.page, { cta_text: c.text, destination: (c.href ?? '').slice(0, 300) }),
      });
    } else if (!c.href) {
      out.push({
        module: 'cta',
        category: 'conversion-cta',
        severity: 'MEDIUM',
        title: `CTA without a link destination ("${c.text.slice(0, 50)}")`,
        description: 'A CTA-styled button has no link. It may rely on JavaScript — manual verification required to confirm it works.',
        pageUrl: c.page,
        evidence: ev(c.page, { cta_text: c.text }),
      });
    }
  }
  // Mobile visibility from the browser pass — verdict-aware, de-duplicated.
  // Only observations with genuinely no visible box become claims, and only
  // when no visible equivalent of the same action exists at this width.
  // (Below-fold CTAs are normal structure; the above-the-fold check owns
  // the first-viewport case. See selectHiddenCtaClaims.)
  const mobileObs = a.browser?.mobile.ctaObservations ?? [];
  if (a.browser?.mobile && !a.browser.mobile.loadError) {
    // Scan 140 guard: detector-blind (0 VISIBLE) → never EMERGENCY.
    const mobileVisibleCount = mobileObs.filter((o) => o.verdict === 'VISIBLE').length;
    // P3 needs the sticky flag + covering element: match each claim back.
    const stickyByKey = new Map(
      mobileObs.map((o) => [`${o.text}::${o.href ?? ''}`, o.stickyOrFloating] as const),
    );
    const coverByKey = new Map(
      mobileObs.map((o) => [`${o.text}::${o.href ?? ''}`, o.cover ?? null] as const),
    );
    const boxByKey = new Map(
      mobileObs.map((o) => [`${o.text}::${o.href ?? ''}`, o.box ?? null] as const),
    );
    const shots = evShotsOf(a);
    for (const h of selectHiddenCtaClaims(mobileObs)) {
      const sticky = stickyByKey.get(`${h.text}::${h.href ?? ''}`) === true;
      const cover = coverByKey.get(`${h.text}::${h.href ?? ''}`) ?? null;
      const coverDetails: Record<string, string> = {};
      if (cover) coverDetails['covering_element'] = `${cover.tag} (${cover.selector})`;
      // Red-marked close-up of the covered tap point (same-pass clip).
      const claimBox = boxByKey.get(`${h.text}::${h.href ?? ''}`) ?? null;
      const claimShot = claimBox ? shotFor(shots, 'cta', claimBox) : undefined;
      if (claimShot) coverDetails['screenshot'] = claimShot;
      // P3: sticky/floating call bar covered by an overlay/chat bubble.
      if (h.verdict === 'COVERED' && sticky && mobileVisibleCount > 0) {
        out.push({
          module: 'mobile-ui',
          category: 'sticky-blocked',
          severity: 'EMERGENCY',
          title: `Sticky mobile call bar is blocked ("${h.text.slice(0, 50)}")`,
          description: `The bottom sticky call bar ("${h.text.slice(0, 50)}") is covered by another element at 390px (cookie banner or chat bubble survived suppression). Taps land on the overlay, not the call button — mobile callers are lost.`,
          pageUrl: home,
          evidence: ev('Homepage', { cta_text: h.text, verdict: h.verdict, ...(h.href ? { href: h.href.slice(0, 300) } : {}), ...coverDetails }, '390x844'),
        });
        continue;
      }
      // Triage: physically untappable (COVERED) = EMERGENCY only when the
      // detector is NOT blind (≥1 VISIBLE elsewhere). Buried (IN_MENU) =
      // HIGH friction. Scan 140: blind + ZERO_SIZE/HIDDEN already purged in
      // selectHiddenCtaClaims, so any survivor here while blind downgrades.
      const emergency = h.verdict === 'COVERED' && mobileVisibleCount > 0;
      const isCallAction = /^(tel|callto|wtai):/i.test(h.href ?? '') || /\bcall\b|phone|\d{3}[-.\s]\d{3}/i.test(h.text);
      const coverDesc = cover
        ? ` The tap point is owned by ${cover.tag} (${cover.selector}).`
        : '';
      const desc =
        h.verdict === 'COVERED'
          ? `A call/quote/contact button ("${h.text.slice(0, 50)}") exists but another element covers its tap point at 390px (overlays already suppressed before testing), so mobile taps land elsewhere — direct conversion loss.${coverDesc}`
          : h.verdict === 'IN_MENU'
            ? `A call/quote/contact button ("${h.text.slice(0, 50)}") was only found inside the mobile menu at 390px — reachable, but buried behind a tap. Consider a visible call/quote action outside the menu.`
            : `A call/quote/contact button ("${h.text.slice(0, 50)}") exists in the page but has no tappable box at 390px width. Mobile visitors cannot tap what they cannot see.`;
      // Spec title: a COVERED primary call action names the crime exactly.
      const specTitle = h.verdict === 'COVERED' && isCallAction && emergency
        ? 'Primary Call Action Obscured by Overlay Element'
        : null;
      out.push({
        module: 'mobile-ui',
        category: 'cta-visibility',
        severity: emergency ? 'EMERGENCY' : 'HIGH',
        title: specTitle ?? (emergency
          ? `Mobile call/quote button untappable ("${h.text.slice(0, 50)}")`
          : `Important CTA not visible on mobile ("${h.text.slice(0, 50)}")`),
        description: desc,
        pageUrl: home,
        evidence: ev('Homepage', { cta_text: h.text, verdict: h.verdict, ...(h.href ? { href: h.href.slice(0, 300) } : {}), ...coverDetails }, '390x844'),
      });
    }
  }
}

function formFindings(a: ScanArtifacts, out: FindingInput[]): void {
  // P5/P7 ONLY. GET-method, no-contact-field and CAPTCHA are NOT in the
  // 16-problem catalog — suppressed.
  if (a.forms.length === 0) return;
  // One finding per physical form: the same form embedded on /contact,
  // /contact?variant=.., or (pre-fragment-strip) /contact#.. is ONE
  // opportunity — evidence keeps the first page.
  const seenForms = new Set<string>();
  const formSig = (f: FormInfo): string =>
    `${f.action ?? '(none)'}::${f.fieldCount}::${f.fields.map((x) => `${x.name}:${x.type}`).join(',')}`;
  for (const f of a.forms.slice(0, 5)) {
    const sig = formSig(f);
    if (seenForms.has(sig)) continue;
    seenForms.add(sig);
    // P5: unsubmittable form.
    if (!f.hasSubmit) {
      out.push({
        module: 'forms', category: 'structure', severity: 'EMERGENCY',
        title: 'Contact form has no submit button',
        description: `A form on ${f.page} exposes ${f.fieldCount} fields but no submit control was detected. Visitors cannot send the request — the quote path is unsubmittable.`,
        pageUrl: f.page,
        evidence: ev(f.page, { action: f.action ?? '(none)', fields: String(f.fieldCount) }),
      });
    }
    // P5: broken action. Honesty rules: a form WITH a submit control and no
    // action usually submits (same-URL/AJAX) — MEDIUM verify-note, never
    // "vanish" EMERGENCY. js: schemes are JS-handled until proven otherwise.
    // NOTE: no-submit forms already claimed EMERGENCY above — the endpoint
    // sub-branches below only run when a submit control exists (no double).
    const action: string = f.action ?? '';
    const jsHandled = f.jsSubmit || /^(javascript:)/i.test(action);
    if (action === '' && f.hasSubmit) {
      out.push({
        module: 'forms', category: 'structure', severity: 'MEDIUM',
        title: 'Contact form endpoint not visible',
        description: `A form on ${f.page} has a submit control but no action attribute (same-URL or AJAX submit likely). Verify the endpoint before outreach.`,
        pageUrl: f.page,
        measuredValue: '(no action)',
        expectedValue: 'valid https endpoint',
        evidence: ev(f.page, { action: '(missing)' }),
      });
    } else if (/^(javascript:|mailto:)/i.test(action)) {
      out.push({
        module: 'forms', category: 'structure', severity: jsHandled || /^mailto:/i.test(action) ? 'MEDIUM' : 'EMERGENCY',
        title: jsHandled ? `Form submits via script ("${action.slice(0, 40)}")` : `Form cannot submit ("${action.slice(0, 40)}")`,
        description: 'The form action is not a server endpoint. Likely JS-handled — verify before claiming it is broken.',
        pageUrl: f.page,
        measuredValue: action,
        expectedValue: 'valid https endpoint',
        evidence: ev(f.page, { action }),
      });
    }
    // P7: excessive friction — 7+ VISIBLE interactive fields on a service page.
    // Hidden/system inputs (honeypots, CSRF, captcha) never count.
    const frictionCount = f.fieldCount;
    if (frictionCount >= 7) {
      out.push({
        module: 'forms', category: 'friction', severity: 'HIGH',
        title: `High Form Abandonment Risk (${frictionCount} visible fields)`,
        description: 'Seven or more visible interactive fields on a quote/contact form intimidates mobile visitors and causes high abandonment. Trim to essential fields.',
        pageUrl: f.page,
        measuredValue: `${frictionCount} visible fields`,
        expectedValue: '≤6 visible fields',
        evidence: ev(f.page, { visible_fields: String(frictionCount) }),
      });
    }
    // P7b: unlabeled fields — 3+ visible fields with no <label>, wrapping
    // label, aria-label, or placeholder. Visitors cannot tell what to type.
    if (f.unlabeledFields >= 3) {
      out.push({
        module: 'forms', category: 'unlabeled', severity: 'HIGH',
        title: `Quote form fields confuse visitors (${f.unlabeledFields} unlabeled)`,
        description: `${f.unlabeledFields} visible fields on the form at ${f.page} have no label, placeholder, or accessible name. Mobile visitors cannot tell what to type and abandon the form.`,
        pageUrl: f.page,
        measuredValue: `${f.unlabeledFields} unlabeled fields`,
        expectedValue: 'every field labeled',
        evidence: ev(f.page, { unlabeled_fields: String(f.unlabeledFields), visible_fields: String(f.fieldCount) }),
      });
    }
  }
  // NOTE: contactPathFindings is called from buildFindings (not here),
  // because the dead-contact case means zero forms — and this function
  // early-returns on empty forms above.
}

export const CONTACT_PATH_RE = /contact|quote|book|estimate|appointment|get-started|get started|signup|sign-up|schedule|scheduling|consult|consultation|demo|message|calendar|trial|callback/i;

function contactPathFindings(a: ScanArtifacts, out: FindingInput[]): void {
  let fired = 0;
  for (const p of a.pages) {
    if (fired >= 2) break;
    if (p.isHomepage) continue;
    if (!CONTACT_PATH_RE.test(p.url)) continue;
    if (p.statusCode == null || p.statusCode >= 400) continue;
    const hasForm = a.forms.some((f) => f.page === p.url);
    if (hasForm) continue;
    const hasPhone = a.phones.some((ph) => ph.page === p.url);
    if (hasPhone) continue;
    const hasMailto = a.links.some((l) => l.kind === 'mailto' && l.sourcePage === p.url);
    if (hasMailto) continue;
    fired++;
    out.push({
      module: 'mobile-ui',
      category: 'dead-contact',
      severity: 'HIGH',
      title: 'Contact page has no way to contact you',
      description: `The page at ${p.url} looks like the contact/quote path but exposes no form, no phone number, and no email link in the crawled markup. High-intent visitors arrive and leave with nothing to do.`,
      pageUrl: p.url,
      measuredValue: 'no form, phone, or email link',
      expectedValue: 'working form or tappable phone',
      evidence: ev(p.url, { page: p.url, site_forms_total: String(a.forms.length), site_phones_total: String(a.phones.length) }),
    });
  }
}

function mobileUiFindings(a: ScanArtifacts, out: FindingInput[], home: string): void {
  const m = a.browser?.mobile;
  if (!m) return;
  // P2: hero CTA missing above the fold — EMERGENCY (3-second bounce).
  // Scan 140 guard: when the detector saw ZERO visible CTAs it is blind
  // (screenshot may still show a header phone) — never EMERGENCY then.
  if (!m.loadError && m.aboveFold) {
    if (!m.aboveFold.ctaVisible && m.aboveFold.ctaCount > 0) {
      const visibleCount = (m.ctaObservations ?? []).filter((o) => o.verdict === 'VISIBLE').length;
      if (visibleCount === 0) {
        out.push({
          module: 'mobile-ui', category: 'above-fold', severity: 'MEDIUM',
          title: 'Mobile CTA visibility unclear — manual check needed',
          description: `The detector observed ${m.aboveFold.ctaCount} call/quote/contact action(s) but none with a visible box at 390px (all hidden/zero-size copies). The header may still show a call action — verify on a real phone before outreach.`,
          pageUrl: home,
          measuredValue: 'detector blind (0 visible observations)',
          expectedValue: 'primary CTA visible without scrolling',
          evidence: ev('Homepage', { cta_count: String(m.aboveFold.ctaCount), visible_count: '0' }, '390x844'),
        });
      } else {
        out.push({
          module: 'mobile-ui', category: 'above-fold', severity: 'EMERGENCY',
          title: 'No primary CTA above the fold on mobile',
          description: `The page contains ${m.aboveFold.ctaCount} call/quote/contact action(s), but none is visible in the initial 390px viewport. Visitors bounce within seconds because no quote/call action is immediately visible.`,
          pageUrl: home,
          measuredValue: 'no CTA in first viewport',
          expectedValue: 'primary CTA visible without scrolling',
          evidence: ev('Homepage', { cta_count: String(m.aboveFold.ctaCount) }, '390x844'),
        });
      }
    }
    // "No phone above fold" is NOT in the catalog — suppressed.
  }
  // Dropped: generic JS errors are too nerdy for outreach — a broken
  // script only matters when a money leak above already proves the damage.
  // M11: horizontal overflow — HIGH (unprofessional + cuts buttons).
  // scrollWidth > innerWidth + 5px tolerance; exact offender element named.
  if (!m.loadError && m.horizontalOverflow) {
    const offender = m.overflowOffender ?? null;
    const details: Record<string, string> = {
      overflow_px: String(offender?.overflowPx ?? m.overflowWidth),
    };
    if (offender) {
      details['offender_selector'] = offender.selector;
      details['offender_tag'] = offender.tag;
      details['box_json'] = JSON.stringify(offender.rect);
      const shot = shotFor(evShotsOf(a), 'overflow', offender.rect);
      if (shot) details['screenshot'] = shot;
    }
    out.push({
      module: 'mobile-ui', category: 'layout', severity: 'HIGH',
      title: 'Mobile Viewport Clipping: Horizontal Layout Overflow',
      description: offender
        ? `Content is wider than the 390px viewport (+${offender.overflowPx}px) — the ${offender.tag} element (${offender.selector}) sticks out past the right edge. The page wobbles left-to-right, cutting off buttons.`
        : 'Content is wider than the 390px viewport — the page wobbles left-to-right, cutting off buttons and looking unprofessional.',
      pageUrl: home,
      measuredValue: offender ? `+${offender.overflowPx}px (${offender.selector})` : `+${m.overflowWidth}px`,
      expectedValue: 'no overflow',
      evidence: ev('Homepage', details, '390x844'),
    });
  }
  // M12: overlapping tap targets (mis-taps) — VISIBLE collisions at 390px
  // with axe corroboration counted; axe-clean pairs stay MEDIUM verify-notes.
  // Navigation presence and generic JS-error lists are NOT in the catalog.
  if (!m.loadError) {
    out.push(...analyzeTapTargets(a.browser, home));
  }
}

/** Run every money-leak rule over collected artifacts (money-leaks.ts).
 *  nicheId threads the EMERGENCY/BOOKING thresholds into M10 (perf)
 *  and M3/M4 (phone) severity.
 *  DOM-ONLY law: broken-route claims rest on DOM/crawl-extracted links that
 *  returned 404/500 — never on blind-guessed /emergency or /booking URLs. */
export function buildFindings(a: ScanArtifacts, homeUrl?: string, nicheId?: string): FindingInput[] {
  const out: FindingInput[] = [];
  const home = homeUrl || 'Homepage';
  availabilityFindings(a, out);
  // If the site is unreachable/blocked, deeper modules have no valid data.
  if (!a.availability?.ok) return out;
  linkFindings(a, out); // M7
  phoneFindings(a, out, home, megaGroupFor(nicheId)); // M3/M4
  ctaFindings(a, out, home); // M5/M7
  formFindings(a, out); // M8/M9
  contactPathFindings(a, out); // M8 dead-contact companion (zero-form case)
  mobileUiFindings(a, out, home); // M5/M6/M11
  out.push(...evaluatePerformance(a, homeUrl, nicheId)); // M10 (mobile only, niche-aware)
  // M7: booking embeds (passive: markup + network/console corroboration).
  out.push(...analyzeBookingEmbeds(extractEmbeds(a.pages), a.browser, home));
  // Dropped: mixed content — invisible to owners, never closes a deal.
  // M2 transport fallback (passive headers only; framing is MEDIUM = suppressed).
  out.push(...evaluateSecurity(a.security, a.availability));
  // Fail-closed catalog guard: only money leaks persist, no matter what a
  // rule emitted. Then severity rank, then module, then title.
  // MEDIUM and below are non-money leaks — counted, never persisted.
  const majorFindings = out.filter(
    (f) =>
      (f.severity === 'EMERGENCY' || f.severity === 'HIGH') &&
      leakFor(f.module, f.category) !== null,
  );
  const rank: Record<Severity, number> = { EMERGENCY: 0, HIGH: 1, MEDIUM: 2 };
  majorFindings.sort((x, y) => rank[x.severity] - rank[y.severity] || x.module.localeCompare(y.module));
  return majorFindings;
}

export function scoreFindings(findings: FindingInput[]): OpportunityBreakdown {
  let score = 0;
  const parts: { reason: string; points: number }[] = [];
  for (const f of findings) {
    // Money-leaks-only: MEDIUM never scores (legacy entry kept for compat).
    if (f.severity !== 'EMERGENCY' && f.severity !== 'HIGH') continue;
    const w = WEIGHTS[f.severity] ?? 0;
    if (w <= 0) continue;
    score += w;
    const last = parts[parts.length - 1];
    if (last && last.reason === f.title) last.points += w;
    else parts.push({ reason: f.title, points: w });
  }
  parts.sort((x, y) => y.points - x.points);
  return { score: Math.min(100, score), parts: parts.slice(0, 10) };
}
