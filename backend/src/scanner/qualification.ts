/**
 * TARGET QUALIFICATION ENGINE — binary PURSUE vs SKIP triage.
 *
 * Pure + deterministic (no network, no AI). Decides whether a scanned site
 * is worth outbound capacity (PURSUE) or must be discarded (SKIP) per the
 * 6 absolute disqualification rules. Unknown = PURSUE: we fail OPEN toward
 * scanning (a missed lead is worse than a wasted scan) but fail CLOSED
 * toward claiming (every SKIP cites measured evidence).
 *
 * Outreach-worthy ("qualifying") leaks are the matrix categories only:
 *   M2 SSL wall, M3/M4 phone dialer, M5 covered CTA, M6 below-fold,
 *   M7/M8 dead capture route, M9 form friction, M10 speed bleed.
 * M11/M12/M13/M14 stay detected (tabs still show them) but are SILENT:
 * never scored, never briefed, never exported.
 */
import { leakFor, type MoneyLeakId } from './money-leaks';
import type { TechItem, TechReport } from './technology';
import type { FindingInput, ScanArtifacts } from './types';

export type QualificationStatus = 'PURSUE' | 'SKIP';

export type SkipRule =
  | 'excluded-stack'
  | 'enterprise'
  | 'ecommerce'
  | 'dead-site'
  | 'trivial-only'
  | 'clean-site';

export interface Qualification {
  status: QualificationStatus;
  /** 'qualified' when PURSUE, else the SKIP rule that fired. */
  rule: SkipRule | 'qualified';
  /** Short human reason, stored as scan.skip_reason + shown in UI. */
  reason: string;
}

/** Matrix leaks that alone justify outreach (Part 2, categories 1–5). */
export const QUALIFYING_LEAKS: readonly MoneyLeakId[] = [
  'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10',
];

/** Detected but silent: kept in tabs, excluded from score/brief/export. */
export const SILENT_LEAKS: readonly MoneyLeakId[] = ['M11', 'M12', 'M13', 'M14'];

const QUALIFYING = new Set<string>(QUALIFYING_LEAKS);
const SILENT = new Set<string>(SILENT_LEAKS);

/** True when the finding alone justifies outreach (matrix + EMERGENCY/HIGH). */
export function isQualifyingFinding(f: { module: string; category: string; severity: string }): boolean {
  if (f.severity !== 'EMERGENCY' && f.severity !== 'HIGH') return false;
  const leak = leakFor(f.module, f.category);
  return leak !== null && QUALIFYING.has(leak.id);
}

/** True when the finding is detected-but-silent (no score/brief/export). */
export function isSilentLeak(module: string, category: string): boolean {
  const leak = leakFor(module, category);
  return leak !== null && SILENT.has(leak.id);
}

/**
 * Part 3 anchor hierarchy rank (lower = lead the email with this).
 * Ranked: 1 phone dialer (M3/M4), 2 hero/LCP bleed (M10), 3 dead route
 * (M7/M8), 5 form friction (M9), 6 below-fold (M6). Rank 4 (missing
 * sticky CTA) has no detector yet — arrives in Release 2.
 * Unranked-but-qualifying (M5 covered CTA, M2 SSL wall): null → brief
 * orders them by priorityScore after the ranked blocks.
 */
export function anchorRankFor(module: string, category: string): number | null {
  const leak = leakFor(module, category);
  if (!leak) return null;
  switch (leak.id) {
    case 'M3':
    case 'M4':
      return 1;
    case 'M10':
      return 2;
    case 'M7':
    case 'M8':
      return 3;
    case 'M9':
      return 5;
    case 'M6':
      return 6;
    default:
      return null;
  }
}

// ─── SKIP-1: excluded technology stacks ─────────────────────────────
// Out of service boundaries (strictly WordPress + Laravel). Match on
// detected item names (exact, case-insensitive) + primaryPlatform
// fallback. LOW-confidence detections never disqualify.

const EXCLUDED_STACKS = new Set([
  'shopify', 'bigcommerce', 'magento', 'wix', 'squarespace',
  'react', 'react.js', 'next', 'next.js', 'vue', 'vue.js', 'nuxt',
]);

function excludedStackName(tech: TechReport | null): string | null {
  if (!tech) return null;
  const hit = (name: string): boolean => EXCLUDED_STACKS.has(name.trim().toLowerCase());
  for (const item of tech.items as TechItem[]) {
    if (item.confidence === 'LOW') continue;
    if (hit(item.technology)) return item.technology;
  }
  const primary = (tech.primaryPlatform ?? '').toLowerCase();
  for (const s of EXCLUDED_STACKS) {
    if (primary.includes(s)) return tech.primaryPlatform;
  }
  return null;
}

// ─── SKIP-2: enterprise conglomerates & mega-franchises (strong only) ─
// 50+ branches proven by EITHER: 50+ distinct location-ish URLs, OR a
// stated "N locations/stores/branches" count with N >= 50 in page copy.
// Weak signals (a /locations page, the word "franchise") never SKIP.

