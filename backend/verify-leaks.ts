/**
 * Money-leak catalog verification (no test framework needed).
 * Run: npm run verify:leaks   (npx tsx verify-leaks.ts from backend/)
 *
 * Crafts minimal ScanArtifacts fixtures and asserts:
 *  T1 clean site          -> zero findings (DROP rules emit nothing)
 *  T2 phone text, no tel  -> M4 phone/call HIGH, and NO M3
 *  T3 no phone anywhere   -> M3 phone/call-missing HIGH (BOOKING default)
  *  T4 retired (v1.4.0)  -> dead-contact emits nothing
  *  T5 retired (v1.4.0)  -> malformed-tel string check emits nothing
 *  T6 fail-closed guard   -> every emitted finding maps via leakFor()
 *  T7 brief quality       -> Email angle present, banned (dropped) words absent
 *  T8 scoring             -> leaky fixture scores above clean fixture
 *  T9 AU phones           -> AU formats validate + trunk-match tel: links
 *  T10 M1 retry policy    -> only timeout/failed retry (pure)
 *  T11 perf corroboration -> slow browser + slow fetch fires; flake stays silent
 *  T12 brief meta         -> dedupe count, pages crawled, stale warning
 *  T13 suite FAILs gated  -> pipeline drops non-catalog conversions
 *  T14 legacy rows        -> never score, never reach the brief
 *  T15 L1 story           -> M3+M4 merge into one block
  *  T16 L3 story           -> M7 live detectors merge into one block
  *  T29 forensic-only      -> B-class content reads emit nothing
  *  T17 M1 banner          -> dead-site brief forbids outreach
  *  T18 story completeness -> every leak except M1/M2 has a story
  *  T20-T24 qualification  -> excluded-stack / ecommerce / enterprise /
  *                            clean-site SKIP, matrix leak PURSUE
  *  T25 silent leaks       -> M11-M14 never score
  *  T26 anchor hierarchy   -> Part-3 rank beats raw priority in the brief
  *  T27 silent brief       -> silent findings never reach the brief
  *  T28 SKIP brief         -> SKIP scan bans outreach (no check-in fallback)
  */
import { buildFindings, scoreFindings } from './src/scanner/findings';
import { leakFor, moneyHookFor, MONEY_LEAKS, storyFor, CLIENT_STORIES } from './src/scanner/money-leaks';
import { anchorRankFor, isSilentLeak, qualifySite } from './src/scanner/qualification';
import { validatePhone, matchDigits } from './src/scanner/phone-validate';
import { shouldRetryAvailability } from './src/scanner/availability';
import { securityFindings } from './src/scanner/security-plus';
import { enrichFindings, scoreCapped, scoreEnriched } from './src/scanner/intelligence';
import { buildLlmBrief } from './src/services/llm-brief';
import type {
  AvailabilityResult,
  BrowserResult,
  CrawledPage,
  DiscoveredLink,
  FindingInput,
  FormInfo,
  PhoneFinding,
  ScanArtifacts,
  SecurityResult,
  ViewportResult,
} from './src/scanner/types';

const HOME = 'https://example-smb.test/';

function avail(): AvailabilityResult {
  return {
    ok: true, status: 'available', httpStatus: 200, finalUrl: HOME, https: true,
    redirectChain: [], redirectCount: 0, responseTimeMs: 300, ttfbMs: 400,
    headers: {}, certExpiry: null, error: null, incomplete: false, incompleteReason: null,
    attempts: 1,
  };
}

function vp(name: ViewportResult['name'], extra: Partial<ViewportResult> = {}): ViewportResult {
  return {
    name, width: 390, height: 844, title: 'Test', loadError: null,
    jsErrors: [], consoleErrors: [], failedRequests: [],
    horizontalOverflow: false, overflowWidth: 0, hiddenCtaCount: 0,
    navPresent: true, aboveFold: null, ctaObservations: [],
    screenshotPath: null, fullScreenshotPath: null, heroCropPath: null,
    ttfbMs: null, domContentLoadedMs: null, loadMs: 800, lcpMs: null, cls: 0,
    resources: [], ...extra,
  };
}

function browser(): BrowserResult {
  return { desktop: vp('desktop'), tablet: vp('tablet'), mobile: vp('mobile'), blocked: false, blockedReason: null };
}

