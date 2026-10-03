/**
 * Shared scanner domain types. All scanner modules + finding engine + queue
 * speak through these. Deterministic — no AI anywhere.
 */

export type ScanStatus =
  | 'pending'
  | 'scanning'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'blocked';

/**
 * Triage severities v2 — only EMERGENCY/HIGH/MEDIUM persist to MySQL.
 * LOW/INFO are suppressed (never saved). Legacy 'CRITICAL' maps to
 * 'EMERGENCY' at the DB mapper boundary for backward compatibility.
 */
export type Severity = 'EMERGENCY' | 'HIGH' | 'MEDIUM';
export type LegacySeverity = 'CRITICAL' | 'LOW' | 'INFO';
export type AnySeverity = Severity | LegacySeverity;

/** Normalize legacy severities to the v2 triage set (null = suppress). */
export function normalizeSeverity(s: string): Severity | null {
  if (s === 'EMERGENCY' || s === 'CRITICAL') return 'EMERGENCY';
  if (s === 'HIGH') return 'HIGH';
  if (s === 'MEDIUM') return 'MEDIUM';
  return null;
}

export interface Evidence {
  page: string;
  viewport?: string;
  details: Record<string, string>;
}

export interface FindingInput {
  module: string;
  category: string;
  severity: Severity;
  title: string;
  description: string;
  pageUrl?: string;
  measuredValue?: string;
  expectedValue?: string;
  evidence?: Record<string, unknown>;
  // Business intelligence (filled by the impact engine, stored in DB).
  businessCategory?: string;
  conversionImpact?: string;
  confidence?: string;
  priorityScore?: number;
  groupKey?: string | null;
  isGroupPrimary?: boolean;
  groupTitle?: string | null;
  whyPrioritized?: string[];
  /** Forensic niche mega-group (EMERGENCY = call-is-life, BOOKING = quote-is-life). */
  nicheGroup?: 'EMERGENCY' | 'BOOKING';
}

export interface FindingRow extends FindingInput {
  id: number;
  scanId: number;
  websiteId: number;
  createdAt: string;
}

// ---------- Module outputs ----------

export interface RedirectHop {
  url: string;
  status: number;
}

export interface AvailabilityResult {
  ok: boolean;
  status: 'available' | 'unavailable' | 'timeout' | 'blocked' | 'failed';
  httpStatus: number | null;
  finalUrl: string | null;
  https: boolean;
  redirectChain: RedirectHop[];
  redirectCount: number;
  responseTimeMs: number | null;
  ttfbMs: number | null;
  headers: Record<string, string>;
  certExpiry: string | null;
  error: string | null;
  /** Set when we could not complete the test (block/timeout) — never a clean bill. */
  incomplete: boolean;
  incompleteReason: string | null;
  /** Network attempts made (1 normally, 2 when the first attempt was retried). */
  attempts: number;
}

export interface CrawledPage {
  url: string;
  normalizedUrl: string;
  statusCode: number | null;
  finalUrl: string | null;
  responseTimeMs: number | null;
  title: string | null;
  isHomepage: boolean;
  html: string;
}

export interface DiscoveredLink {
  sourcePage: string;
  href: string;
  absoluteUrl: string | null;
  text: string;
  kind: 'internal' | 'external' | 'tel' | 'mailto' | 'other';
  importance: 'nav' | 'cta' | 'contact' | 'normal';
}

export interface LinkCheck {
  sourcePage: string;
  text: string;
  kind: DiscoveredLink['kind'];
  importance: DiscoveredLink['importance'];
  url: string;
  status: number | null;
  finalUrl: string | null;
  redirectCount: number;
  broken: boolean;
  error: string | null;
  attempts?: number;
}

export interface PhoneFinding {
  raw: string;
  normalized: string;
  /** E.164 when libphonenumber validates, else normalized digits. */
  e164: string | null;
  /** True when libphonenumber confirms a dialable US/UK/CA/AU/BD number. */
  isValid: boolean;
  page: string;
  hasTelLink: boolean;
  /** tel: URI present but malformed (dialer would fail). */
  telMalformed: boolean;
  /** Number found only in page code (JSON-LD/schema), not visible copy:
   *  visitors cannot see or tap it — a code-only M4, never M3. */
  codeOnly?: boolean;
}

