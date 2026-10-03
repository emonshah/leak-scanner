/**
 * MONEY LEAK CATALOG — the only problems the scanner is allowed to report.
 *
 * Agency close test (every leak must pass all three, or it is dropped):
 *  1. A non-technical owner understands it in 10 seconds.
 *  2. It feels like lost calls/quotes (money pain), not abstract risk.
 *  3. The fix has a clear, quotable price.
 *
 * Dropped on purpose (never persisted, never scored, never emailed):
 *  clickjacking headers, plugin CVE/version disclosures,
 *  xmlrpc, author enumeration, directory listing, input keyboards,
 *  mixed content, generic JS errors.
 *  (The passive security_checks tab still shows raw header data for
 *  client meetings — it just never becomes a finding.)
 *
 * Evidence bar: every leak fires ONLY on corroborated measurement
 * (DOM + browser pass, or probe + headers). Uncorroborated claims are
 * demoted by the intelligence layer, never shouted.
 */
export type MoneyLeakId =
  | 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6'
  | 'M7' | 'M8' | 'M9' | 'M10' | 'M11' | 'M12' | 'M13' | 'M14';

export interface MoneyLeak {
  id: MoneyLeakId;
  name: string;
  /** module/category pairs that count as this leak. */
  match: { module: string; category: string }[];
  /** Owner-language pain (one line, for briefs and outreach). */
  ownerPain: string;
  /** Cold-email subject hook (under 50 chars). */
  emailSubject: string;
  /** Why a small business pays to fix this. */
  whyTheyPay: string;
  /** Evidence bar (what must be true before we claim it). */
  evidenceBar: string;
}