function sec(): SecurityResult {
  return {
    https: true, hsts: 'max-age=31536000', csp: "default-src 'self'",
    frameOptions: 'SAMEORIGIN', contentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin', insecureCookies: [], certExpiry: null,
  };
}

function page(url: string, home = false): CrawledPage {
  return {
    url, normalizedUrl: url, statusCode: 200, finalUrl: url,
    responseTimeMs: 200, title: 'Test', isHomepage: home, html: '<html><body>hi</body></html>',
  };
}

function telLink(): DiscoveredLink {
  return { sourcePage: HOME, href: 'tel:+15551234567', absoluteUrl: 'tel:+15551234567', text: 'Call', kind: 'tel', importance: 'contact' };
}

function goodPhone(): PhoneFinding {
  return {
    raw: '(555) 123-4567', normalized: '+15551234567', e164: '+15551234567',
    isValid: true, page: HOME, hasTelLink: true, telMalformed: false,
  };
}

function goodForm(): FormInfo {
  return {
    page: HOME, index: 0, action: 'https://example-smb.test/submit', method: 'POST',
    fieldCount: 3, hasEmailField: true, hasPhoneField: true, hasMessageField: true,
    hasSubmit: true, jsSubmit: false, hasCaptcha: false, unlabeledFields: 0,
    fields: [
      { name: 'email', type: 'email', required: true, labeled: true },
      { name: 'phone', type: 'tel', required: true, labeled: true },
      { name: 'message', type: 'text', required: false, labeled: true },
    ],
  };
}

function artifacts(over: Partial<ScanArtifacts> = {}): ScanArtifacts {
  return {
    availability: avail(), pages: [], links: [], linkChecks: [], phones: [],
    ctas: [], forms: [], browser: browser(), security: sec(), securityChecks: [],
    contradictions: [], suppressedCount: 0, a11y: [], moduleErrors: [], ...over,
  };
}

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function has(a: FindingInput[], module: string, category: string): boolean {
  return a.some((f) => f.module === module && f.category === category);
}

// T1: clean site -> zero findings.
{
  const out = buildFindings(
    artifacts({ pages: [page(HOME, true)], links: [telLink()], phones: [goodPhone()], forms: [goodForm()] }),
    HOME, 'general',
  );
  check('T1 clean site emits nothing', out.length === 0, `got ${out.length}: ${out.map((f) => `${f.module}/${f.category}`).join(', ')}`);
}

// T2: phone text without tel link -> M4 HIGH, no M3.
{
  const out = buildFindings(
    artifacts({
      pages: [page(HOME, true)],
      phones: [{ raw: '(555) 123-4567', normalized: '+15551234567', e164: '+15551234567', isValid: true, page: HOME, hasTelLink: false, telMalformed: false }],
      forms: [goodForm()],
    }),
    HOME, 'general',
  );
  check('T2 M4 phone/call HIGH', out.some((f) => f.module === 'phone' && f.category === 'call' && f.severity === 'HIGH'));
  check('T2 no M3 when a number exists', !has(out, 'phone', 'call-missing'));
}

// T3: no phone anywhere -> M3 call-missing HIGH for BOOKING default.
{
  const out = buildFindings(artifacts({ pages: [page(HOME, true)], forms: [goodForm()] }), HOME, 'general');
  check('T3 M3 call-missing HIGH', out.some((f) => f.module === 'phone' && f.category === 'call-missing' && f.severity === 'HIGH'));
}

// T3b: M3 is EMERGENCY for call-is-life niches.
{
  const out = buildFindings(artifacts({ pages: [page(HOME, true)], forms: [goodForm()] }), HOME, 'plumbing');
  check('T3b M3 EMERGENCY for plumbing', out.some((f) => f.module === 'phone' && f.category === 'call-missing' && f.severity === 'EMERGENCY'));
}

// T4 (dropped v1.4.0): bare contact page emits NO dead-contact — static
// absence reads are ChatGPT-derivable. The scan stays silent here.
{
  const contact = 'https://example-smb.test/contact';
  const out = buildFindings(
    artifacts({ pages: [page(HOME, true), page(contact)], links: [telLink()], phones: [goodPhone()] }),
    HOME, 'general',
  );
  check('T4 dead-contact retired', !out.some((f) => f.module === 'mobile-ui' && f.category === 'dead-contact'), out.map((f) => `${f.module}/${f.category}/${f.severity}`).join(', ') || 'none');
}

