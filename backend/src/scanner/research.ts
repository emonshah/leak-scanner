import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { getBrowser, mobileUA } from './browser';
import { assertPublicUrl } from '../utils/ssrf';

export const RESEARCH_MAX_PAGES = 1;
export const RESEARCH_WEBP_QUALITY = 80;
/** Single mobile hero crop: header + hero + first CTA (token-cheap, blur-free). */
export const RESEARCH_VIEWPORT = { width: 390, height: 844 };
export const RESEARCH_CROP_HEIGHT = 1300;
const NAV_TIMEOUT = 30000;

export type ResearchPageType =
  | 'homepage'
  | 'services'
  | 'products'
  | 'about'
  | 'contact'
  | 'booking'
  | 'pricing'
  | 'locations';

export interface ResearchDiscoveredPage {
  url: string;
  pageType: ResearchPageType;
  fileName: string;
}

export interface ResearchRunResult {
  pages: ResearchDiscoveredPage[];
  failedPages: { url: string; reason: string }[];
}

/** Never crawl these for business research (login/legal/cart/noise). */
const DENY_RE =
  /(login|log-in|signin|sign-in|register|signup|sign-up|search|privacy|terms|cookie|admin|wp-admin|wp-login|cart|checkout|author|tag\/|tags\/|category\/|\/feed\/?$|sitemap\.xml|robots\.txt)/i;

/** Date-ish blog-post URLs are individual posts, not business pages. */
const BLOG_POST_RE = /\/20\d\d\/\d\d?\//;

const TYPE_PATTERNS: { type: Exclude<ResearchPageType, 'homepage'>; res: RegExp[] }[] = [
  { type: 'services', res: [/servic/, /what-we-do/, /offer/, /solution/, /work\b/, /our-work/, /portfolio/] },
  { type: 'products', res: [/product/, /shop\b/, /collection/, /catalog/] },
  { type: 'about', res: [/about/, /who-we-are/, /our-story/, /our-team/, /company/] },
  { type: 'contact', res: [/contact/, /get-in-touch/, /reach-us/] },
  { type: 'booking', res: [/book/, /appointment/, /schedule/, /reserve/, /quote/, /estimate/, /enquir/, /inquir/] },
  { type: 'pricing', res: [/pric/, /cost/, /rates?/, /plans?/] },
  { type: 'locations', res: [/location/, /areas?-served/, /branches?/, /stores?/, /find-us/, /visit/] },
];

/** Priority order when two candidates tie: services first, locations last. */
const TYPE_PRIORITY: ResearchPageType[] = [
  'services',
  'products',
  'about',
  'contact',
  'booking',
  'pricing',
  'locations',
];

/** Pure: classify a same-host link into a business page type (or null = skip). */
export function classifyResearchLink(href: string, text: string): ResearchPageType | null {
  const hay = `${href} ${text}`.toLowerCase();
  if (DENY_RE.test(hay) || BLOG_POST_RE.test(href)) return null;
  if (/\/blog\/?(\?.*)?$|\/news\/?(\?.*)?$/.test(href)) return null; // listing itself is noise
  for (const { type, res } of TYPE_PATTERNS) {
    if (res.some((r) => r.test(hay))) return type;
  }
  return null;
}

/** Pure: score a candidate link. Nav links + business keywords win. */
export function scoreResearchLink(args: {
  href: string;
  text: string;
  inNav: boolean;
  pageType: ResearchPageType;
}): number {
  let s = 0;
  if (args.inNav) s += 30;
  const textLen = args.text.trim().length;
  if (textLen >= 3 && textLen <= 40) s += 8; // real menu label, not a paragraph link
  const pri = TYPE_PRIORITY.indexOf(args.pageType);
  s += (TYPE_PRIORITY.length - pri) * 4; // services/products outrank locations
  if (/contact|book|quote|call/i.test(args.text)) s += 6;
  // Deep nested URLs are less likely to be the canonical business page.
  const depth = new URL(args.href).pathname.split('/').filter(Boolean).length;
  s -= Math.min(depth, 4) * 2;
  return s;
}

/** Pure: safe domain folder name (matches route validator). */
export function sanitizeResearchDomain(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/^www\./, '').slice(0, 255);
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) ? h : null;
}