export const MONEY_LEAKS: MoneyLeak[] = [
  {
    id: 'M1',
    name: 'Site down or timing out',
    match: [{ module: 'availability', category: 'reachability' }],
    ownerPain: 'Customers reach a dead page — ad spend and inbound calls die here.',
    emailSubject: 'Your website was down when I checked',
    whyTheyPay: 'Total outage: zero calls, zero quotes until fixed. Most urgent invoice they will ever sign.',
    evidenceBar: 'Availability probe failed (timeout/unreachable/5xx). No deeper claim allowed on a dead site.',
  },
  {
    id: 'M2',
    name: 'Browser trust warning (no HTTPS / dying certificate)',
    match: [
      { module: 'security', category: 'transport' },
      { module: 'security', category: 'tls' },
    ],
    ownerPain: 'Visitors see a "Not Secure" wall and bounce before your number ever appears.',
    emailSubject: 'Your site shows "Not Secure" to visitors',
    whyTheyPay: 'Chrome/Firefox warn visitors away with "Not Secure"; forms and calls collapse. Fix is a half-hour job.',
    evidenceBar: 'Final URL is plain HTTP, or TLS probe shows expired/expiring certificate.',
  },
  {
    id: 'M3',
    name: 'No callable phone anywhere on the site',
    match: [{ module: 'phone', category: 'call-missing' }],
    ownerPain: 'There is no number a mobile visitor can tap — the call path simply does not exist.',
    emailSubject: 'Mobile visitors cannot call you at all',
    whyTheyPay: 'For call-driven niches this is the whole business leaking. One tel: link recovers it.',
    evidenceBar: 'Zero valid phones in crawled text AND zero tel:/dial links anywhere AND browser mobile pass loaded clean.',
  },
  {
    id: 'M4',
    name: 'Phone exists but is not tappable (or dialer fails)',
    match: [{ module: 'phone', category: 'call' }],
    ownerPain: 'The number is visible but tapping it does nothing — or the dialer errors out.',
    emailSubject: 'Your phone number is not tappable on mobile',
    whyTheyPay: 'Customers must memorize or copy the number; most just call the next contractor instead.',
    evidenceBar: 'Validated number with no working tel: wrapper (incl. parent/onclick/CDP checks), or malformed tel: URI. Browser dial-proof demotes, never deletes.',
  },
  {
    id: 'M5',
    name: 'Mobile call/quote button blocked or hidden',
    match: [
      { module: 'mobile-ui', category: 'sticky-blocked' },
      { module: 'mobile-ui', category: 'cta-visibility' },
    ],
    ownerPain: 'The button is there but an overlay covers it, or it only hides inside the menu.',
    emailSubject: 'Your mobile call button is covered up',
    whyTheyPay: 'Visible embarrassment they can check on their own phone in 5 seconds — instant belief, instant close.',
    evidenceBar: 'Real 390px viewport verdict COVERED/HIDDEN/IN_MENU with hit-test proof, overlays suppressed first, detector-blind guard on.',
  },
  {
    id: 'M6',
    name: 'No quote/call action above the fold on mobile',
    match: [{ module: 'mobile-ui', category: 'above-fold' }],
    ownerPain: 'Visitors must scroll before seeing any way to contact you — most bounce in seconds.',
    emailSubject: 'No call button on your mobile first screen',
    whyTheyPay: 'The 3-second bounce is intuitive to any owner who has watched their own analytics.',
    evidenceBar: 'Above-fold probe found actions on page but none visible in first 390px viewport; blind-detector guard downgrades to manual-check.',
  },
  {
    id: 'M7',
    name: 'Quote/call/booking destination is a dead end',
    match: [
      { module: 'links', category: 'conversion-link' },
      { module: 'cta', category: 'conversion-cta' },
      { module: 'cta', category: 'conversion-path' },
      { module: 'booking', category: 'booking-embed' },
    ],
    ownerPain: 'The button works, but where it leads is broken, empty, or shows no form.',
    emailSubject: 'Your "Get Quote" button leads nowhere',
    whyTheyPay: 'Highest-intent visitors hit a wall. Fix = point at a live page with a working form.',
    evidenceBar: 'DOM/crawl-extracted links returning 404/5xx, or fetched destination with no form, or booking embed with network/console failure proof. Never claimed on unfetched URLs.',
  },
  {
    id: 'M8',
    name: 'Contact form goes nowhere',
    match: [
      { module: 'forms', category: 'structure' },
      { module: 'mobile-ui', category: 'dead-contact' },
    ],
    ownerPain: 'Customers fill the form and their request silently vanishes — or cannot be sent at all.',
    emailSubject: 'Your contact form goes nowhere',
    whyTheyPay: 'Every lost submission is a job for a competitor. Endpoint fix is small, value is obvious.',
    evidenceBar: 'No submit control, or no action endpoint (JS-handled forms get a verify-note, never a loud claim). Contact page with zero form/phone/email paths.',
  },
  {
    id: 'M9',
    name: 'Quote form scares people off (7+ fields)',
    match: [{ module: 'forms', category: 'friction' }],
    ownerPain: 'Seven or more fields on a phone screen — most visitors quit halfway (industry: 3–4 fields optimal).',
    emailSubject: 'Your quote form asks too much',
    whyTheyPay: 'Cutting fields is the cheapest conversion lift in existence; benchmarks back every word.',
    evidenceBar: '7+ visible interactive fields counted (honeypots/CSRF/captcha excluded).',
  },
  {
    id: 'M10',
    name: 'Mobile slowness burns ad budget',
    match: [{ module: 'performance', category: 'loading' }],
    ownerPain: 'Paid visitors stare at a white screen and bounce before your offer even paints.',
    emailSubject: 'Your ads pay for visitors who bounce',
    whyTheyPay: 'Niche-aware thresholds; forensic LCP asset join names the exact file and megabytes.',
    evidenceBar: 'Measured TTFB/LCP over niche thresholds on mobile emulation (desktop scored at 1.5x gates, HIGH max); 2x-over-gate escalates to EMERGENCY; massive-asset claim gated on duration AND payload.',
  },
  {
    id: 'M11',
    name: 'Mobile layout broken (horizontal overflow)',
    match: [{ module: 'mobile-ui', category: 'layout' }],
    ownerPain: 'The page wobbles sideways and cuts off buttons — looks broken on the owner’s own phone.',
    emailSubject: 'Your mobile page slides sideways',
    whyTheyPay: 'Self-verifiable in seconds; unprofessional look kills trust before the call.',
    evidenceBar: 'scrollWidth overruns 390px viewport beyond tolerance with the offending element named.',
  },
  {
    id: 'M12',
    name: 'Call/quote buttons collide on mobile (mis-taps)',
    match: [{ module: 'mobile-ui', category: 'tap-targets' }],
    ownerPain: 'Visitors aiming for Call tap the wrong button — hot callers silently reroute or give up.',
    emailSubject: 'Tapping Call hits the wrong button',
    whyTheyPay: 'Self-verifiable on their own phone; spacing fix is minutes of CSS for recovered calls.',
    evidenceBar: 'Two VISIBLE tap targets intersect or sit <8px apart at 390px width, axe target-size corroboration counted.',
  },
  {
    id: 'M13',
    name: 'Quote form fields have no labels',
    match: [{ module: 'forms', category: 'unlabeled' }],
    ownerPain: 'Visitors stare at blank boxes unsure what to type — and abandon the form.',
    emailSubject: 'Your form fields confuse visitors',
    whyTheyPay: 'Labels are the cheapest form fix in existence; every confused visitor is a lost quote.',
    evidenceBar: '3+ visible fields with no <label>, wrapping label, aria-label, or placeholder on a quote/contact form.',
  },
  {
    id: 'M14',
    name: 'Quote emails land in spam (no SPF/DMARC)',
    match: [{ module: 'security', category: 'email-auth' }],
    ownerPain: 'Your quote replies land in spam — customers think you never answered and hire the next contractor.',
    emailSubject: 'Your emails may land in spam',
    whyTheyPay: 'Two DNS records, ten minutes of work, and every future quote reply actually arrives. Cheapest trust sale in the catalog.',
    evidenceBar: 'Missing v=spf1 TXT or missing/unenforced (p=none) DMARC on the bare domain; DNS failure = INCONCLUSIVE, never a claim.',
  },
];