// T5 (dropped v1.4.0): malformed-tel string check retired — pure source
// validation. Malformed-only fixture emits no phone finding at all.
{
  const out = buildFindings(
    artifacts({
      pages: [page(HOME, true)],
      phones: [{ raw: 'tel:abc', normalized: 'abc', e164: null, isValid: false, page: HOME, hasTelLink: false, telMalformed: true }],
    }),
    HOME, 'general',
  );
  check('T5 malformed tel silent', !out.some((f) => f.module === 'phone' && f.category === 'call'));
}

// T6: fail-closed guard — everything ever emitted maps to the catalog.
{
  const samples: FindingInput[][] = [
    buildFindings(artifacts({ pages: [page(HOME, true)] }), HOME, 'general'),
    buildFindings(artifacts({ pages: [page(HOME, true)], phones: [{ raw: 'x', normalized: 'x', e164: null, isValid: false, page: HOME, hasTelLink: false, telMalformed: true }] }), HOME, 'towing'),
    buildFindings(artifacts({ pages: [page(HOME, true), page('https://example-smb.test/book')] }), HOME, 'medspa'),
  ];
  const all = samples.flat();
  check('T6 all emitted findings map to money leaks', all.every((f) => leakFor(f.module, f.category) !== null));
  check('T6 every leak has an email hook', MONEY_LEAKS.every((l) => l.emailSubject.length > 0 && l.emailSubject.length <= 60 && l.ownerPain.length > 0));
  check('T6 hooks resolve for emitted findings', all.every((f) => moneyHookFor(f.module, f.category) !== null));
}

// T7: brief quality — Email angle present, dropped-vocabulary absent.
{
  const out = buildFindings(
    artifacts({
      pages: [page(HOME, true)],
      phones: [{ raw: '(555) 123-4567', normalized: '+15551234567', e164: '+15551234567', isValid: true, page: HOME, hasTelLink: false, telMalformed: false }],
    }),
    HOME, 'general',
  );
  const brief = buildLlmBrief(
    { id: 1, url: HOME, businessName: null, contactName: null, contactEmail: null, niche: 'general', city: null },
    { id: 1, opportunityScore: 45, status: 'completed' },
    out.map((f, i) => ({ ...f, id: i + 1, scanId: 1, websiteId: 1, createdAt: new Date().toISOString() })),
    null,
  );
  const banned = ['spf', 'dmarc', 'cve', 'xmlrpc', 'clickjack', 'keyboard', 'mixed content', 'tap target'];
  const low = brief.toLowerCase();
  check('T7 brief has Email angle', brief.includes('Email angle:'));
  check('T7 brief free of dropped vocabulary', banned.every((w) => !low.includes(w)), banned.filter((w) => low.includes(w)).join(','));
}

// T8: scoring — leaky scores above clean.
{
  const clean = buildFindings(artifacts({ pages: [page(HOME, true)], links: [telLink()], phones: [goodPhone()], forms: [goodForm()] }), HOME, 'general');
  const leaky = buildFindings(
    artifacts({ pages: [page(HOME, true)], phones: [{ raw: '(555) 123-4567', normalized: '+15551234567', e164: '+15551234567', isValid: true, page: HOME, hasTelLink: false, telMalformed: false }] }),
    HOME, 'general',
  );
  check('T8 leaky outscores clean', scoreFindings(leaky).score > scoreFindings(clean).score, `${scoreFindings(leaky).score} vs ${scoreFindings(clean).score}`);
}

// T9: AU phones validate (mobile, +61, landline) and trunk-match tel: links.
{
  const au = ['0412 345 678', '+61 412 345 678', '(02) 9876 5432', '+61 2 9876 5432'];
  const results = au.map((raw) => validatePhone(raw));
  check('T9 AU formats validate', results.every((r) => r !== null && r.country === 'AU'), JSON.stringify(results));
  check('T9 AU trunk matches tel: link', matchDigits('+61412345678', '0412345678'));
  check('T9 US still validates', validatePhone('(555) 123-4567') !== null);
}

