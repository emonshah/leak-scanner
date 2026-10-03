import { nicheById, pathKeyForCategory } from './niches';
import { leakFor, storyFor } from './money-leaks';
import { matchDigits } from './phone-validate';
import type {
  FindingInput,
  OpportunityBreakdown,
  ScanArtifacts,
  Severity,
} from './types';

/**
 * BUSINESS IMPACT ENGINE (deterministic, documented, no AI).
 *
 * Detection ≠ report. Every finding is enriched with:
 *   business_category · conversion_impact · confidence ·
 *   visibility · mobile · priority_score · group_key
 *
 * priority_score =
 *   severityW × conversionW × confidenceW × visibilityW × mobileBoost × nicheBoost
 *
 *   severityW:    EMERGENCY 30, HIGH 15, MEDIUM 6 (LOW/INFO suppressed)
 *   conversionW:  CRITICAL_CONVERSION 1.5, HIGH 1.2, MEDIUM 1.0, LOW 0.7, TECHNICAL_ONLY 0.4
 *   confidenceW:  HIGH 1.0, MEDIUM 0.8, LOW 0.5
 *   visibilityW:  homepage 1.0, key page (contact/quote/book) 0.9, other 0.7
 *   mobileBoost:  1.2 when a mobile finding affects conversion, else 1.0
 *   nicheBoost:   niche profile multiplier for the finding's path (default 1.0)
 *
 * Opportunity score v2 = min(100, Σ min(priority_score, 30)).
 * Same input always yields the same output.
 */

export type BusinessCategory =
  | 'Conversion Blocker'
  | 'Mobile Conversion'
  | 'Call Conversion'
  | 'Quote Conversion'
  | 'Booking Conversion'
  | 'Form Friction'
  | 'Navigation/UX'
  | 'Performance'
  | 'Technical'
  | 'Security'
  | 'Accessibility';

export type ConversionImpact =
  | 'CRITICAL_CONVERSION'
  | 'HIGH_CONVERSION'
  | 'MEDIUM_CONVERSION'
  | 'LOW_CONVERSION'
  | 'TECHNICAL_ONLY';

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface EnrichedFinding extends FindingInput {
  businessCategory: BusinessCategory;
  conversionImpact: ConversionImpact;
  confidence: Confidence;
  visibility: number;
  mobile: boolean;
  priorityScore: number;
  groupKey: string | null;
  isGroupPrimary: boolean;
  groupTitle: string | null;
  whyPrioritized: string[];
}

const SEV_W: Record<Severity, number> = { EMERGENCY: 30, HIGH: 15, MEDIUM: 6 };
const CONV_W: Record<ConversionImpact, number> = {
  CRITICAL_CONVERSION: 1.5,
  HIGH_CONVERSION: 1.2,
  MEDIUM_CONVERSION: 1.0,
  LOW_CONVERSION: 0.7,
  TECHNICAL_ONLY: 0.4,
};
const CONF_W: Record<Confidence, number> = { HIGH: 1.0, MEDIUM: 0.8, LOW: 0.5 };

export function businessCategoryFor(f: FindingInput): BusinessCategory {
  if (f.category === 'reachability' || f.category === 'conversion-cta' || f.category === 'conversion-link') {
    return f.severity === 'EMERGENCY' ? 'Conversion Blocker' : 'Quote Conversion';
  }
  // 16-problem catalog routing: every emitted category lands somewhere real.
  if (f.category === 'booking-embed' || f.category === 'conversion-path') return 'Booking Conversion';
  if (f.category === 'input-keyboard' || f.category === 'friction') return 'Form Friction';
  if (f.category === 'sticky-blocked' || f.category === 'tap-targets') return 'Mobile Conversion';
  // Lost quote replies are lost quotes — deliverability scores as conversion.
  if (f.category === 'email-auth') return 'Quote Conversion';
  switch (f.module) {
    case 'phone':
      return 'Call Conversion';
    case 'cta':
      return 'Quote Conversion';
    case 'booking':
      return 'Booking Conversion';
    case 'forms':
      return 'Form Friction';
    case 'mobile-ui':
      return 'Mobile Conversion';
    case 'performance':
    case 'resources':
      return 'Performance';
    case 'security':
      return 'Security';
    case 'accessibility':
      return 'Accessibility';
    case 'links':
      return 'Navigation/UX';
    default:
      return 'Technical';
  }
}

