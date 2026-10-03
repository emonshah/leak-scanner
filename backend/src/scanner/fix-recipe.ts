import type { FindingInput } from './types';

/**
 * Instant developer fix recipe (Master Directive §3). Pure + deterministic.
 * For every persisted EMERGENCY/HIGH finding, one 1-2 line technical fix the
 * outreach engine pulls verbatim into Step-2 diagnostic payoff emails.
 * Attached as evidence.details.fix_recipe in pipeline finish (E/H only) —
 * no DB migration, rides inside the existing evidence JSON.
 */
export function fixRecipeFor(f: Pick<FindingInput, 'module' | 'category' | 'title' | 'measuredValue' | 'evidence'>): string {
  const det = ((f.evidence as { details?: Record<string, string> } | undefined)?.details ?? {}) as Record<string, string>;
  const mod = f.module;
  const cat = f.category;

  // Massive hero LCP asset (forensic join names the file + MB).
  if (mod === 'performance' && det['lcp_url']) {
    const file = det['lcp_url'].split('/').pop()?.split('?')[0] ?? 'hero asset';
    const mbRaw = det['file_size_mb'] ?? det['lcp_bytes_mb'];
    const mb = mbRaw ? ` (${mbRaw}MB)` : '';
    return `Compress ${file}${mb} to WebP (<150KB) and add fetchpriority='high' to the hero <img> tag.`;
  }
  if (mod === 'performance' || mod === 'resources') {
    return `Compress the largest mobile asset to WebP (<150KB), defer non-critical JS, and preload the hero image with fetchpriority='high'.`;
  }
  // No callable phone anywhere on the site (M3).
  if (cat === 'call-missing') {
    return `Add the business number to the header wrapped in <a href='tel:+E.164'> so mobile visitors tap-to-call.`;
  }
  // Plain-text / malformed phone header.
  if (mod === 'phone') {
    const e164 = det['e164'] ?? det['phone'] ?? '';
    const num = e164.replace(/[^\d+]/g, '') || '[number]';
    return `Wrap the header phone string in <a href='tel:${num}'> so mobile visitors tap-to-call.`;
  }
  // Covered / hidden / sticky CTA.
  if (cat === 'sticky-blocked' || cat === 'cta-visibility') {
    return `Raise the call/quote button above overlays (z-index + stacking context) and keep one tappable tel: CTA visible at 390px without scrolling.`;
  }
  if (mod === 'cta' || cat === 'conversion-cta' || cat === 'conversion-link' || cat === 'conversion-path') {
    const dest = det['destination'] ? ` (${det['destination'].slice(0, 60)})` : '';
    return `Point the CTA at a live quote/contact destination${dest} returning HTTP 200 with a working form.`;
  }
  // Dead contact path: contact page with no form/phone/email (M8).
  if (cat === 'dead-contact') {
    return `Put a short quote form (name + phone + message) or a tappable tel: number on the contact page.`;
  }
  // Form layout shift / friction / keyboards.
  if (mod === 'forms' || cat === 'friction' || cat === 'input-keyboard' || cat === 'structure') {
    return `Add explicit width/height or CSS aspect-ratio to the form wrapper, cut required fields to ≤7, and set input types (tel/email) for mobile keyboards.`;
  }
  // Booking embeds.
  if (cat === 'booking-embed' || cat === 'conversion-path' || mod === 'booking') {
    return `Ensure the booking widget loads over HTTPS with a visible fallback link in case the embed is blocked.`;
  }
  // Mobile layout: above-fold / overflow / tap targets.
  if (cat === 'above-fold') {
    return `Move one primary call/quote button into the first 390px viewport so it shows without scrolling.`;
  }
  if (cat === 'layout') {
    return `Constrain full-width sections to 100vw (overflow-x:hidden on wrappers) so nothing exceeds 390px.`;
  }
  if (cat === 'tap-targets') {
    return `Give tap targets ≥24px size with ≥8px gaps so thumbs hit the right button.`;
  }
  // Trust / transport.
  if (/tls|ssl|https|transport/i.test(`${f.title} ${cat}`)) {
    return `Force HTTPS with a valid certificate and 301-redirect all HTTP URLs to HTTPS.`;
  }
  if (/spf|dmarc|email-auth/i.test(`${f.title} ${cat}`)) {
    return `Publish SPF (-all) and a DMARC (p=quarantine, rua=mailto:reports@yourdomain) TXT record on the domain.`;
  }
  if (/mixed/i.test(`${f.title} ${cat}`)) {
    return `Serve every image/script over HTTPS so browsers stop showing 'Not Secure'.`;
  }
  if (/framing|clickjack/i.test(`${f.title} ${cat}`)) {
    return `Send X-Frame-Options: SAMEORIGIN (or CSP frame-ancestors 'self') on all pages.`;
  }
  if (/user-enumeration|wp-json|xmlrpc|exposure|vuln/i.test(`${f.title} ${cat} ${mod}`)) {
    return `Restrict the exposed endpoint (wp-json users / xmlrpc.php) to authenticated roles and update the core/plugin.`;
  }
  if (/keyboard/i.test(cat)) {
    return `Set input type='tel' for phone fields and type='email' for email fields.`;
  }
  // Fallback: never empty — outreach always has a payoff line.
  return `Fix the flagged element on the reported page and re-verify on a real phone at 390px width.`;
}