export interface CtaFinding {
  text: string;
  href: string | null;
  page: string;
  kind: string;
  destinationOk: boolean | null;
  destinationStatus: number | null;
  visibleOnMobile: boolean | null;
}

export interface FormInfo {
  page: string;
  index: number;
  action: string | null;
  method: string;
  fieldCount: number;
  hasEmailField: boolean;
  hasPhoneField: boolean;
  hasMessageField: boolean;
  hasSubmit: boolean;
  /** True when submission is JS-handled (div pseudo-form or js: action):
   *  no EMERGENCY "goes nowhere" claim allowed — at most a manual-review note. */
  jsSubmit: boolean;
  hasCaptcha: boolean;
  unlabeledFields: number;
  fields: { name: string; type: string; required: boolean; labeled: boolean }[];
}

export interface BrowserResult {
  desktop: ViewportResult;
  tablet: ViewportResult;
  mobile: ViewportResult;
  blocked: boolean;
  blockedReason: string | null;
}

export interface ViewportResult {
  name: 'desktop' | 'tablet' | 'mobile';
  width: number;
  height: number;
  title: string | null;
  loadError: string | null;
  jsErrors: string[];
  consoleErrors: string[];
  failedRequests: { url: string; reason: string }[];
  horizontalOverflow: boolean;
  overflowWidth: number;
  hiddenCtaCount: number;
  navPresent: boolean;
  aboveFold: { ctaVisible: boolean; phoneVisible: boolean; ctaCount: number } | null;
  ctaObservations: CtaObservation[];
  /** axe target-size corroboration (mobile only, null = not run). */
  targetSize?: { nodes: number; sample: string | null } | null;
  /** pixel-diff % between first and settled mobile shots (supporting evidence only). */
  layoutShiftPct?: number | null;
  screenshotPath: string | null;
  fullScreenshotPath: string | null;
  /** Scan-time mobile hero crop (390x1300 WebP, same pass as findings). */
  heroCropPath: string | null;
  /** Red-outline annotated hero (critical offenders highlighted, same pass). */
  annotatedCropPath?: string | null;
  /** Settled post-hydration DOM (mobile homepage only, ≤2MB) — second-chance
   *  input for phone/form extractors when JS renders what fetch never saw. */
  renderedHtml?: string | null;
  /** Per-problem close-up clips (red-marked, same pass): {file, kind, doc-box}. */
  evShots?: { file: string; kind: string; box: { x: number; y: number; width: number; height: number } }[];
  /** Module-2 phone hit-test: visible plain-text numbers without tel: wrap. */
  phoneHitTest?: {
    offenders: { text: string; selector: string; scope?: string; box: { x: number; y: number; width: number; height: number } }[];
    proofs: { text: string; tel: string }[];
  } | null;
  /** Module-4 overflow offender: exact element sticking past the viewport. */
  overflowOffender?: {
    selector: string; tag: string; overflowPx: number;
    rect: { x: number; y: number; width: number; height: number };
  } | null;
  ttfbMs: number | null;
  domContentLoadedMs: number | null;
  loadMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  /** web-vitals INP (null without interaction — never a failure). */
  inpMs?: number | null;
  /** web-vitals LCP attribution (which element painted largest). */
  lcpElement?: string | null;
  /**
   * Forensic LCP asset join (Phase 2): which network resource caused the LCP.
   * null = text LCP (h1/h2) or unmapped — NEVER guess, report font/CSS instead.
   * Populated in browser.ts by joining lcpUrl against resources[].
   */
  lcpAsset?: { url: string; bytesMB: number; durationMs: number; kind: 'image' | 'text' | 'other'; renderMs?: number | null } | null;
  resources: ResourceEntry[];
}

export interface ResourceEntry {
  url: string;
  type: string;
  bytes: number;
  durationMs: number;
}

// ---------- Accuracy: multi-signal UI verdicts ----------