// T10: M1 retry policy — only transient network outcomes retry.
{
  check(
    'T10 retry policy',
    shouldRetryAvailability('timeout') === true &&
    shouldRetryAvailability('failed') === true &&
    shouldRetryAvailability('blocked') === false &&
    shouldRetryAvailability('unavailable') === false &&
    shouldRetryAvailability('available') === false,
  );
}

// T11: perf corroboration — agreed slowness fires, single-stack spike silent.
{
  const slowBrowser = (): BrowserResult => ({
    desktop: vp('desktop'), tablet: vp('tablet'),
    mobile: vp('mobile', { ttfbMs: 3000, lcpMs: null }),
    blocked: false, blockedReason: null,
  });
  const slowLcpBrowser = (): BrowserResult => ({
    desktop: vp('desktop'), tablet: vp('tablet'),
    mobile: vp('mobile', { ttfbMs: null, lcpMs: 6000 }),
    blocked: false, blockedReason: null,
  });
  const slowFetch = { ...avail(), ttfbMs: 2000, responseTimeMs: 5000 };
  const fastFetch = avail();
  const base = { pages: [page(HOME, true)], links: [telLink()], phones: [goodPhone()], forms: [goodForm()] };
  const ttfbBoth = buildFindings(artifacts({ ...base, browser: slowBrowser(), availability: slowFetch }), HOME, 'general');
  const ttfbFlake = buildFindings(artifacts({ ...base, browser: slowBrowser(), availability: fastFetch }), HOME, 'general');
  check('T11 TTFB corroborated fires', has(ttfbBoth, 'performance', 'loading'));
  check('T11 TTFB flake stays silent', !has(ttfbFlake, 'performance', 'loading'));
  const lcpBoth = buildFindings(artifacts({ ...base, browser: slowLcpBrowser(), availability: slowFetch }), HOME, 'general');
  const lcpFlake = buildFindings(artifacts({ ...base, browser: slowLcpBrowser(), availability: fastFetch }), HOME, 'general');
  check('T11 generic LCP corroborated fires', has(lcpBoth, 'performance', 'loading'));
  check('T11 generic LCP flake stays silent', !has(lcpFlake, 'performance', 'loading'));
}

// T12: brief meta — dedupe count, pages crawled, stale warning.
{
  const mk = (id: number): Parameters<typeof buildLlmBrief>[2][number] => ({
    id, scanId: 1, websiteId: 1, createdAt: new Date().toISOString(),
    module: 'phone', category: 'call', severity: 'HIGH',
    title: 'Phone number is not clickable (555)',
    description: 'Long form.', pageUrl: HOME,
    evidence: { page: 'x', details: {} },
  });
  const site = { id: 1, url: HOME, businessName: null, contactName: null, contactEmail: null, niche: 'general', city: null };
  const scan = { id: 1, opportunityScore: 45, status: 'completed' };
  const fresh = buildLlmBrief(site, scan, [mk(1), mk(2), mk(3)], null, 'Emon', { pagesCrawled: 5, scanDate: new Date().toISOString() });
  const occurrences = fresh.split('Phone number is not clickable (555)').length - 1;
  check('T12 brief dedupes repeats', occurrences === 1 && fresh.includes('(found on 3 pages)'), `occurrences=${occurrences}`);
  check('T12 brief shows pages crawled', fresh.includes('Pages crawled: 5'));
  check('T12 fresh scan has no stale warning', !fresh.includes('WARNING'));
  const old = buildLlmBrief(site, scan, [mk(1)], null, 'Emon', { scanDate: new Date(Date.now() - 20 * 86400000).toISOString() });
  check('T12 stale scan warns', old.includes('20 days old'));
}

// T19: brief opens with the 2-line EMC system prompt.
{
  const brief = buildLlmBrief(
    { id: 1, url: HOME, businessName: null, contactName: null, contactEmail: null, niche: 'general', city: null },
    { id: 1, opportunityScore: 10, status: 'completed' },
    [], null,
  );
  const lines = brief.split('\n');
  check('T19 brief starts with EMC system prompt', lines[0] === 'SYSTEM: I will upload the EMC evidence files first and then start the chat. Follow those files together with this brief.' && lines[1] === 'SYSTEM: Write the cold emails ONLY from the facts in this brief plus the uploaded files — never invent facts, numbers, or issues.');
}

