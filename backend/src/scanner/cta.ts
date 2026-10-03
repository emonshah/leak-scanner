import * as cheerio from 'cheerio';
import { CTA_KEYWORDS, hasWord, isSocialUrl } from './crawler';
import type { CrawledPage, CtaFinding, LinkCheck } from './types';

function kindOf(text: string, href: string): string {
  const t = `${text} ${href}`.toLowerCase();
  if (t.includes('tel:') || hasWord(t, 'call')) return 'call';
  if (hasWord(t, 'quote') || hasWord(t, 'estimate')) return 'quote';
  if (hasWord(t, 'book') || hasWord(t, 'booking') || hasWord(t, 'schedule') || hasWord(t, 'appointment')) return 'booking';
  if (hasWord(t, 'contact')) return 'contact';
  return 'general';
}

/**
 * MODULE 5 — CTA analysis on homepage HTML. Destination health comes from the
 * link checker (matched by URL); mobile visibility is filled by the browser
 * module afterwards. Wording alone is never judged.
 */
export function analyzeCtas(
  pages: CrawledPage[],
  linkChecks: LinkCheck[],
): CtaFinding[] {
  const home = pages.find((p) => p.isHomepage) ?? pages[0];
  if (!home?.html) return [];
  const statusByUrl = new Map<string, LinkCheck>();
  for (const c of linkChecks) statusByUrl.set(c.url, c);

  const $ = cheerio.load(home.html);
  const out: CtaFinding[] = [];
  const seen = new Set<string>();
  $('a[href],button').each((_i, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const low = text.toLowerCase();
    if (!CTA_KEYWORDS.some((k) => hasWord(low, k))) return;
    const href = $(el).attr('href')?.trim() ?? null;
    if (href && isSocialUrl(href)) return; // social CTAs never become broken-link claims
    let abs: string | null = null;
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      try {
        abs = new URL(href, home.url).toString();
      } catch {
        abs = null;
      }
    }
    const key = `${low}::${abs ?? href ?? 'button'}`;
    if (seen.has(key)) return;
    seen.add(key);
    const check = abs ? statusByUrl.get(abs) : undefined;
    out.push({
      text: text.slice(0, 80),
      href: abs ?? href,
      page: home.url,
      kind: kindOf(text, href ?? ''),
      destinationOk: check ? !check.broken : href === null ? null : null,
      destinationStatus: check?.status ?? null,
      visibleOnMobile: null,
    });
  });
  return out.slice(0, 20);
}
