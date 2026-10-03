import type { CtaBox, CtaObservation } from './types';

/**
 * Pure CTA visibility verdicts — no browser, no network.
 * Unit-tested (backend/test). The pipeline feeds it multi-signal
 * observations; NOTHING here guesses from a single detector.
 */

export interface CtaSignals {
  domFound: boolean;
  displayed: boolean;
  visibilityVisible: boolean;
  opacityVisible: boolean;
  hasSize: boolean;
  box: CtaBox | null;
  inViewport: boolean;
  notClipped: boolean;
  hitTestPass: boolean | null;
  clickable: boolean;
  inMenu: boolean;
}

export interface CtaVerdict {
  verdict: CtaObservation['verdict'];
  confidence: CtaObservation['confidence'];
  reasons: string[];
}

export function decideCta(s: CtaSignals): CtaVerdict {
  const R = (r: string) => r;
  if (!s.domFound) {
    return { verdict: 'INCONCLUSIVE', confidence: 'LOW', reasons: [R('no DOM match for CTA signals')] };
  }
  if (s.inMenu && !s.inViewport) {
    return { verdict: 'IN_MENU', confidence: 'HIGH', reasons: [R('inside closed mobile menu')] };
  }
  if (!s.displayed) {
    return { verdict: 'HIDDEN', confidence: 'HIGH', reasons: [R('computed display:none')] };
  }
  if (!s.visibilityVisible || !s.opacityVisible) {
    return { verdict: 'HIDDEN', confidence: 'HIGH', reasons: [R('visibility hidden or fully transparent')] };
  }
  if (!s.hasSize || !s.box || s.box.width <= 2 || s.box.height <= 2) {
    return {
      verdict: 'ZERO_SIZE', confidence: 'HIGH',
      reasons: [R(`box ${s.box ? `${Math.round(s.box.width)}x${Math.round(s.box.height)}` : 'none'}`)],
    };
  }
  if (!s.inViewport) {
    return { verdict: 'OUT_OF_VIEWPORT', confidence: 'HIGH', reasons: [R('valid box outside viewport')] };
  }
  if (s.hitTestPass === false) {
    return { verdict: 'COVERED', confidence: 'HIGH', reasons: [R('another element is on top at center point')] };
  }
  if (!s.clickable) {
    return { verdict: 'HIDDEN', confidence: 'MEDIUM', reasons: [R('disabled or pointer-events:none')] };
  }
  if (!s.notClipped) {
    return { verdict: 'VISIBLE', confidence: 'MEDIUM', reasons: [R('partially clipped but hittable')] };
  }
  if (s.hitTestPass === null) {
    return { verdict: 'VISIBLE', confidence: 'MEDIUM', reasons: [R('no hit-test performed')] };
  }
  return { verdict: 'VISIBLE', confidence: 'HIGH', reasons: [R('displayed, sized, in viewport, hit-test pass')] };
}

export interface HiddenCtaClaim {
  text: string;
  href: string | null;
  verdict: CtaObservation['verdict'];
}

export interface CrossValidation {
  suppressed: string[];
  contradictions: { area: string; domSays: string; visualSays: string }[];
  confirmedVisible: string[];
}

const normText = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Action normalization for responsive-variant consolidation.
 * "Call Now" (header) vs "(555) 123-4567" (sticky bar) are the SAME call
 * action — hiding one while the other is tappable is responsive design,
 * not a leak. Same for quote/booking/contact families.
 */
export function actionOf(text: string, href: string | null): string {
  const t = `${text} ${href ?? ''}`.toLowerCase();
  if (/^tel:/.test((href ?? '').toLowerCase()) || /\bcall\b|phone|tel\b|\(\d{3}\)|\d{3}[-.\s]\d{3}/.test(t)) return 'call';
  if (/quote|estimate|free.*price|get.*price/.test(t)) return 'quote';
  if (/book|schedule|appointment|reserve/.test(t)) return 'booking';
  if (/contact|message|email us|get in touch/.test(t)) return 'contact';
  return 'general';
}

/**
 * Which non-visible observations deserve a finding — and which do NOT.
 * Dropped (never a claim):
 *  - OUT_OF_VIEWPORT: a CTA below the fold is normal page structure, not a
 *    leak (the above-the-fold check covers the first-viewport case).
 *  - INCONCLUSIVE: detectors disagree, so no high-confidence claim.
 *  - Responsive variants: the same action (same href or same text) IS
 *    visible elsewhere at this width — e.g. a desktop-only phone link
 *    hidden at 390px while the mobile call button shows. Claiming the
 *    hidden variant "not visible" contradicts the screenshot and the
 *    visitor's reality.
 * Remaining claims are de-duplicated by action text and capped.
 */