// T13: suite FAILs never become findings — pipeline gate drops non-catalog.
{
  const mk = (checkId: string, status: 'FAIL' | 'WARNING', risk: 'Critical' | 'High' | 'Medium' | 'Low' | 'Info') => ({
    checkId, title: `${checkId} title`, status, observed: 'obs', expected: 'exp',
    risk, recommendation: 'rec', evidence: {}, owasp: 'A02', automated: 'AUTOMATED' as const,
  });
  const converted = securityFindings([
    mk('tls-cert', 'FAIL', 'Critical'),
    mk('https', 'FAIL', 'High'),
    mk('form-transport', 'FAIL', 'High'),
    mk('spf', 'WARNING', 'Low'),
    mk('mixed-content', 'FAIL', 'Medium'),
    mk('coop', 'FAIL', 'Low'),
  ], HOME);
  const survivors = converted.filter((f) => leakFor(f.module, f.category) !== null);
  check('T13 suite findings gated to catalog (none survive)', survivors.length === 0, survivors.map((f) => `${f.module}/${f.category}`).join(', '));
  check('T13 raw suite still converts (gate is downstream)', converted.length > 0);
}

// T14: legacy non-catalog rows never score and never reach the brief.
{
  const legacy = {
    module: 'security', category: 'tls-cert', severity: 'EMERGENCY' as const,
    title: 'TLS certificate valid', description: 'legacy row',
  };
  const enriched = enrichFindings([legacy], { homeUrl: HOME, nicheId: 'general' });
  check('T14 legacy row scores zero', scoreEnriched(enriched).score === 0);
  const brief = buildLlmBrief(
    { id: 1, url: HOME, businessName: null, contactName: null, contactEmail: null, niche: 'general', city: null },
    { id: 1, opportunityScore: 90, status: 'completed' },
    [{ ...legacy, id: 9, scanId: 1, websiteId: 1, createdAt: new Date().toISOString() }],
    null,
  );
  check('T14 brief excludes legacy row', !brief.includes('TLS certificate valid'));
}

// T15-T17: story presentation layer.
{
  let rid = 100;
  const row = (module: string, category: string, severity: 'EMERGENCY' | 'HIGH', title: string) => ({
    id: rid++, scanId: 1, websiteId: 1, createdAt: new Date().toISOString(),
    module, category, severity, title, description: 'd',
  });
  const site = { id: 1, url: HOME, businessName: null, contactName: null, contactEmail: null, niche: 'general', city: null };
  const scan = { id: 1, opportunityScore: 80, status: 'completed' };

  // T15: M3 + M4 merge into a single L1 story block.
  const l1 = buildLlmBrief(site, scan, [
    row('phone', 'call-missing', 'HIGH', 'No callable phone number found anywhere on the site'),
    row('phone', 'call', 'HIGH', 'Phone number is not clickable (555)'),
  ], null);
  const l1blocks = l1.split('[STORY L1]').length - 1;
  check('T15 M3+M4 merge into one L1 block', l1blocks === 1, `blocks=${l1blocks}`);
  check('T15 L1 keeps both sub-evidence lines', l1.includes('No callable phone number') && l1.includes('not clickable'));

  // T16: M7 live detectors merge into a single L3 story block
  // (M8 retired v1.4.0 — dead-contact rows no longer resolve a story).
  const l3 = buildLlmBrief(site, scan, [
    row('cta', 'conversion-cta', 'EMERGENCY', 'CTA points to a broken destination ("Get Quote")'),
    row('links', 'conversion-link', 'HIGH', 'Quote link returns HTTP 404'),
  ], null);
  const l3blocks = l3.split('[STORY L3]').length - 1;
  check('T16 M7 detectors merge into one L3 block', l3blocks === 1, `blocks=${l3blocks}`);
  const retired = buildLlmBrief(site, scan, [
    row('mobile-ui', 'dead-contact', 'HIGH', 'Contact page has no way to contact you'),
  ], null);
  check('T16 retired M8 reaches no story', !retired.includes('[STORY'));

  // T17: M1 dead-site scan forbids outreach.
  const m1 = buildLlmBrief(site, scan, [
    row('availability', 'reachability', 'EMERGENCY', 'Website unavailable (HTTP 500)'),
  ], null);
  check('T17 dead-site brief bans outreach', m1.includes('DO-NOT-EMAIL'));
}