export function conversionImpactFor(f: FindingInput, business: BusinessCategory): ConversionImpact {
  const conversionCats: BusinessCategory[] = [
    'Conversion Blocker',
    'Call Conversion',
    'Quote Conversion',
    'Booking Conversion',
    'Form Friction',
    'Mobile Conversion',
  ];
  if (!conversionCats.includes(business)) return 'TECHNICAL_ONLY';
  // Severe mobile performance directly throttles mobile conversion.
  if (business === 'Performance' || business === 'Mobile Conversion') {
    if (f.severity === 'EMERGENCY') return 'CRITICAL_CONVERSION';
    if (f.severity === 'HIGH') return 'HIGH_CONVERSION';
    if (f.severity === 'MEDIUM') return 'MEDIUM_CONVERSION';
    return 'LOW_CONVERSION';
  }
  switch (f.severity) {
    case 'EMERGENCY':
      return 'CRITICAL_CONVERSION';
    case 'HIGH':
      return 'HIGH_CONVERSION';
    case 'MEDIUM':
      return 'MEDIUM_CONVERSION';
    default:
      return 'TECHNICAL_ONLY';
  }
}

export function confidenceFor(f: FindingInput): Confidence {
  // Soft claims (weak-contradiction demotions) rank below proven findings
  // but stay pitched — MEDIUM confidence = 0.8 weight instead of 1.0.
  if ((evDetails(f) as Record<string, string>)['soft_claim'] === 'true') return 'MEDIUM';
  // Measured facts → HIGH. Automated visual inference → MEDIUM. Heuristics → LOW.
  if (f.module === 'links' && f.measuredValue?.startsWith('HTTP')) return 'HIGH';
  if (f.module === 'availability') return 'HIGH';
  if (f.module === 'performance' && f.category !== 'measurability') return 'HIGH';
  if (f.module === 'security' && f.category !== 'measurability') return 'HIGH';
  if (f.module === 'phone') return 'HIGH';
  if (f.module === 'cta' && f.measuredValue?.startsWith('HTTP')) return 'HIGH';
  if (f.category === 'measurability' || f.category === 'presence') return 'LOW';
  if (f.module === 'mobile-ui' && (f.category === 'layout' || f.category === 'failed-requests')) return 'HIGH';
  return 'MEDIUM';
}

export function visibilityFor(f: FindingInput, homeUrl: string | null): number {
  const page = (f.pageUrl ?? '').toLowerCase();
  const home = (homeUrl ?? '').toLowerCase();
  if (!page || (home && page === home)) return 1.0;
  try {
    const u = new URL(f.pageUrl ?? '');
    if (u.pathname === '/' || u.pathname === '') return 1.0;
    if (/contact|quote|book|estimate|appointment|schedule|pricing/i.test(u.pathname)) return 0.9;
  } catch {
    /* fall through */
  }
  return 0.7;
}

/** Evidence details as a flat string map (evidence blobs vary by module). */
function evDetails(f: FindingInput): Record<string, string> {
  const ev = f.evidence as { details?: unknown; viewport?: unknown } | undefined;
  return (ev?.details ?? {}) as Record<string, string>;
}

function evViewport(f: FindingInput): string {
  const ev = f.evidence as { viewport?: unknown } | undefined;
  return typeof ev?.viewport === 'string' ? ev.viewport : '';
}

export function isMobileFinding(f: FindingInput): boolean {
  if (f.module === 'mobile-ui') return true;
  return evViewport(f).startsWith('390');
}

export interface EnrichContext {
  homeUrl: string | null;
  nicheId: string;
}

