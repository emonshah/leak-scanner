import * as cheerio from 'cheerio';
import type { CrawledPage, FormInfo } from './types';

/**
 * MODULE 6 — contact/quote form inspection. Static analysis only — NEVER
 * submits anything. Distinguishes "structure issue" from "could not verify".
 *
 * Visible-input counting (no hidden-field inflation): hidden/system inputs
 * NEVER count — type=hidden, honeypots, CSRF/nonce tokens, recaptcha
 * wrappers, display:none / hidden nodes. Only visible user-interactive
 * fields (text-ish inputs, textarea, select) count toward friction.
 */
const HONEYPOT_RE = /honey|honeypot|trap|spam[-_]?check|bot[-_]?field/i;
const TOKEN_RE = /^(csrf|_token|authenticity_token|nonce|_wpnonce|recaptcha|g-recaptcha-response|h-captcha-response)$/i;

/** System/hidden inputs never count as user fields (plain values only — cheerio-agnostic). */
function isSystemFieldName(name: string, styleAttr: string): boolean {
  if (HONEYPOT_RE.test(name) || TOKEN_RE.test(name)) return true;
  const style = styleAttr.toLowerCase();
  return /display\s*:\s*none/.test(style) || /visibility\s*:\s*hidden/.test(style);
}
export function analyzeForms(pages: CrawledPage[]): FormInfo[] {
  const out: FormInfo[] = [];
  // Focus on homepage + contact-ish pages to bound work.
  const targets = pages.filter(
    (p) =>
      p.isHomepage ||
      /contact|quote|book|estimate|appointment|get-started|signup|sign-up|schedule|consult|demo|message|calendar|trial|callback/i.test(p.url),
  );
  for (const page of targets) {
    if (!page.html) continue;
    const $ = cheerio.load(page.html);
    $('form').each((idx, form) => {
      const $f = $(form);
      const action = $f.attr('action')?.trim() || null;
      const method = ($f.attr('method') ?? 'get').toLowerCase();
      const fields: FormInfo['fields'] = [];
      $f.find('input,textarea,select').each((_i, el) => {
        const $el = $(el);
        const type = ($el.attr('type') ?? (el.tagName === 'textarea' ? 'textarea' : 'text')).toLowerCase();
        // Toggles are not typing friction: GDPR-consent / TOS checkboxes
        // and radios never intimidate anyone (same exclusion as Tier-2).
        if (['submit', 'button', 'hidden', 'reset', 'image', 'checkbox', 'radio'].includes(type)) return;
        // tabindex=-1 removes the field from keyboard flow: honeypots and
        // trap fields (e.g. *_verification_code) are invisible to visitors.
        if (($el.attr('tabindex') ?? '').trim() === '-1') return;
        // Visible-only count: hidden nodes, honeypots, CSRF tokens and
        // recaptcha-wrapped inputs are system fields, never user friction.
        const nm = ($el.attr('name') ?? $el.attr('id') ?? '').trim();
        if (isSystemFieldName(nm, $el.attr('style') ?? '')) return;
        if ($el.is('[hidden]')) return;
        if ($el.closest('[class*="captcha" i],[id*="captcha" i],[class*="cf-turnstile" i]').length > 0) return;
        const name = $el.attr('name') ?? $el.attr('id') ?? '';
        const id = $el.attr('id') ?? '';
        const labeled =
          (id !== '' && $f.find(`label[for="${id}"]`).length > 0) ||
          $el.closest('label').length > 0 ||
          ($el.attr('aria-label') ?? '').trim() !== '' ||
          ($el.attr('placeholder') ?? '').trim() !== '';
        fields.push({
          name: name.slice(0, 80),
          type: type.slice(0, 30),
          required: $el.is('[required],[aria-required="true"]'),
          labeled,
        });
      });
      const hasSubmit =
        $f.find('button[type="submit"],input[type="submit"],button:not([type])').length > 0;
      const html = ($f.html() ?? '').toLowerCase();
      const hasCaptcha =
        /g-recaptcha|h-captcha|turnstile|captcha/i.test(html) ||
        $f.find('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="turnstile"],[class*="captcha"]').length > 0;
      const names = fields.map((f) => f.name.toLowerCase()).join(' ');
      out.push({
        page: page.url,
        index: idx,
        action,
        method,
        fieldCount: fields.length,
        jsSubmit: /^(javascript:)/i.test(action ?? ''),
        hasEmailField: fields.some((f) => f.type === 'email' || f.name.includes('email') || f.name.includes('e-mail')),
        hasPhoneField: fields.some((f) => f.type === 'tel' || f.name.includes('phone') || f.name.includes('tel')),
        hasMessageField: fields.some(
          (f) => f.type === 'textarea' || f.name.includes('message') || f.name.includes('comment'),
        ),
        hasSubmit,
        hasCaptcha,
        unlabeledFields: fields.filter((f) => !f.labeled).length,
        fields,
      });
    });
  }
  // Tier 2 — div/section pseudo-forms (React/Webflow/WordPress builders).
  // Requires contact intent: 2+ text-ish inputs AND a submit control AND a
  // quote/booking/contact keyword nearby. Newsletter-only clusters excluded.
  const INTENT_RE = /quote|book|contact|estimate|appointment|schedule|message|send|submit|reserve|callback/i;
  for (const page of targets) {
    if (!page.html) continue;
    if (out.some((f) => f.page === page.url)) continue; // native form already seen
    const $ = cheerio.load(page.html);
    $('div,section').each((idx, el) => {
      if (out.filter((f) => f.page === page.url).length >= 3) return false;
      const $c = $(el);
      if ($c.find('div,section').length > 0) return; // innermost containers only
      if ($c.find('form').length > 0) return;
      const inputs = $c.find('input[type="text"],input[type="email"],input[type="tel"],input:not([type]),textarea');
      if (inputs.length < 2) return;
      const btn = $c.find(
        'button,input[type="submit"],[role="button"],a[class*="btn" i],a[class*="button" i]',
      ).filter((_i, b) => INTENT_RE.test(($(b).text() ?? '') + ' ' + ($(b).attr('aria-label') ?? ''))).length > 0
        || $c.find('button,input[type="submit"],[role="button"]').length > 0;
      if (!btn) return;
      const cls = `${$c.attr('class') ?? ''} ${$c.attr('id') ?? ''} ${$c.text().slice(0, 300) ?? ''}`;
      if (!INTENT_RE.test(cls)) return;
      const fields: FormInfo['fields'] = [];
      inputs.each((_i, input) => {
        const $el = $(input);
        const type = ($el.attr('type') ?? (input.tagName === 'textarea' ? 'textarea' : 'text')).toLowerCase();
        if (['submit', 'button', 'hidden', 'reset', 'image', 'checkbox', 'radio'].includes(type)) return;
        if (($el.attr('tabindex') ?? '').trim() === '-1') return;
        const nm = ($el.attr('name') ?? $el.attr('id') ?? '').trim();
        if (isSystemFieldName(nm, $el.attr('style') ?? '')) return;
        if ($el.is('[hidden]')) return;
        if ($el.closest('[class*="captcha" i],[id*="captcha" i],[class*="cf-turnstile" i]').length > 0) return;
        const name = $el.attr('name') ?? $el.attr('id') ?? '';
        fields.push({ name: name.slice(0, 80), type: type.slice(0, 30), required: $el.is('[required],[aria-required="true"]'), labeled: true });
      });
      if (fields.length < 2) return;
      out.push({
        page: page.url,
        index: 100 + idx,
        action: null,
        method: 'post',
        fieldCount: fields.length,
        hasEmailField: fields.some((f) => f.type === 'email' || f.name.includes('email')),
        hasPhoneField: fields.some((f) => f.type === 'tel' || f.name.includes('phone')),
        hasMessageField: fields.some((f) => f.type === 'textarea' || f.name.includes('message')),
        hasSubmit: true,
        jsSubmit: true,
        hasCaptcha: /g-recaptcha|h-captcha|turnstile|captcha/i.test($c.html()?.toLowerCase() ?? ''),
        unlabeledFields: 0,
        fields,
      });
      return undefined;
    });
  }
  return out.slice(0, 10);
}