// T18: every leak except M1 (filter) and M2 (standalone safety) has a story.
{
  const storied = new Set(CLIENT_STORIES.flatMap((s) => s.leaks));
  const uncovered = MONEY_LEAKS.map((l) => l.id).filter((id) => id !== 'M1' && id !== 'M2' && !storied.has(id));
  check('T18 all leaks except M1/M2 have stories', uncovered.length === 0, uncovered.join(','));
  const pairs = MONEY_LEAKS.flatMap((l) => l.match.map((m) => storyFor(m.module, m.category) !== null || l.id === 'M1' || l.id === 'M2'));
  check('T18 every catalog pair resolves a story (or M1/M2)', pairs.every(Boolean));
}

// T20-T28: qualification gate (PURSUE vs SKIP) + silent leaks + anchor rank.
{
  const techOf = (items: { technology: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW' }[], primaryPlatform: string) =>
    ({ items, primaryPlatform } as unknown as import('./src/scanner/technology').TechReport);
  const qf = (module: string, category: string, severity: 'EMERGENCY' | 'HIGH' = 'HIGH'): FindingInput => ({
    module, category, severity, title: `${module}/${category}`, description: 'd',
  });
  const link = (href: string): DiscoveredLink => ({
    sourcePage: HOME, href, absoluteUrl: `https://example-smb.test${href}`, text: href, kind: 'internal', importance: 'normal',
  });

  // T20: Shopify stack → SKIP, even with a real phone leak present.
  const q20 = qualifySite(
    techOf([{ technology: 'Shopify', confidence: 'HIGH' }], 'Shopify'),
    artifacts({ pages: [page(HOME, true)] }),
    [qf('phone', 'call')],
  );
  check('T20 excluded stack SKIP', q20.status === 'SKIP' && q20.rule === 'excluded-stack', JSON.stringify(q20));

  // T21: cart + checkout links → SKIP (e-commerce), lone cart link does not.
  const cartOnly = qualifySite(
    techOf([], 'WordPress'), artifacts({ pages: [page(HOME, true)], links: [link('/cart')] }), [qf('phone', 'call')],
  );
  check('T21 lone cart link does not SKIP', cartOnly.status === 'PURSUE', JSON.stringify(cartOnly));
  const q21 = qualifySite(
    techOf([], 'WordPress'),
    artifacts({ pages: [page(HOME, true)], links: [link('/cart'), link('/checkout')] }),
    [qf('phone', 'call')],
  );
  check('T21 cart+checkout SKIP ecommerce', q21.status === 'SKIP' && q21.rule === 'ecommerce', JSON.stringify(q21));

  // T22: 50+ location pages → SKIP (enterprise, strong signal only).
  const locLinks = Array.from({ length: 55 }, (_, i) => link(`/locations/city-${i}`));
  const q22 = qualifySite(
    techOf([], 'Custom / unidentified'),
    artifacts({ pages: [page(HOME, true)], links: locLinks }),
    [qf('phone', 'call')],
  );
  check('T22 55 location pages SKIP enterprise', q22.status === 'SKIP' && q22.rule === 'enterprise', JSON.stringify(q22));
  const fewLocs = qualifySite(
    techOf([], 'Custom / unidentified'),
    artifacts({ pages: [page(HOME, true)], links: [link('/locations'), link('/locations/austin')] }),
    [qf('phone', 'call')],
  );
  check('T22 small locations page does not SKIP', fewLocs.status === 'PURSUE', JSON.stringify(fewLocs));

  // T23: fast clean WordPress service site, no leaks → SKIP clean-site.
  const q23 = qualifySite(
    techOf([], 'WordPress'),
    artifacts({ pages: [page(HOME, true)], links: [telLink()], phones: [goodPhone()], forms: [goodForm()] }),
    [],
  );
  check('T23 clean fast site SKIP clean-site', q23.status === 'SKIP' && q23.rule === 'clean-site', JSON.stringify(q23));

  // T24: WordPress + real phone leak → PURSUE.
  const q24 = qualifySite(
    techOf([], 'WordPress'),
    artifacts({ pages: [page(HOME, true)] }),
    [qf('phone', 'call')],
  );
  check('T24 matrix leak PURSUE', q24.status === 'PURSUE', JSON.stringify(q24));

  // T25: silent leaks (M11-M14) never score.
  const m11 = { module: 'mobile-ui', category: 'layout', severity: 'HIGH', priorityScore: 30, title: 'Overflow X' };
  const m4 = { module: 'phone', category: 'call', severity: 'HIGH', priorityScore: 25, title: 'Not tappable' };
  const s25 = scoreCapped([m11, m4]);
  check('T25 M11 scores nothing', s25.score === 25 && s25.parts.length === 1, JSON.stringify(s25));
  check('T25 isSilentLeak flags M11/M12/M14 + M13 retired', isSilentLeak('mobile-ui', 'layout') && isSilentLeak('mobile-ui', 'tap-targets') && isSilentLeak('security', 'email-auth') && !isSilentLeak('phone', 'call') && leakFor('forms', 'unlabeled') === null && leakFor('forms', 'friction') === null && leakFor('forms', 'structure') === null);

  // T26: anchor hierarchy — L1 (rank 1) leads even with lower priority.
  const site = { id: 1, url: HOME, businessName: null, contactName: null, contactEmail: null, niche: 'general', city: null };
  const scan = { id: 1, opportunityScore: 60, status: 'completed', qualification: null, skipReason: null };
  let arid = 200;
  const arow = (module: string, category: string, title: string, priorityScore: number) => ({
    id: arid++, scanId: 1, websiteId: 1, createdAt: new Date().toISOString(),
    module, category, severity: 'HIGH' as const, title, description: 'd', priorityScore,
  });
  const a26 = buildLlmBrief(site, scan, [
    arow('mobile-ui', 'above-fold', 'No action above the fold', 40),
    arow('phone', 'call', 'Phone not tappable', 20),
  ], null);
  check('T26 anchor rank beats priority', a26.indexOf('[STORY L1]') !== -1 && a26.indexOf('[STORY L1]') < a26.indexOf('[STORY L5]'));
  check('T26 rank map sane', anchorRankFor('phone', 'call') === 1 && anchorRankFor('performance', 'loading') === 2 && anchorRankFor('mobile-ui', 'layout') === null);

  // T27: silent findings never reach the brief.
  const a27 = buildLlmBrief(site, scan, [
    arow('mobile-ui', 'layout', 'Overflow secret phrase', 50),
    arow('phone', 'call', 'Phone not tappable', 20),
  ], null);
  check('T27 brief excludes silent leaks', !a27.includes('Overflow secret phrase') && a27.includes('Phone not tappable'));

  // T28: SKIP scan brief bans outreach (no light-touch fallback).
  const a28 = buildLlmBrief(site, { ...scan, opportunityScore: 0, qualification: 'SKIP', skipReason: 'Built on Shopify (out of scope)' }, [], null);
  check('T28 SKIP brief bans outreach', a28.includes('DO-NOT-EMAIL') && a28.includes('qualified as SKIP') && !a28.includes('light-touch check-in'));
}

// T29 (v1.4.0): B-class content reads emit nothing — 9-field unlabeled
// no-submit form + JSON-LD-only phone produce zero form/phone findings.
{
  const badForm: FormInfo = {
    page: HOME, index: 0, action: '', method: 'POST',
    fieldCount: 9, hasEmailField: true, hasPhoneField: false, hasMessageField: true,
    hasSubmit: false, jsSubmit: false, hasCaptcha: false, unlabeledFields: 9,
    fields: Array.from({ length: 9 }, (_, i) => ({ name: `f${i}`, type: 'text', required: false, labeled: false })),
  };
  const out = buildFindings(
    artifacts({
      pages: [page(HOME, true)],
      phones: [{ raw: '(555) 999-0000', normalized: '+15559990000', e164: '+15559990000', isValid: true, page: HOME, hasTelLink: false, telMalformed: false, codeOnly: true }],
      forms: [badForm],
    }),
    HOME, 'general',
  );
  const banned = out.filter((f) => f.module === 'forms' || f.category === 'dead-contact' || f.category === 'unlabeled' || f.category === 'friction' || f.category === 'structure');
  check('T29 content reads emit nothing', banned.length === 0, banned.map((f) => `${f.module}/${f.category}`).join(', '));
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll money-leak checks passed.');
