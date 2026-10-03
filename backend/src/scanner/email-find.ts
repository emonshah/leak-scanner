/**
 * Contact-email harvester (pure, deterministic, no network).
 * Reads crawled HTML only. Used to fill websites.contact_email when the
 * operator added a URL without an email. Imported emails are NEVER
 * overwritten — the DB update is WHERE contact_email IS NULL (see scans.ts).
 */
import * as cheerio from 'cheerio';
import type { CrawledPage } from './types';

export interface HarvestedEmail {
  email: string;
  source: string;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Cloudflare-protected email: <span class="__cf_email__" data-cfemail="..."> */
function decodeCfEmail(cfemail: string): string | null {
  try {
    const bytes = cfemail.match(/../g);
    if (!bytes || bytes.length < 2) return null;
    const key = parseInt(bytes[0] ?? '00', 16);
    let out = '';
    for (let i = 1; i < bytes.length; i++) {
      out += String.fromCharCode(parseInt(bytes[i] ?? '00', 16) ^ key);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * Normalize obfuscated emails in visible text, e.g.
 * "Support[at]miamirestorationcompany.com", "info (at) domain (dot) com".
 * Returns text with obfuscations replaced by @ / . so EMAIL_RE can match.
 */
function deobfuscateText(text: string): string {
  let out = text
    // HTML entities for @ / .
    .replace(/&#64;|&#x40;|&commat;/gi, '@')
    .replace(/&#46;|&#x2e;|&period;/gi, '.')
    // Bracketed forms, only when they sit inside an address-like context so
    // normal prose ("arrive (at) noon") is left alone.
    .replace(/(?<=[a-z0-9._%+-])\s*(?:\[at\]|\(at\)|\{at\})\s*(?=[a-z0-9-])/gi, '@')
    .replace(/(?<=\w)\s*(?:\[dot\]|\(dot\)|\{dot\})\s*(?=\w)/gi, '.')
    // Bare " at " / " dot " with spaces — require a domain-like tail so
    // "meet us at the office" never becomes an email.
    .replace(/\s+at\s+(?=[a-z0-9-]+(?:\.|\s+dot\s+)[a-z]{2,}\b)/gi, '@')
    .replace(/(?<=\w)\s+dot\s+(?=\w)/gi, '.');
  // Collapse spaces left around @ / . by obfuscation, e.g.
  // "info (at) example-site.com" -> "info @ example-site.com" -> "info@example-site.com".
  out = out.replace(/\s*@\s*/g, '@');
  let prev = '';
  while (prev !== out) {
    prev = out;
    out = out.replace(/(\w)\s*\.\s*(\w)/g, '$1.$2');
  }
  return out.replace(/\.(\s*\.\s*)+/g, '.').replace(/@(\s*\.?\s*)+@/g, '@');
}

/**
 * Emails assembled by JS from split data attributes, e.g.
 * <a class="email-anchor" data-name="Support" data-domain="example.com">
 * Covers data-name/data-user/data-local + data-domain, and direct
 * data-email / data-mail / data-mailto attributes.
 */
function extractFromDataAttributes($: cheerio.CheerioAPI): string[] {
  const found: string[] = [];
  // Split local+domain pairs.
  $('[data-name][data-domain], [data-user][data-domain], [data-local][data-domain]').each((_i, el) => {
    const $el = $(el);
    const local = ($el.attr('data-name') ?? $el.attr('data-user') ?? $el.attr('data-local') ?? '').trim();
    const domain = ($el.attr('data-domain') ?? '').trim();
    if (!local || !domain) return;
    const candidate = `${local}@${domain}`;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) found.push(candidate);
  });
  // Direct email-bearing attributes.
  $('[data-email], [data-mail], [data-mailto], [data-contact-email], [data-e-mail]').each((_i, el) => {
    const $el = $(el);
    const raw =
      $el.attr('data-email') ??
      $el.attr('data-mail') ??
      $el.attr('data-mailto') ??
      $el.attr('data-contact-email') ??
      $el.attr('data-e-mail') ??
      '';
    const candidate = raw.replace(/^mailto:/i, '').trim();
    if (candidate && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) found.push(candidate);
  });
  // Cloudflare email protection.
  $('[data-cfemail]').each((_i, el) => {
    const decoded = decodeCfEmail($(el).attr('data-cfemail') ?? '');
    if (decoded) found.push(decoded);
  });
  return found;
}

/** Junk never worth saving as a client contact. */
function isJunk(email: string): boolean {
  const e = email.toLowerCase();
  if (e.length > 320) return true;
  const [, domain = ''] = e.split('@');
  if (!domain || !domain.includes('.')) return true;
  if (/^(example|test|localhost|invalid)\./.test(domain)) return true;
  if (/\.(png|jpe?g|gif|svg|webp|js|css)$/.test(e)) return true;
  const local = e.split('@')[0] ?? '';
  if (/^(noreply|no-reply|donotreply|mailer-daemon|postmaster|abuse)$/.test(local)) return true;
  // Template placeholders (john@smith.com, email@domain.com, ...).
  if (/^(john|smith|email|your|yourname|name|myemail|sample|user)$/.test(local)) return true;
  if (/^(domain|emailaddress|yourdomain|your-domain|test|sample|example)\.(com|net|org)$/.test(domain)) return true;
  if (/^(png|jpe?g|gif|svg|webp|ico|css|js)$/.test(local)) return true;
  if (/\.(png|jpe?g|gif|svg|webp|ico)$/.test(local)) return true;
  return false;
}

function cleanMailto(href: string): string | null {
  const m = /^mailto:([^?#]+)/i.exec(href.trim());
  if (!m) return null;
  const email = (m[1] ?? '').trim().replace(/%40/gi, '@');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/**
 * Harvest priority:
 * 1. mailto: in header/footer/contact containers on homepage or contact pages.
 * 2. mailto: anywhere on contact pages (/contact, /about, etc.).
 * 3. mailto: on homepage / remaining pages.
 * 3b. JS-assembled emails from data attributes (data-name+data-domain, etc.).
 * 4. Plain-text email in contact containers / footer (incl. [at]/[dot] forms).
 * 5. Plain-text email across crawled pages (most frequent non-junk wins).
 * Returns null when nothing usable is found.
 */
export function harvestContactEmail(pages: CrawledPage[]): HarvestedEmail | null {
  if (pages.length === 0) return null;
  // Prioritize homepage and contact-related pages
  const isContactPage = (u: string) => /contact|about|touch|reach|support|quote|book/i.test(u);
  const ordered = [...pages].sort((a, b) => {
    if (a.isHomepage !== b.isHomepage) return Number(b.isHomepage) - Number(a.isHomepage);
    return Number(isContactPage(b.url)) - Number(isContactPage(a.url));
  });

  const seen = new Set<string>();

  // 1. High-priority target: mailto in header, footer, or contact sections
  for (const p of ordered) {
    if (!p.html) continue;
    let $: cheerio.CheerioAPI;
    try {
      $ = cheerio.load(p.html);
    } catch {
      continue;
    }
    const priorityScope = $('header, footer, [class*="contact" i], [id*="contact" i], [class*="footer" i], [id*="footer" i]');
    let foundPriority: string | null = null;
    // 1. Look for mailto links in priority scope
    priorityScope.find('a[href^="mailto:" i]').each((_i, el) => {
      if (foundPriority) return;
      const c = cleanMailto($(el).attr('href') ?? '');
      if (c && !seen.has(c.toLowerCase()) && !isJunk(c)) {
        seen.add(c.toLowerCase());
        foundPriority = c;
      }
    });
    // 2. Look for meta tags containing email in priority scope
    if (!foundPriority) {
      priorityScope.find('meta[name~="email" i], meta[property~="og:email" i]').each((_i, el) => {
        if (foundPriority) return;
        const content = $(el).attr('content');
        if (content) {
          const c = cleanMailto(`mailto:${content}`);
          if (c && !seen.has(c.toLowerCase()) && !isJunk(c)) {
            seen.add(c.toLowerCase());
            foundPriority = c;
          }
        }
      });
    }
    if (foundPriority) {
      return {
        email: foundPriority,
        source: `header/footer meta email (${p.isHomepage ? 'homepage' : p.url.slice(0, 80)})`,
      };
    }
  }

  // 2. Any mailto: link across pages (homepage and contact pages first)
  for (const p of ordered) {
    if (!p.html) continue;
    let $: cheerio.CheerioAPI;
    try {
      $ = cheerio.load(p.html);
    } catch {
      continue;
    }
    let found: string | null = null;
    $('a[href^="mailto:" i]').each((_i, el) => {
      if (found) return;
      const c = cleanMailto($(el).attr('href') ?? '');
      if (c && !seen.has(c.toLowerCase()) && !isJunk(c)) {
        seen.add(c.toLowerCase());
        found = c;
      }
    });
    if (found) {
      return {
        email: found,
        source: p.isHomepage ? 'homepage mailto link' : `mailto link on ${p.url.slice(0, 80)}`,
      };
    }
  }

  // 3. JS-assembled emails from split data attributes (no mailto: present
  // when sites build the address client-side, e.g. class="email-anchor"
  // data-name="Support" data-domain="example.com").
  for (const p of ordered) {
    if (!p.html) continue;
    let $: cheerio.CheerioAPI;
    try {
      $ = cheerio.load(p.html);
    } catch {
      continue;
    }
    for (const raw of extractFromDataAttributes($)) {
      const email = raw.toLowerCase();
      if (!isJunk(email) && !seen.has(email)) {
        seen.add(email);
        return {
          email,
          source: `assembled email attributes on ${p.isHomepage ? 'homepage' : p.url.slice(0, 80)}`,
        };
      }
    }
  }

  // 3. Plain-text email in footer/contact scopes
  for (const p of ordered) {
    if (!p.html) continue;
    let $: cheerio.CheerioAPI;
    try {
      $ = cheerio.load(p.html);
    } catch {
      continue;
    }
    const scope = $('footer, [class*="footer" i], [class*="contact" i], [id*="contact" i]').text();
    if (scope) {
      // Also catches obfuscated "name[at]domain.com" visible text.
      const matches = deobfuscateText(scope).match(EMAIL_RE) ?? [];
      for (const raw of matches) {
        const email = raw.toLowerCase();
        if (!isJunk(email) && !seen.has(email)) {
          return {
            email,
            source: `footer/contact text on ${p.isHomepage ? 'homepage' : p.url.slice(0, 80)}`,
          };
        }
      }
    }
  }

  // 4. Plain-text emails across entire body: most frequent non-junk wins
  const counts = new Map<string, { n: number; first: number }>();
  let order = 0;
  for (const p of ordered) {
    if (!p.html) continue;
    const text = deobfuscateText(
      p.html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '),
    );
    const matches = text.match(EMAIL_RE) ?? [];
    for (const raw of matches) {
      const email = raw.toLowerCase();
      if (isJunk(email)) continue;
      const cur = counts.get(email);
      if (cur) cur.n++;
      else counts.set(email, { n: 1, first: order++ });
    }
  }
  let best: { email: string; n: number; first: number } | null = null;
  for (const [email, v] of counts) {
    if (!best || v.n > best.n || (v.n === best.n && v.first < best.first)) {
      best = { email, n: v.n, first: v.first };
    }
  }
  if (best) return { email: best.email, source: `page text (${best.n} mention${best.n === 1 ? '' : 's'})` };
  return null;
}