const hookCache = new Map<string, MoneyLeak>();
for (const leak of MONEY_LEAKS) {
  for (const m of leak.match) hookCache.set(`${m.module}::${m.category}`, leak);
}

/** Map a persisted finding to its money leak (null = must never persist). */
export function leakFor(module: string, category: string): MoneyLeak | null {
  return hookCache.get(`${module}::${category}`) ?? null;
}

/** Cold-email angle for a finding: subject hook + one-line owner pain. */
export function moneyHookFor(
  module: string,
  category: string,
): { leakId: MoneyLeakId; subject: string; pain: string } | null {
  const leak = leakFor(module, category);
  if (!leak) return null;
  return { leakId: leak.id, subject: leak.emailSubject, pain: leak.ownerPain };
}

// ─── Presentation layer: 9 client stories (L1–L9) ─────────────────────
// Detection stays granular (14 detectors — severities and evidence bars
// differ per leak), but a client reads ONE story per broken money path:
// L1 = the whole phone path (M3+M4), L3 = the whole lead-capture path
// (M7+M8 with sub-reasons), L6 = the whole form-friction path (M9+M13).
// M1 is not a story — it is a DO-NOT-EMAIL filter (parked lead).
// M2 stands alone as the trust safety net.

export type StoryId = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9';

export interface ClientStory {
  id: StoryId;
  title: string;
  subject: string;
  leaks: MoneyLeakId[];
  doNotEmail?: false;
}

export const CLIENT_STORIES: ClientStory[] = [
  { id: 'L1', title: 'Broken Phone Dialer', subject: 'Your mobile visitors cannot call you', leaks: ['M3', 'M4'] },
  { id: 'L2', title: 'Ad Budget Bleed', subject: 'Your ads pay for visitors who bounce', leaks: ['M10'] },
  { id: 'L3', title: 'Broken Lead Capture Route', subject: 'Your "Get Quote" button leads nowhere', leaks: ['M7', 'M8'] },
  { id: 'L4', title: 'Primary CTA Obscured/Blocked', subject: 'Your mobile call button is covered up', leaks: ['M5'] },
  { id: 'L5', title: 'No Action Above the Fold', subject: 'No call button on your mobile first screen', leaks: ['M6'] },
  { id: 'L6', title: 'High Quote Form Friction', subject: 'Your quote form asks too much', leaks: ['M9', 'M13'] },
  { id: 'L7', title: 'Mobile Viewport Overflow', subject: 'Your mobile page slides sideways', leaks: ['M11'] },
  { id: 'L8', title: 'Mis-taps on Mobile', subject: 'Tapping Call hits the wrong button', leaks: ['M12'] },
  { id: 'L9', title: 'Quote Replies Lost to Spam', subject: 'Your emails may land in spam', leaks: ['M14'] },
];

const storyByLeak = new Map<MoneyLeakId, ClientStory>();
for (const story of CLIENT_STORIES) {
  for (const id of story.leaks) storyByLeak.set(id, story);
}

/** Map a money leak to its client story (M1/M2 have none by design). */
export function storyForLeak(leakId: MoneyLeakId): ClientStory | null {
  return storyByLeak.get(leakId) ?? null;
}

/** Map a persisted finding straight to its client story (null = no story). */
export function storyFor(module: string, category: string): ClientStory | null {
  const leak = leakFor(module, category);
  if (!leak) return null;
  return storyForLeak(leak.id);
}

/** True when the finding is the M1 dead-site signal (outreach forbidden). */
export function isDeadSiteSignal(module: string, category: string): boolean {
  const leak = leakFor(module, category);
  return leak?.id === 'M1';
}