const LOCATION_URL_RE = /\/(location|locations|stores?|branches|offices?)(\/|$|[?#])/i;
const STATED_COUNT_RE = /(\d{2,4})\s+(locations|stores|branches|offices)\b/i;

function enterpriseEvidence(a: ScanArtifacts): string | null {
  const locUrls = new Set<string>();
  for (const p of a.pages) {
    try {
      if (LOCATION_URL_RE.test(new URL(p.url).pathname)) locUrls.add(p.normalizedUrl);
    } catch {
      /* ignore unparseable urls */
    }
  }
  for (const l of a.links) {
    if (!l.absoluteUrl) continue;
    try {
      if (l.absoluteUrl.startsWith('http') && LOCATION_URL_RE.test(new URL(l.absoluteUrl).pathname)) {
        locUrls.add(l.absoluteUrl.split(/[?#]/)[0]!);
      }
    } catch {
      /* ignore */
    }
  }
  if (locUrls.size >= 50) return `${locUrls.size} distinct location pages`;
  let best = 0;
  for (const p of a.pages) {
    const html = p.html ?? '';
    if (html.length === 0) continue;
    const m = STATED_COUNT_RE.exec(html.slice(0, 200000));
    if (m) best = Math.max(best, Number(m[1]));
  }
  if (best >= 50) return `site claims ${best} locations`;
  return null;
}

// ─── SKIP-3: e-commerce & retail product stores ─────────────────────
// Corroborated only: a cart/checkout link AND (checkout link OR cart
// platform detected OR add-to-cart markup). A lone "/shop" link never
// disqualifies (many service sites sell a gift card).

const CART_RE = /\/(cart|basket)(\/|$|[?#])/i;
const CHECKOUT_RE = /\/(checkout|payment)(\/|$|[?#])/i;
const ADD_TO_CART_RE = /add[-_]to[-_]cart|addToCart/i;
const CART_PLATFORMS = new Set(['shopify', 'bigcommerce', 'magento', 'woocommerce']);

function ecommerceEvidence(tech: TechReport | null, a: ScanArtifacts): string | null {
  let cart = 0;
  let checkout = 0;
  for (const l of a.links) {
    const href = `${l.href ?? ''} ${l.absoluteUrl ?? ''}`;
    if (CART_RE.test(href)) cart++;
    if (CHECKOUT_RE.test(href)) checkout++;
  }
  if (cart === 0) return null;
  const platform = (tech?.items as TechItem[] | undefined)?.some((i) =>
    CART_PLATFORMS.has(i.technology.trim().toLowerCase()),
  ) === true;
  const markup = a.pages.some((p) => ADD_TO_CART_RE.test(p.html ?? ''));
  if (checkout >= 1 || platform || markup) {
    const bits = [`${cart} cart link(s)`];
    if (checkout >= 1) bits.push(`${checkout} checkout link(s)`);
    if (platform) bits.push('cart platform detected');
    if (markup) bits.push('add-to-cart markup');
    return bits.join(' + ');
  }
  return null;
}

// ─── SKIP-6 helpers: clean & high-performing check ──────────────────

function visibleFieldCount(a: ScanArtifacts): number {
  let best = 0;
  for (const f of a.forms) {
    const n = Array.isArray(f.fields) && f.fields.length > 0
      ? f.fields.filter((fld) => (fld.type ?? '').toLowerCase() !== 'hidden').length
      : (f.fieldCount ?? 0);
    best = Math.max(best, n);
  }
  return best;
}

/**
 * Binary triage. Findings should be the raw built list (pre-suppression);
 * only EMERGENCY/HIGH matrix leaks count as qualifying.
 */
export function qualifySite(
  tech: TechReport | null,
  artifacts: ScanArtifacts,
  findings: FindingInput[],
): Qualification {
  // SKIP-4: dead, parked, or down (safety net — pipeline parks these earlier).
  const av = artifacts.availability;
  if (av && (av.status === 'timeout' || av.status === 'unavailable' || av.status === 'failed' ||
    (av.httpStatus != null && av.httpStatus >= 500))) {
    return { status: 'SKIP', rule: 'dead-site', reason: `Site unreachable (${av.status}${av.httpStatus ? `, HTTP ${av.httpStatus}` : ''})` };
  }

  // SKIP-1: excluded technology stack.
  const stack = excludedStackName(tech);
  if (stack) {
    return { status: 'SKIP', rule: 'excluded-stack', reason: `Built on ${stack} (out of WordPress/Laravel scope)` };
  }

  // SKIP-3: e-commerce & retail product stores.
  const ecom = ecommerceEvidence(tech, artifacts);
  if (ecom) {
    return { status: 'SKIP', rule: 'ecommerce', reason: `Product store signals (${ecom})` };
  }

  // SKIP-2: enterprise conglomerates & mega-franchises (strong signal only).
  const ent = enterpriseEvidence(artifacts);
  if (ent) {
    return { status: 'SKIP', rule: 'enterprise', reason: `Enterprise footprint (${ent})` };
  }

  // Any outreach-worthy leak → PURSUE.
  const qualifying = findings.filter(isQualifyingFinding);
  if (qualifying.length > 0) {
    const top = leakFor(qualifying[0]!.module, qualifying[0]!.category);
    return {
      status: 'PURSUE',
      rule: 'qualified',
      reason: `${qualifying.length} outreach-worthy leak(s)${top ? `, lead: ${top.id}` : ''}`,
    };
  }

  // SKIP-6: clean & high-performing (all four signals good).
  const mobile = artifacts.browser?.mobile ?? null;
  const lcp = mobile?.lcpMs ?? mobile?.loadMs ?? null;
  const telOk = artifacts.phones.some((p) => p.isValid && p.hasTelLink);
  const fields = visibleFieldCount(artifacts);
  const overflow = mobile?.horizontalOverflow === true;
  if (lcp !== null && lcp < 3000 && telOk && fields < 6 && !overflow) {
    return {
      status: 'SKIP',
      rule: 'clean-site',
      reason: `Clean & fast (LCP ${Math.round(lcp)}ms, tel link ok, ${fields} form fields, no overflow)`,
    };
  }

  // SKIP-5: only trivial/academic issues (or nothing at all).
  return { status: 'SKIP', rule: 'trivial-only', reason: 'No fatal conversion leaks — minor hygiene only' };
}