export function enrichFindings(
  findings: FindingInput[],
  ctx: EnrichContext,
): EnrichedFinding[] {
  const niche = nicheById(ctx.nicheId);
  return findings.map((f) => {
    const businessCategory = businessCategoryFor(f);
    const conversionImpact = conversionImpactFor(f, businessCategory);
    const confidence = confidenceFor(f);
    const visibility = visibilityFor(f, ctx.homeUrl);
    const mobile = isMobileFinding(f);
    const ctaKind = /call/i.test(f.title) && f.module === 'cta' ? 'call'
      : /book|schedule|appointment/i.test(f.title) && f.module === 'cta' ? 'booking'
      : /quote|estimate/i.test(f.title) && f.module === 'cta' ? 'quote'
      : undefined;
    // Module-aware pathKey: phone/mobile-call findings count as call even
    // when the title regex misses (e.g. digit-only sticky bar text).
    let pathKey = pathKeyForCategory(businessCategory, ctaKind);
    if (!pathKey) {
      if (f.module === 'phone' || (f.module === 'mobile-ui' && /call|phone|tel/i.test(`${f.title} ${f.category}`))) {
        pathKey = 'call';
      }
    }
    const nicheBoost = pathKey ? niche.boosts[pathKey] : 1;
    const mobileBoost = mobile && conversionImpact !== 'TECHNICAL_ONLY' && conversionImpact !== 'LOW_CONVERSION' ? 1.2 : 1;
    const sevW = (SEV_W as Record<string, number>)[f.severity] ?? 0;
    const priorityScore = Math.round(
      sevW * CONV_W[conversionImpact] * CONF_W[confidence] * visibility * mobileBoost * nicheBoost,
    );
    const why: string[] = [];
    if (conversionImpact === 'CRITICAL_CONVERSION' || conversionImpact === 'HIGH_CONVERSION') {
      why.push(`${conversionImpact === 'CRITICAL_CONVERSION' ? 'Blocks' : 'Hurts'} conversions`);
    }
    if (visibility >= 1) why.push('Homepage');
    else if (visibility >= 0.9) why.push('Key conversion page');
    if (mobile) why.push('Mobile');
    why.push(`${confidence} confidence`);
    if (nicheBoost > 1) why.push(`${niche.label} priority`);
    return {
      ...f,
      businessCategory,
      conversionImpact,
      confidence,
      visibility,
      mobile,
      priorityScore,
      nicheGroup: niche.mega,
      groupKey: null,
      isGroupPrimary: true,
      groupTitle: null,
      whyPrioritized: why,
    };
  });
}

function slugUrl(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  } catch {
    return 'unknown';
  }
}

/**
 * Group closely related observations so the report shows one business
 * problem with several evidence rows instead of five near-duplicates.
 */
export function groupFindings(enriched: EnrichedFinding[]): EnrichedFinding[] {
  // Rule 1: homepage mobile CTA visibility findings collapse into one group
  // (plus layout overflow when present) so the report shows one business
  // problem with several evidence rows instead of near-duplicate cards.
  const ctaVis = enriched.filter(
    (f) => f.businessCategory === 'Mobile Conversion' && f.category === 'cta-visibility',
  );
  const overflow = enriched.filter(
    (f) => f.businessCategory === 'Mobile Conversion' && f.category === 'layout',
  );
  if (ctaVis.length > 1 || (ctaVis.length > 0 && overflow.length > 0)) {
    const members = [...ctaVis, ...overflow].sort((a, b) => b.priorityScore - a.priorityScore);
    const key = 'mobile-cta-visibility';
    members.forEach((m, i) => {
      m.groupKey = key;
      m.isGroupPrimary = i === 0;
      m.groupTitle = 'Mobile CTA visibility failure';
    });
  }
  // Rule 2: broken conversion destination + broken conversion link, same URL.
  const byDest = new Map<string, EnrichedFinding[]>();
  for (const f of enriched) {
    if (f.groupKey) continue;
    const dest = evDetails(f)['destination'];
    const conv = f.businessCategory === 'Quote Conversion' || f.businessCategory === 'Conversion Blocker';
    if (conv && dest) {
      const k = `broken-path-${slugUrl(dest)}`;
      const arr = byDest.get(k) ?? [];
      arr.push(f);
      byDest.set(k, arr);
    }
  }
  for (const [key, arr] of byDest) {
    if (arr.length < 2) continue;
    const sorted = [...arr].sort((a, b) => b.priorityScore - a.priorityScore);
    sorted.forEach((m, i) => {
      m.groupKey = key;
      m.isGroupPrimary = i === 0;
      m.groupTitle = 'Broken conversion path';
    });
  }
  return enriched;
}