export interface CtaBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CtaObservation {
  text: string;
  aria: string | null;
  href: string | null;
  tag: string;
  role: string | null;
  inMenu: boolean;
  stickyOrFloating: boolean;
  box: CtaBox | null;
  displayed: boolean;
  visibilityVisible: boolean;
  opacityVisible: boolean;
  hasSize: boolean;
  inViewport: boolean;
  notClipped: boolean;
  hitTestPass: boolean | null;
  /** Quad hit-test vote (Phase 2): pass/total points sampled. Null = center-only legacy. */
  hitTestScore?: { pass: number; total: number } | null;
  /** Covering element at the tap point (null when the CTA itself is on top). */
  cover?: { tag: string; selector: string } | null;
  /** Rough in-page selector (tag#id.class, best-effort — for evidence shots). */
  selector?: string | null;
  clickable: boolean;
  /** Multi-signal clickability: onclick / data-action / role=button / tel: / CDP click listener. */
  hasClickListener: boolean | null;
  hasOnClick: boolean;
  hasDataAction: boolean;
  /** True when hit-test was re-run after overlay suppression. */
  overlaySuppressed: boolean;
  /**
   * Synthetic click outcome (mobile pass, phone candidates only).
   * 'dialog'|'popup'|'navigation' prove dialability. 'none' proves NOTHING
   * (desktop Chromium shows no observable event for tel:) — never used
   * as negative evidence. null = not attempted / attempt failed.
   */
  clickEffect?: 'dialog' | 'popup' | 'navigation' | 'none' | null;
  verdict: 'VISIBLE' | 'HIDDEN' | 'COVERED' | 'OUT_OF_VIEWPORT' | 'ZERO_SIZE' | 'IN_MENU' | 'INCONCLUSIVE';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  screenshotCrop: string | null;
}

export interface Contradiction {
  area: string;
  domSays: string;
  visualSays: string;
  resolution: 'SUPPRESSED' | 'INCONCLUSIVE' | 'RECHECKED' | 'DOWNGRADED' | 'SOFT-DOWNGRADED';
}

// ---------- Security assessment model ----------

export type SecurityStatus =
  | 'PASS'
  | 'FAIL'
  | 'WARNING'
  | 'NOT_TESTED'
  | 'INCONCLUSIVE'
  | 'BLOCKED'
  | 'REQUIRES_MANUAL_REVIEW';

export interface SecurityCheck {
  checkId: string;
  title: string;
  status: SecurityStatus;
  observed: string | null;
  expected: string;
  risk: 'Critical' | 'High' | 'Medium' | 'Low' | 'Info';
  recommendation: string;
  evidence: Record<string, string>;
  owasp: string;
  automated: 'AUTOMATED' | 'MANUAL_REQUIRED' | 'NOT_TESTED';
}

export interface ScanQuality {
  pagesAnalyzed: number;
  pagesBlocked: number;
  pagesFailed: number;
  checksCompleted: number;
  checksNotTested: number;
  checksManualReview: number;
  visualChecks: number;
  contradictions: number;
  suppressed: number;
}

export interface SecurityResult {
  https: boolean;
  hsts: string | null;
  csp: string | null;
  frameOptions: string | null;
  contentTypeOptions: string | null;
  referrerPolicy: string | null;
  insecureCookies: string[];
  certExpiry: string | null;
}

export interface A11yViolation {
  id: string;
  impact: string | null;
  description: string;
  nodes: number;
  sampleTarget: string | null;
}

export interface ScanArtifacts {
  availability: AvailabilityResult | null;
  pages: CrawledPage[];
  links: DiscoveredLink[];
  linkChecks: LinkCheck[];
  phones: PhoneFinding[];
  ctas: CtaFinding[];
  forms: FormInfo[];
  browser: BrowserResult | null;
  security: SecurityResult | null;
  securityChecks: SecurityCheck[];
  contradictions: Contradiction[];
  suppressedCount: number;
  a11y: A11yViolation[];
  moduleErrors: { module: string; error: string }[];
}

export interface OpportunityBreakdown {
  score: number;
  parts: { reason: string; points: number }[];
}
