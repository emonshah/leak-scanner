import * as cheerio from 'cheerio';
import { assertPublicUrl } from '../utils/ssrf';
import { proxyInit } from '../utils/proxy';
import { CONTACT_PATH_RE } from './findings';
import type { CrawledPage, DiscoveredLink } from './types';

export const CTA_KEYWORDS = [
  'call now',
  'get quote',
  'get a quote',
  'free quote',
  'request a quote',
  'free estimate',
  'get estimate',
  'book now',
  'book online',
  'contact us',
  'request service',
  'schedule',
  'get started',
  'request appointment',
  'free consultation',
  'call today',
  // Bare action words (word-boundary matched — never 'recall'/'facebook'):
  // bare "Book / Call / Contact" header buttons are conversion paths too.
  'call',
  'contact',
  'book',
  'booking',
  'quote',
  'estimate',
  'appointment',
];

export const CONTACT_HINTS = [
  'contact',
  'quote',
  'book',
  'booking',
  'estimate',
  'schedule',
  'appointment',
  'call',
  'phone',
  'tel:',
  'mailto:',
];

/** Word-boundary match: 'book' must not fire inside 'facebook'/'ebook',
 *  'call' must not fire inside 'recall'/'callout'. */
export function hasWord(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

const SOCIAL_HOST_RE = /(^|\.)(facebook|instagram|linkedin|twitter|x|youtube|tiktok|pinterest|yelp|bbb)\.(com|org|net|me|co|us)$/;
const NON_CONVERSION_TOKENS = new Set([
  'facebook', 'instagram', 'linkedin', 'twitter', 'youtube', 'tiktok', 'pinterest',
  'ebook', 'ebooks', 'e-book', 'cookbook', 'cookbooks', 'whitepaper', 'whitepapers',
]);

/** Social/ebook URLs are never conversion paths — the owner does not
 *  control Facebook's HTTP status, so a rate-limited HEAD there must
 *  never become an EMERGENCY "broken quote link". */
export function isSocialUrl(href: string): boolean {
  try {
    const u = new URL(href, 'http://placeholder.local');
    if (SOCIAL_HOST_RE.test(u.hostname.toLowerCase())) return true;
    const tokens = u.pathname.toLowerCase().split(/[/._\-?#]+/);
    if (tokens.some((t) => NON_CONVERSION_TOKENS.has(t))) return true;
  } catch {
    /* unparseable href — not our claim */
  }
  return false;
}

const CONTACT_WORDS = [
  'contact',
  'quote',
  'book',
  'booking',
  'estimate',
  'schedule',
  'appointment',
  'call',
  'phone',
];

function classifyImportance(
  text: string,
  href: string,
  inNav: boolean,
): DiscoveredLink['importance'] {
  const t = `${text} ${href}`.toLowerCase();
  if (isSocialUrl(href)) return inNav ? 'nav' : 'normal';
  if (CTA_KEYWORDS.some((k) => hasWord(t, k))) return 'cta';
  if (t.includes('tel:') || t.includes('mailto:')) return 'contact';
  if (CONTACT_WORDS.some((w) => hasWord(t, w))) return 'contact';
  if (inNav) return 'nav';
  return 'normal';
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
}

async function fetchPage(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; finalUrl: string; html: string; ms: number } | { error: string }> {
  await assertPublicUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'ConversionLeakScanner/1.0 (+local audit; contact site owner)',
        Accept: 'text/html,application/xhtml+xml',
      },
      ...proxyInit(),
    });
    const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
    const ms = Date.now() - start;
    const ct = res.headers.get('content-type') ?? '';
    const html =
      ct.includes('html') || ct === ''
        ? Buffer.from(buf).toString('utf8').slice(0, 2_000_000)
        : '';
    return { status: res.status, finalUrl: res.url || url, html, ms };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One-off page fetch for quote/contact destinations the BFS never reached.
 * Same passive GET + SSRF guard as the crawler. Returns null when the page
 * cannot be retrieved — callers must then make NO claim about it.
 */
export async function fetchExtraPage(url: string): Promise<CrawledPage | null> {
  let finalUrl: string = url;
  try {
    const u = await assertPublicUrl(url);
    finalUrl = u.toString();
  } catch {
    return null;
  }
  const fetched = await fetchPage(finalUrl, 15000).catch(() => null);
  if (!fetched || 'error' in fetched || fetched.status < 200 || fetched.status >= 400 || !fetched.html) {
    return null;
  }
  let title: string | null = null;
  try {
    const $ = cheerio.load(fetched.html);
    title = $('title').first().text().trim().slice(0, 200) || null;
  } catch { /* title optional */ }
  return {
    url: finalUrl,
    normalizedUrl: finalUrl,
    statusCode: fetched.status,
    finalUrl: fetched.finalUrl,
    responseTimeMs: fetched.ms,
    title,
    isHomepage: false,
    html: fetched.html,
  };
}

/**
 * MODULE 2 — controlled same-host BFS crawler. Passive GETs only, bounded
 * page count, dedupe by normalized URL. Returns pages + discovered links.
 */
export async function crawlSite(
  seedUrl: string,
  opts: { maxPages?: number; timeoutMs?: number } = {},
): Promise<{ pages: CrawledPage[]; links: DiscoveredLink[] }> {
  const maxPages = opts.maxPages ?? 12;
  const timeoutMs = opts.timeoutMs ?? 15000;

  const seed = await assertPublicUrl(seedUrl);
  const seedOrigin = seed.origin;
  const seen = new Set<string>([seed.toString()]);
  const queue: string[] = [seed.toString()];
  const pages: CrawledPage[] = [];
  const links: DiscoveredLink[] = [];
  const linkSeen = new Set<string>();

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift()!;
    const isHomepage = pages.length === 0;
    const fetched = await fetchPage(url, timeoutMs).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : String(e),
    }));
    if ('error' in fetched) {
      pages.push({
        url,
        normalizedUrl: url,
        statusCode: null,
        finalUrl: null,
        responseTimeMs: null,
        title: null,
        isHomepage,
        html: '',
      });
      continue;
    }
    const $ = cheerio.load(fetched.html || '<html></html>');
    const title = $('title').first().text().trim().slice(0, 200) || null;
    pages.push({
      url,
      normalizedUrl: url,
      statusCode: fetched.status,
      finalUrl: fetched.finalUrl,
      responseTimeMs: fetched.ms,
      title,
      isHomepage,
      html: fetched.html,
    });

    $('a[href]').each((_i, el) => {
      const rawHref = ($(el).attr('href') ?? '').trim();
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;
      const text = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120);
      const inNav = $(el).closest('nav,header,[role="navigation"]').length > 0;
      const low = rawHref.toLowerCase();
      if (low.startsWith('tel:')) {
        links.push({ sourcePage: url, href: rawHref, absoluteUrl: rawHref, text, kind: 'tel', importance: 'contact' });
        return;
      }
      if (low.startsWith('mailto:')) {
        links.push({ sourcePage: url, href: rawHref, absoluteUrl: rawHref, text, kind: 'mailto', importance: 'contact' });
        return;
      }
      let abs: string;
      try {
        const u = new URL(rawHref, url);
        u.hash = ''; // fragments never change server content — /contact and
        // /contact#form are ONE page, fetched and scored once.
        abs = u.toString();
      } catch {
        return;
      }
      if (!abs.startsWith('http://') && !abs.startsWith('https://')) {
        links.push({ sourcePage: url, href: rawHref, absoluteUrl: null, text, kind: 'other', importance: classifyImportance(text, rawHref, inNav) });
        return;
      }
      const dedupe = `${url}→${abs}`;
      if (linkSeen.has(dedupe)) return;
      linkSeen.add(dedupe);
      const internal = sameHost(abs, seedOrigin);
      links.push({
        sourcePage: url,
        href: rawHref,
        absoluteUrl: abs,
        text,
        kind: internal ? 'internal' : 'external',
        importance: classifyImportance(text, rawHref, inNav),
      });
      if (internal && !seen.has(abs) && queue.length + pages.length < maxPages * 2) {
        // Keep crawl focused: follow internal links without query-string explosions.
        // Contact-intent pages jump the queue so the 12-page budget always
        // covers the quote/contact path (M8 dead-contact needs them crawled).
        try {
          const u = new URL(abs);
          if (u.search.length < 200) {
            seen.add(abs);
            if (CONTACT_PATH_RE.test(u.pathname)) queue.unshift(abs);
            else queue.push(abs);
          }
        } catch {
          /* ignore */
        }
      }
    });
  }
  return { pages, links };
}