/** Opportunity score v2 (money-leaks-only): min(100, Σ capped story parts).
 *  MEDIUM/LOW/INFO never score — only EMERGENCY/HIGH move the number, so the
 *  score always matches the persisted findings. Three guards, in order:
 *  title-dedupe (one physical problem scores once no matter how many URL
 *  variants carried it), per-item cap 45, per-STORY cap 45 (one funnel =
 *  one budget: mobile+desktop slowness or M9+M13 on the same form must not
 *  score a dead funnel twice). Cap 45 + conversionImpact tie-break so a
 *  niche-boosted HIGH overtakes a generic EMERGENCY. */
export interface ScorableFinding {
  module: string;
  category: string;
  severity: string;
  priorityScore: number;
  title: string;
  groupTitle?: string | null;
  isGroupPrimary?: boolean;
}

export function scoreCapped(rows: ScorableFinding[]): OpportunityBreakdown {
  let score = 0;
  const parts: { reason: string; points: number }[] = [];
  const seenTitles = new Set<string>();
  const storyUsed = new Map<string, number>();
  for (const f of rows) {
    if (f.severity !== 'EMERGENCY' && f.severity !== 'HIGH') continue;
    if (leakFor(f.module, f.category) === null) continue; // money leaks only
    if (seenTitles.has(f.title)) continue;
    seenTitles.add(f.title);
    const story = storyFor(f.module, f.category);
    const room = story ? Math.max(0, 45 - (storyUsed.get(story.id) ?? 0)) : 45;
    const pts = Math.min(Math.min(f.priorityScore, 45), room);
    if (pts <= 0) continue;
    if (story) storyUsed.set(story.id, (storyUsed.get(story.id) ?? 0) + pts);
    score += pts;
    parts.push({ reason: f.groupTitle && f.isGroupPrimary ? `${f.groupTitle} — ${f.title}` : f.title, points: pts });
  }
  parts.sort((a, b) => b.points - a.points);
  return { score: Math.min(100, Math.round(score)), parts: parts.slice(0, 6) };
}

export function scoreEnriched(enriched: EnrichedFinding[]): OpportunityBreakdown {
  const CONV_RANK: Record<string, number> = {
    CRITICAL_CONVERSION: 0,
    HIGH_CONVERSION: 1,
    MEDIUM_CONVERSION: 2,
    LOW_CONVERSION: 3,
    TECHNICAL_ONLY: 4,
  };
  let score = 0;
  const parts: { reason: string; points: number }[] = [];
  // Same dedupe as the brief (byTitle): one physical problem scores once,
  // no matter how many URL variants carried it into the findings table.
  const ordered = [...enriched].sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    return (CONV_RANK[a.conversionImpact] ?? 9) - (CONV_RANK[b.conversionImpact] ?? 9);
  });
  return scoreCapped(ordered.map((f) => ({
    module: f.module,
    category: f.category,
    severity: f.severity,
    priorityScore: f.priorityScore,
    title: f.title,
    groupTitle: f.groupTitle,
    isGroupPrimary: f.isGroupPrimary,
  })));
}