/** Pure: predictable file name for a page type (dedup with -2 suffix). */
export function researchFileName(pageType: ResearchPageType, taken: Set<string>): string {
  const base = `${pageType}-mobile.webp`;
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let i = 2;
  while (taken.has(`${pageType}-${i}-mobile.webp`)) i++;
  const name = `${pageType}-${i}-mobile.webp`;
  taken.add(name);
  return name;
}

/** Storage root: <cwd>/screenshots-research (sibling of scan screenshots/). */
export function researchRoot(): string {
  return path.resolve(process.cwd(), 'screenshots-research');
}

export function researchDomainDir(domain: string): string {
  return path.resolve(researchRoot(), domain);
}

/**
 * User requirement: no stale/unnecessary files may survive inside the domain
 * folder. Wipe the folder contents, then start fresh.
 */
export async function prepareResearchDir(domainDir: string): Promise<void> {
  await fs.mkdir(domainDir, { recursive: true });
  const entries = await fs.readdir(domainDir).catch(() => [] as string[]);
  await Promise.all(
    entries.map((e) => fs.rm(path.resolve(domainDir, e), { recursive: true, force: true })),
  );
}

const COOKIE_CLICK_JS = `(function(){
  try{
    var btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    var rx = /^(accept( all)?|agree|got it|allow all|ok|okay|yes.*cookies|continue)$/i;
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].innerText || '').trim().slice(0, 30);
      if (rx.test(t)) {
        var r = btns[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.top < window.innerHeight) { btns[i].click(); return true; }
      }
    }
  }catch(e){}
  return false;
})()`;

async function settlePage(page: import('playwright').Page): Promise<void> {
  await page.evaluate(COOKIE_CLICK_JS).catch(() => false);
  await page.waitForTimeout(800);
  // Hero-only settle: scroll just past the 1300px crop so lazy hero images
  // render, then back to top. No full-page scroll pass (waste for a crop).
  await page
    .evaluate(
      `(async function(){
        var target = ${RESEARCH_CROP_HEIGHT};
        var step = 400; var y = 0;
        while (y < target) { window.scrollTo(0, y); y += step; await new Promise(function(r){ setTimeout(r, 80); }); }
        window.scrollTo(0, 0);
      })()`,
    )
    .catch(() => undefined);
  await page.waitForTimeout(800);
}

interface RawLink {
  href: string;
  text: string;
  inNav: boolean;
}

const EXTRACT_LINKS_JS = `(function(){
  try{
    var out = []; var seen = {};
    var navs = Array.from(document.querySelectorAll('header nav a[href], nav[aria-label] a[href], [role="navigation"] a[href]'));
    var navSet = {};
    for (var n = 0; n < navs.length; n++) { try { navSet[new URL(navs[n].href, document.baseURI).href] = true; } catch(e){} }
    var anchors = Array.from(document.querySelectorAll('a[href]')).slice(0, 400);
    for (var i = 0; i < anchors.length; i++) {
      var abs = null;
      try { abs = new URL(anchors[i].getAttribute('href'), document.baseURI).href; } catch(e){ continue; }
      if (seen[abs]) continue; seen[abs] = true;
      var t = ((anchors[i].innerText || anchors[i].getAttribute('aria-label') || '') + '').trim().replace(/\\s+/g, ' ').slice(0, 80);
      out.push({ href: abs, text: t, inNav: !!navSet[abs] });
    }
    return out;
  }catch(e){ return []; }
})()`;