export function selectHiddenCtaClaims(
  observations: { text: string; href: string | null; verdict: CtaObservation['verdict'] }[],
  limit = 3,
): HiddenCtaClaim[] {
  const visibleHref = new Set<string>();
  const visibleText = new Set<string>();
  const visibleActions = new Set<string>();
  let visibleCount = 0;
  for (const o of observations) {
    if (o.verdict !== 'VISIBLE') continue;
    visibleCount++;
    if (o.href) visibleHref.add(o.href.toLowerCase());
    const nt = normText(o.text);
    if (nt) visibleText.add(nt);
    const a = actionOf(o.text, o.href);
    if (a !== 'general') visibleActions.add(a);
  }
  const out: HiddenCtaClaim[] = [];
  const seen = new Set<string>();
  for (const o of observations) {
    if (o.verdict === 'VISIBLE' || o.verdict === 'OUT_OF_VIEWPORT' || o.verdict === 'INCONCLUSIVE') continue;
    // Scan 140 purge (Phase 2 fix): ZERO_SIZE (0x0 box) and HIDDEN
    // (display:none at this width) are desktop responsive copies — never
    // visitor tap targets, never a mobile leak. Drop completely instead of
    // claiming "untappable". Only COVERED (real overlay) and IN_MENU
    // (buried) can become claims.
    if (o.verdict === 'ZERO_SIZE' || o.verdict === 'HIDDEN') continue;
    const nt = normText(o.text);
    if (!nt || seen.has(nt)) continue;
    if (o.href && visibleHref.has(o.href.toLowerCase())) continue;
    if (visibleText.has(nt)) continue;
    // Responsive variant consolidation: a hidden "Call Now" while ANY call
    // action is visibly tappable (sticky bar/drawer) is NOT a leak.
    // Call + contact share one family (tel: sticky satisfies /contact).
    const a = actionOf(o.text, o.href);
    if (a !== 'general' && visibleActions.has(a)) continue;
    if ((a === 'call' || a === 'contact') && (visibleActions.has('call') || visibleActions.has('contact'))) continue;
    seen.add(nt);
    out.push({ text: o.text, href: o.href, verdict: o.verdict });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Cross-validate crawler CTA hrefs against browser observations.
 * A "missing CTA" claim requires BOTH to agree, else INCONCLUSIVE.
 */
export function crossValidateCtas(
  crawlerHrefs: string[],
  observations: { text: string; href: string | null; verdict: CtaObservation['verdict'] }[],
): CrossValidation {
  const out: CrossValidation = { suppressed: [], contradictions: [], confirmedVisible: [] };
  const visibleHrefs = new Set(
    observations.filter((o) => o.verdict === 'VISIBLE').map((o) => (o.href ?? '').toLowerCase()),
  );
  const visibleActions = new Set(
    observations.filter((o) => o.verdict === 'VISIBLE').map((o) => actionOf(o.text, o.href)),
  );
  for (const href of crawlerHrefs) {
    const h = href.toLowerCase();
    if (visibleHrefs.has(h)) {
      out.confirmedVisible.push(href);
      continue;
    }
    const related = observations.filter((o) => (o.href ?? '').toLowerCase() === h);
    if (related.length === 0) {
      // Responsive variant: crawler href missing but an EQUIVALENT contact
      // action is visibly tappable (desktop /contact vs mobile sticky tel:).
      // Call + contact share one family — either satisfies "reachable".
      // Quote/booking stay strict (different URLs = different funnels).
      const hrefAction = actionOf('', href);
      const contactVisible = visibleActions.has('call') || visibleActions.has('contact');
      if ((hrefAction === 'call' || hrefAction === 'contact') && contactVisible) {
        out.confirmedVisible.push(href);
        continue;
      }
      // Browser saw nothing at all for this href — detectors disagree.
      out.contradictions.push({
        area: `cta:${href.slice(0, 80)}`,
        domSays: 'crawler found link',
        visualSays: 'browser observed nothing',
      });
      out.suppressed.push(`no high-confidence claim for ${href.slice(0, 80)}`);
    }
  }
  return out;
}