export function analyzePaths(a: ScanArtifacts): FindingInput[] {
  const out: FindingInput[] = [];
  const home = a.pages.find((p) => p.isHomepage) ?? a.pages[0];
  if (!home) return out;
  const pageByUrl = new Map<string, (typeof a.pages)[number]>();
  for (const p of a.pages) {
    if (p.finalUrl) pageByUrl.set(p.finalUrl, p);
    pageByUrl.set(p.url, p);
  }
  // Quote path: CTA → fetched 200 page must contain a form. NO-FETCH-NO-CLAIM:
  // destinations never retrieved (not crawled, backfill missed/failed) are
  // NEVER claimed as dead ends — unfetched URLs carry zero evidence.
  const normKey = (u: string): string => {
    try {
      const x = new URL(u);
      return `${x.protocol}//${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/$/, '') || '/'}`;
    } catch {
      return u.replace(/\/$/, '').toLowerCase();
    }
  };
  const pageByNorm = new Map<string, (typeof a.pages)[number]>();
  for (const p of a.pages) {
    if (p.finalUrl) pageByNorm.set(normKey(p.finalUrl), p);
    pageByNorm.set(normKey(p.url), p);
  }
  for (const cta of a.ctas) {
    if (!cta.href || cta.destinationOk === false) continue; // already covered by CTA rules
    let dest: URL;
    try {
      dest = new URL(cta.href);
    } catch {
      continue;
    }
    if (cta.kind === 'quote' || cta.kind === 'contact') {
      const page = pageByNorm.get(normKey(dest.toString()));
      const formsOnDest = a.forms.filter((f) => {
        try {
          return normKey(new URL(f.page).toString()) === normKey(dest.toString());
        } catch {
          return false;
        }
      });
      if (page && page.statusCode !== null && page.statusCode >= 400) continue; // broken dest: P4's claim
      if (page && !formsOnDest.length && !/contact|quote|book|estimate|appointment/i.test(dest.pathname)) {
        out.push({
          module: 'cta',
          category: 'conversion-path',
          severity: 'HIGH',
          title: `“${cta.text.slice(0, 40)}” leads nowhere actionable`,
          description: `The ${cta.kind} CTA resolves, but its destination shows no quote/contact form. The conversion path may be a dead end — manual verification required.`,
          pageUrl: home.url,
          measuredValue: dest.toString().slice(0, 200),
          evidence: { page: home.url, details: { cta_text: cta.text, destination: dest.toString().slice(0, 300) } },
        });
      }
      void page;
    }
    if (cta.kind === 'booking' && !dest.hostname.includes(new URL(home.url).hostname)) {
      // Third-party booking system: only check it answers (no deep crawl inside).
      const check = a.linkChecks.find((l) => l.url === dest.toString());
      if (check?.broken) {
        out.push({
          module: 'cta',
          category: 'conversion-path',
          severity: 'EMERGENCY',
          title: `Booking path is broken (“${cta.text.slice(0, 40)}”)`,
          description: `The booking CTA points to an external system that ${check.status != null ? `returns HTTP ${check.status}` : 'could not be reached'}. Online bookings may be impossible.`,
          pageUrl: home.url,
          measuredValue: check.status != null ? `HTTP ${check.status}` : (check.error ?? 'unreachable'),
          evidence: { page: home.url, details: { cta_text: cta.text, destination: dest.toString().slice(0, 300) } },
        });
      }
    }
  }
  return out.slice(0, 4);
}

/**
 * Retention law (Emon reviews everything): NOTHING detected is ever dropped
 * in code. Contradicted findings are DEMOTED with a suppression_note in
 * evidence (contradiction history kept) so they persist to MySQL and can be
 * verified or manually deleted from the UI.
 *
 * Two demotion depths:
 *  - demoteToMedium: genuinely contradicted (stronger evidence proves the
 *    claim wrong, e.g. a VISIBLE tel: link, a synthetic-click dial proof).
 *    MEDIUM never scores or pitches — silence is correct there.
 *  - demoteToHigh: WEAK contradiction — the counter-signal is real but does
 *    not clear the owner of the problem (e.g. a below-fold/menu/covered
 *    tel: link when the header number is untappable, or a browser pass that
 *    found no dial signal at all). HIGH keeps it scored + pitched, but the
 *    soft_claim flag drops confidence to MEDIUM so it ranks below proven
 *    findings and the brief carries the verify-note.
 */
function setSuppressionNote(f: FindingInput, note: string): Record<string, unknown> {
  const ev = { ...(f.evidence ?? {}) } as Record<string, unknown>;
  const det = ev['details'];
  if (det && typeof det === 'object' && !Array.isArray(det)) {
    (det as Record<string, string>)['suppression_note'] = note;
  } else {
    ev['suppression_note'] = note;
  }
  return ev;
}