/** Homepage + up to 3 best business pages (max 4 total). Same-host only. */
export async function discoverBusinessPages(
  page: import('playwright').Page,
  homeUrl: string,
): Promise<{ url: string; pageType: Exclude<ResearchPageType, 'homepage'> }[]> {
  const homeHost = new URL(homeUrl).hostname.toLowerCase();
  const raw = (await page.evaluate(EXTRACT_LINKS_JS).catch(() => [])) as RawLink[];
  const scored: { url: string; pageType: Exclude<ResearchPageType, 'homepage'>; score: number }[] = [];
  const seenType = new Map<string, number>();
  for (const l of raw) {
    let u: URL;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    const host = u.hostname.toLowerCase();
    const sameHost = host === homeHost || host === `www.${homeHost}` || homeHost === `www.${host}`;
    if (!sameHost) continue;
    u.hash = '';
    const clean = u.toString();
    if (clean === homeUrl) continue;
    const type = classifyResearchLink(clean, l.text);
    if (!type || type === 'homepage') continue;
    const score = scoreResearchLink({ href: clean, text: l.text, inNav: l.inNav, pageType: type });
    scored.push({ url: clean, pageType: type, score });
    void seenType;
  }
  scored.sort((a, b) => b.score - a.score);
  // One page per type (canonical business page), max 3.
  const picked: { url: string; pageType: Exclude<ResearchPageType, 'homepage'> }[] = [];
  const usedTypes = new Set<string>();
  const usedUrls = new Set<string>();
  for (const c of scored) {
    if (picked.length >= RESEARCH_MAX_PAGES - 1) break;
    if (usedTypes.has(c.pageType) || usedUrls.has(c.url)) continue;
    usedTypes.add(c.pageType);
    usedUrls.add(c.url);
    picked.push({ url: c.url, pageType: c.pageType });
  }
  return picked;
}

async function gotoSettled(
  page: import('playwright').Page,
  url: string,
): Promise<void> {
  await assertPublicUrl(url);
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  if (!resp) throw new Error('Navigation produced no response');
  if (resp.status() === 403 || resp.status() === 429) {
    const body = (await page.content().catch(() => '')).slice(0, 4000).toLowerCase();
    if (/captcha|cloudflare|just a moment|verify you are human|are you a robot|datadome|perimeterx/.test(body)) {
      throw new Error(`Blocked by bot protection (HTTP ${resp.status()})`);
    }
    throw new Error(`HTTP ${resp.status()}`);
  }
  if (resp.status() >= 400) throw new Error(`HTTP ${resp.status()}`);
  // Redirect hops must stay public too (rebinding-safe).
  await assertPublicUrl(page.url()).catch(() => {
    throw new Error('Redirected to a private target');
  });
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  await settlePage(page);
}

/**
 * Research run for one site: SINGLE mobile hero crop (390x1300, header + hero
 * + first CTA). No multi-page crawl — token-cheap and blur-free for Gemini.
 * Never throws for a bad page — records it and continues.
 */
export async function runResearchSite(
  seedUrl: string,
  domainDir: string,
  onPage?: (done: number) => void,
): Promise<ResearchRunResult> {
  await assertPublicUrl(seedUrl);
  await prepareResearchDir(domainDir);
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    viewport: { ...RESEARCH_VIEWPORT },
    userAgent: mobileUA(),
    javaScriptEnabled: true,
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const page = await ctx.newPage();
  const pages: ResearchDiscoveredPage[] = [];
  const failedPages: { url: string; reason: string }[] = [];
  const taken = new Set<string>();
  try {
    await gotoSettled(page, seedUrl);
    const homeFile = researchFileName('homepage', taken);
    await captureHeroCrop(page, path.resolve(domainDir, homeFile));
    pages.push({ url: page.url(), pageType: 'homepage', fileName: homeFile });
    onPage?.(pages.length);
  } finally {
    await ctx.close().catch(() => undefined);
  }
  return { pages, failedPages };
}

/** Mobile hero crop: top 390x1300 only, optimized WebP. */
async function captureHeroCrop(page: import('playwright').Page, outPath: string): Promise<void> {
  // Temporarily tall viewport so the 1300px capture never clips outside it,
  // then restore (width unchanged = layout stable).
  await page.setViewportSize({ width: RESEARCH_VIEWPORT.width, height: RESEARCH_CROP_HEIGHT }).catch(() => undefined);
  await page.evaluate('window.scrollTo(0, 0)').catch(() => undefined);
  await page.waitForTimeout(300);
  try {
    const buf = await page.screenshot({ timeout: 20000 });
    await sharp(buf).webp({ quality: RESEARCH_WEBP_QUALITY }).toFile(outPath);
  } finally {
    await page.setViewportSize({ ...RESEARCH_VIEWPORT }).catch(() => undefined);
  }
}