function demoteToMedium(f: FindingInput, note: string): FindingInput {
  return { ...f, severity: 'MEDIUM', evidence: setSuppressionNote(f, note) };
}

function demoteToHigh(f: FindingInput, note: string): FindingInput {
  const ev = setSuppressionNote(f, note);
  const det = ev['details'];
  if (det && typeof det === 'object' && !Array.isArray(det)) {
    (det as Record<string, string>)['soft_claim'] = 'true';
  } else {
    ev['soft_claim'] = 'true';
  }
  return { ...f, severity: 'HIGH', evidence: ev };
}

/**
 * Two-signal law (BD strict fix, softened for conversion): a crawler-only
 * "phone not clickable" EMERGENCY that the browser pass could not
 * corroborate in ANY form (no dial-protocol href, no clickable digit-text,
 * no click effect for these digits) is DEMOTED to HIGH — not MEDIUM. The
 * browser ran clean and STILL found no way to dial: that corroborates the
 * problem rather than contradicting it, so silence would hide a real leak.
 * The soft_claim flag keeps confidence at MEDIUM and the verify-note rides
 * into the brief. Untouched when the browser never ran (loadError) since
 * silence there is not evidence either way.
 */
export function gateUncorroborated(raw: FindingInput[], a: ScanArtifacts): FindingInput[] {
  const digits = (s: string) => s.replace(/\D/g, '');
  const mobile = a.browser?.mobile;
  if (!mobile || mobile.loadError) return raw;
  const seen = new Set<string>();
  for (const vp of [mobile, a.browser?.tablet, a.browser?.desktop]) {
    for (const o of vp?.ctaObservations ?? []) {
      const href = (o.href ?? '').toLowerCase();
      if (/^(tel|callto|wtai):/.test(href)) seen.add(digits(o.href ?? ''));
      if ((o.hasOnClick || o.hasDataAction || o.hasClickListener === true || o.clickable) && /\d{7,}/.test(o.text ?? '')) {
        seen.add(digits(o.text));
      }
      if ((o.clickEffect === 'dialog' || o.clickEffect === 'popup' || o.clickEffect === 'navigation') && o.text) {
        seen.add(digits(o.text));
      }
    }
  }
  const out: FindingInput[] = [];
  for (const f of raw) {
    if (f.module !== 'phone' || !/not clickable/i.test(f.title)) {
      out.push(f);
      continue;
    }
    if (f.severity !== 'EMERGENCY') {
      out.push(f);
      continue;
    }
    const num = digits(f.measuredValue ?? '');
    const corroborated = num && [...seen].some((s) => s && matchDigits(s, num));
    if (corroborated) {
      out.push(f);
      continue;
    }
    a.contradictions.push({
      area: `phone:${num || 'unknown'}`,
      domSays: 'no tel: link in markup',
      visualSays: 'browser saw no dial signal for these digits',
      resolution: 'SOFT-DOWNGRADED',
    });
    a.suppressedCount++;
    out.push(demoteToHigh(f, 'Browser pass found no dial path either — likely a real gap, review on a real phone before outreach.'));
  }
  return out;
}

/**
 * False-positive suppression (§23): a finding contradicted by stronger
 * evidence is DEMOTED to MEDIUM (never dropped) with the contradiction
 * recorded. Suppressions are counted (scan quality), never silent.
 */
export function suppressContradicted(raw: FindingInput[], a: ScanArtifacts): FindingInput[] {
  const digits = (s: string) => s.replace(/\D/g, '');
  // Dial-proofs: tel:/callto:/wtai: observations in any DIALABLE verdict
  // (below-fold/menu/covered links still dial — visibility is P2/P3's job),
  // keyed by trunk-normalized digits so +1/US trunk never mismatches.
  const DIALABLE = new Set(['VISIBLE', 'OUT_OF_VIEWPORT', 'IN_MENU', 'COVERED']);
  const dialProofs: { digits: string; how: string }[] = [];
  const visibleCtaTexts = new Set<string>();
  for (const vp of [a.browser?.mobile, a.browser?.tablet, a.browser?.desktop]) {
    for (const o of vp?.ctaObservations ?? []) {
      if (o.text) visibleCtaTexts.add(o.text.toLowerCase());
      const href = (o.href ?? '').toLowerCase();
      const proto = href.startsWith('tel:') ? 'tel:' : href.startsWith('callto:') ? 'callto:' : href.startsWith('wtai:') ? 'wtai:' : null;
      if (proto && DIALABLE.has(o.verdict)) {
        dialProofs.push({ digits: digits(o.href ?? ''), how: `${proto} ${o.verdict}` });
      }
      if (o.clickEffect === 'dialog' || o.clickEffect === 'popup' || o.clickEffect === 'navigation') {
        dialProofs.push({ digits: digits(o.text), how: `synthetic-click ${o.clickEffect}` });
      }
      // Working JS/call-handler buttons (onclick/data-action/CDP listener)
      // prove dialability even without any dial-protocol href.
      if ((o.hasOnClick || o.hasDataAction || o.hasClickListener === true || o.clickable) && o.text && /\d{7,}/.test(o.text)) {
        dialProofs.push({ digits: digits(o.text), how: 'js-call-handler' });
      }
    }
  }
  const out: FindingInput[] = [];
  for (const f of raw) {
    // "Phone not clickable" steps down on ANY trunk-normalized dial-proof —
    // but depth depends on proof strength. A VISIBLE tel: link, a
    // synthetic-click dial effect, or a working JS call-handler genuinely
    // clears the number → MEDIUM (silent). A tel: link buried below the
    // fold, inside the menu, or under an overlay does NOT help the visitor
    // staring at the untappable header number → HIGH soft-claim: still
    // scored + pitched, with the verify-note attached.
    if (f.module === 'phone' && /not clickable/i.test(f.title)) {
      const num = digits(f.measuredValue ?? '');
      const proofs = num ? dialProofs.filter((p) => p.digits && matchDigits(p.digits, num)) : [];
      const isStrong = (how: string): boolean =>
        how.startsWith('synthetic-click') || how.startsWith('js-call-handler') || /\bVISIBLE\b/.test(how);
      // Strongest proof wins: one VISIBLE tel: clears the number even when
      // weaker buried copies exist for the same digits.
      const proof = proofs.find((p) => isStrong(p.how)) ?? proofs[0];
      if (proof) {
        const strong = isStrong(proof.how);
        a.contradictions.push({
          area: `phone:${num}`,
          domSays: 'no tel: link in markup',
          visualSays: `dialable in browser (${proof.how})`,
          resolution: strong ? 'DOWNGRADED' : 'SOFT-DOWNGRADED',
        });
        a.suppressedCount++;
        out.push(
          strong
            ? demoteToMedium(f, `Browser dial-proof (${proof.how}) — verify on a real phone before outreach.`)
            : demoteToHigh(f, `Only a buried dial path exists (${proof.how}) — header visitors still cannot tap, verify on a real phone before outreach.`),
        );
        continue;
      }
    }
    // "CTA not visible on mobile" steps down when mobile shows it VISIBLE.
    if (f.module === 'mobile-ui' && f.category === 'cta-visibility') {
      const t = /"([^"]+)"/.exec(f.title)?.[1]?.toLowerCase() ?? '';
      if (t && visibleCtaTexts.has(t)) {
        const mobileVisible = (a.browser?.mobile.ctaObservations ?? []).some(
          (o) => o.verdict === 'VISIBLE' && o.text.toLowerCase() === t,
        );
        if (mobileVisible) {
          a.contradictions.push({
            area: `cta:${t.slice(0, 60)}`,
            domSays: 'CTA hidden',
            visualSays: 'CTA visible + hit-tested on mobile',
            resolution: 'DOWNGRADED',
          });
          a.suppressedCount++;
          out.push(demoteToMedium(f, 'Visible + hit-tested on mobile at scan time — review before outreach.'));
          continue;
        }
      }
    }
    out.push(f);
  }
  return out;
}

