import * as cheerio from 'cheerio';
import { TECH_PRINTS } from './fingerprints';
import { assertPublicUrl } from '../utils/ssrf';
import { proxyInit } from '../utils/proxy';
import type { CrawledPage, ResourceEntry } from './types';

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface TechEvidence {
  type: 'header' | 'html' | 'asset' | 'cookie' | 'dom' | 'endpoint';
  value: string;
  page: string;
}

export interface TechItem {
  technology: string;
  category: string;
  version: string | null;
  confidence: Confidence;
  methods: string[];
  evidence: TechEvidence[];
}

export interface WpPlugin {
  slug: string;
  name: string;
  version: string | null;
  confidence: Confidence;
  evidence: TechEvidence[];
  pages: string[];
}

export interface WpTheme {
  slug: string;
  name: string | null;
  version: string | null;
  childTheme: boolean;
  parentSlug: string | null;
  confidence: Confidence;
  evidence: TechEvidence[];
}

export interface WpInfo {
  detected: boolean;
  confidence: Confidence;
  version: string | null;
  versionState: 'detected' | 'conflict' | 'unknown';
  versionEvidence: string[];
  theme: WpTheme | null;
  themeState: 'detected' | 'uncertain' | 'unknown';
  plugins: WpPlugin[];
  pluginNote: string;
}

export interface TechReport {
  items: TechItem[];
  primaryPlatform: string;
  primaryConfidence: Confidence;
  platformNote: string;
  wordpress: WpInfo;
  quality: { level: 'Excellent' | 'Good' | 'Limited'; signals: number; conflicts: number; reason: string };
}

interface Corpus {
  headers: Record<string, string>;
  htmlAll: string;
  homeHtml: string;
  assets: string[];
  cookies: string[];
  generator: string | null;
}

function collect(
  pages: CrawledPage[],
  headers: Record<string, string>,
  resources: ResourceEntry[],
): Corpus {
  const home = pages.find((p) => p.isHomepage) ?? pages[0];
  const htmlAll = pages.map((p) => p.html).join('\n').slice(0, 600000);
  // Asset URLs from HTML itself (stylesheets, scripts, images) + browser
  // resources — detection must not depend on one source alone.
  const htmlAssets = new Set<string>();
  try {
    for (const p of pages) {
      if (!p.html) continue;
      const $ = cheerio.load(p.html);
      const push = (u: string | undefined) => {
        if (!u) return;
        try {
          const abs = new URL(u, p.url).toString();
          if (abs.startsWith('http://') || abs.startsWith('https://')) htmlAssets.add(abs);
        } catch {
          /* relative garbage — ignore */
        }
      };
      $('link[href],script[src],img[src]').each((_i, el) => {
        push($(el).attr('href') ?? $(el).attr('src'));
      });
    }
  } catch {
    /* parse failure — browser resources still count */
  }
  const assets = [...new Set([
    ...htmlAssets,
    ...resources.map((r) => r.url),
  ])].filter((u) => u.startsWith('http')).slice(0, 600);
  const cookieNames = Object.entries(headers)
    .filter(([k]) => k === 'set-cookie')
    .flatMap(([, v]) => v.split(/,(?=[^;]+?=)/))
    .map((c) => c.split(';')[0]?.split('=')[0]?.trim() ?? '')
    .filter(Boolean);
  let generator: string | null = null;
  try {
    const $ = cheerio.load(home?.html ?? '<html></html>');
    generator = ($('meta[name="generator"]').attr('content') ?? '').trim().slice(0, 120) || null;
  } catch {
    generator = null;
  }
  return { headers, htmlAll, homeHtml: home?.html ?? '', assets, cookies: cookieNames, generator };
}

async function tinyGetText(url: string, ms = 8000, cap = 40000): Promise<string | null> {
  try {
    await assertPublicUrl(url);
  } catch {
    return null;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'ConversionLeakScanner/1.0 (+local audit)', Accept: '*/*' },
      ...proxyInit(),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
    return Buffer.from(buf).toString('utf8').slice(0, cap);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function parseThemeHeaders(css: string): Record<string, string> {  const m = /\/\*(.*?)\*\//s.exec(css.slice(0, 8000));
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1]!.split('\n')) {
    const mm = /^\s*(Theme Name|Theme URI|Author|Version|Template|Description)\s*:\s*(.+?)\s*$/.exec(line);
    if (mm) out[mm[1]!.toLowerCase().replace(' ', '_')] = mm[2]!.slice(0, 120);
  }
  return out;
}

export function assetVersion(url: string): string | null {
  try {
    const u = new URL(url);
    const v = u.searchParams.get('ver') ?? u.searchParams.get('version');
    return v && /^\d[\w.\-]{0,19}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Mandatory technology detection stage. Passive signals only:
 * headers, HTML, asset URLs, cookies — plus at most two tiny public
 * file fetches for WordPress (wp-json root, active theme style.css).
 * Never guesses: unknown stays unknown, conflicts are reported.
 */
export async function detectTechnology(
  pages: CrawledPage[],
  headers: Record<string, string>,
  resources: ResourceEntry[],
  homeUrl: string,
): Promise<TechReport> {
  const c = collect(pages, headers, resources);
  const items: TechItem[] = [];
  const headerText = Object.entries(c.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
  const assetText = c.assets.join('\n');
  const cookieText = c.cookies.join(' ');

  for (const p of TECH_PRINTS) {
    const hits: TechEvidence[] = [];
    const methods = new Set<string>();
    for (const m of p.markers) {
      if (m.source === 'header' && m.pattern.test(headerText)) {
        hits.push({ type: 'header', value: `matched ${m.pattern}`.slice(0, 150), page: homeUrl });
        methods.add('HTTP headers');
      } else if (m.source === 'html' && (m.pattern.test(c.htmlAll) || (c.generator && m.pattern.test(c.generator)))) {
        hits.push({ type: 'html', value: `matched ${m.pattern}`.slice(0, 150), page: homeUrl });
        methods.add('HTML');
      } else if (m.source === 'asset' && m.pattern.test(assetText)) {
        const sample = c.assets.find((u) => m.pattern.test(u)) ?? '';
        hits.push({ type: 'asset', value: sample.slice(0, 200), page: homeUrl });
        methods.add('asset URLs');
      } else if (m.source === 'cookie' && m.pattern.test(cookieText)) {
        hits.push({ type: 'cookie', value: c.cookies.find((x) => m.pattern.test(x)) ?? 'cookie', page: homeUrl });
        methods.add('cookies');
      } else if (m.source === 'dom' && m.pattern.test(c.htmlAll)) {
        hits.push({ type: 'html', value: `DOM marker ${m.pattern}`.slice(0, 150), page: homeUrl });
        methods.add('DOM fingerprint');
      }
    }
    const distinct = new Set(hits.map((h) => h.type)).size;
    if (hits.length === 0) continue;
    const confidence: Confidence = distinct >= 2 ? 'HIGH' : p.strong ? 'MEDIUM' : 'LOW';
    items.push({
      technology: p.name,
      category: p.category,
      version: null,
      confidence,
      methods: [...methods],
      evidence: hits.slice(0, 5),
    });
  }

  // ---- WordPress deep dive ----
  const wpHits = items.filter((i) => i.technology === 'WordPress');
  const wpStrong = wpHits.some((i) => i.confidence === 'HIGH') ||
    (c.assets.some((u) => /\/wp-content\//.test(u)) && c.assets.some((u) => /\/wp-includes\//.test(u)));
  const wordpress: WpInfo = {
    detected: false,
    confidence: 'LOW',
    version: null,
    versionState: 'unknown',
    versionEvidence: [],
    theme: null,
    themeState: 'unknown',
    plugins: [],
    pluginNote: 'Plugins detected from publicly observable website assets.',
  };

  if (wpStrong) {
    wordpress.detected = true;
    wordpress.confidence = wpHits.some((i) => i.confidence === 'HIGH') ? 'HIGH' : 'MEDIUM';
    // Version: generator meta first.
    const genVer = c.generator ? /wordpress\s+(\d+\.\d+(?:\.\d+)?)/i.exec(c.generator)?.[1] ?? null : null;
    // Version: ?ver= on core assets.
    const coreVers = [...new Set(
      c.assets.filter((u) => /\/wp-includes\//.test(u)).map(assetVersion).filter((v): v is string => !!v),
    )];
    const versions = [...new Set([genVer, ...coreVers].filter((v): v is string => !!v))];
    if (genVer) wordpress.versionEvidence.push(`generator meta: WordPress ${genVer}`);
    for (const v of coreVers.slice(0, 3)) wordpress.versionEvidence.push(`core asset ?ver=${v}`);
    if (versions.length === 1) {
      wordpress.version = versions[0]!;
      wordpress.versionState = 'detected';
    } else if (versions.length > 1) {
      wordpress.versionState = 'conflict';
    }
    // Active theme: prefer slugs inside enqueued stylesheets, then body classes.
    const themeSlugs = [...new Set(
      [...c.htmlAll.matchAll(/\/wp-content\/themes\/([a-z0-9\-_]+)/gi)].map((m) => m[1]!.toLowerCase()),
    )];
    let activeSlug: string | null = null;
    try {
      const $ = cheerio.load(c.homeHtml || '<html></html>');
      const cssHrefs: string[] = [];
      $('link[rel="stylesheet"]').each((_i, el) => {
        const h = $(el).attr('href');
        if (h) cssHrefs.push(h);
      });
      activeSlug = cssHrefs.map((h) => /\/wp-content\/themes\/([a-z0-9\-_]+)/i.exec(h)?.[1]?.toLowerCase() ?? null).find((s): s is string => !!s) ?? null;
      if (!activeSlug) {
        const bodyClass = ($('body').attr('class') ?? '').toLowerCase();
        activeSlug = themeSlugs.find((s) => bodyClass.includes(s.replace(/-/g, '')) || bodyClass.includes(s)) ?? null;
      }
    } catch {
      activeSlug = null;
    }
    if (!activeSlug && themeSlugs.length === 1) activeSlug = themeSlugs[0]!;
    if (activeSlug) {
      // Single public file fetch: the theme's own style.css header.
      let origin = '';
      try {
        origin = new URL(homeUrl).origin;
      } catch {
        origin = '';
      }
      let meta: Record<string, string> = {};
      if (origin) {
        const css = await tinyGetText(`${origin}/wp-content/themes/${activeSlug}/style.css`);
        if (css) meta = parseThemeHeaders(css);
      }
      const tpl = meta['template'];
      wordpress.theme = {
        slug: activeSlug,
        name: meta['theme_name'] ?? null,
        version: meta['version'] ?? null,
        childTheme: !!tpl,
        parentSlug: tpl?.toLowerCase() ?? null,
        confidence: themeSlugs.length > 1 && !meta['theme_name'] ? 'MEDIUM' : 'HIGH',
        evidence: [
          { type: 'asset', value: `/wp-content/themes/${activeSlug}/`, page: homeUrl },
          ...(meta['theme_name'] ? [{ type: 'html' as const, value: `style.css Theme Name: ${meta['theme_name']}`, page: homeUrl }] : []),
        ],
      };
      wordpress.themeState = themeSlugs.length > 1 && !meta['theme_name'] ? 'uncertain' : 'detected';
    }
    // NOTE: plugin inventory was deliberately removed. Matching
    // /wp-content/plugins/ path strings misfires on non-WordPress sites
    // (any page mentioning those paths) and a business leak scanner has
    // no use for a plugin list — only the platform (what the site is
    // built with) plus deep security findings matter. wordpress.plugins
    // therefore always stays empty.
    // Live-install proof gate: bare wp-content path strings also appear on
    // custom/static-copy sites that merely mirror WordPress assets. Without
    // at least one live proof (generator meta, core ?ver asset, or a
    // readable theme style.css with a Theme Name), this is NOT claimed as
    // WordPress — unknown stays unknown instead of a false HIGH.
    const liveProof = !!genVer || coreVers.length > 0 || !!wordpress.theme?.name;
    if (!liveProof) {
      wordpress.detected = false;
      wordpress.confidence = 'LOW';
      wordpress.version = null;
      wordpress.versionState = 'unknown';
      wordpress.versionEvidence = [];
      wordpress.theme = null;
      wordpress.themeState = 'unknown';
      wordpress.plugins = [];
    }
  }

  // ---- Conflicts (e.g. headless/decoupled setups) ----
  const strongNames = items.filter((i) => i.confidence === 'HIGH').map((i) => i.technology);
  const conflicts: string[] = [];
  if (wordpress.detected && strongNames.some((n) => ['Next', 'Nuxt', 'Gatsby', 'Astro'].includes(n))) {
    conflicts.push('WordPress signals alongside a JS framework — possible headless/decoupled setup. Both are shown; review manually.');
  }

  // ---- Primary platform ----
  const byCat = (cat: string) => items.filter((i) => i.category === cat);
  const cms = byCat('CMS').filter((i) => i.confidence !== 'LOW');
  const fw = items.filter((i) => i.category === 'Framework' && i.confidence !== 'LOW');
  let primaryPlatform = 'Custom / unidentified';
  let primaryConfidence: Confidence = 'MEDIUM';
  let platformNote = 'No reliable CMS/framework fingerprint was detected.';
  if (cms.length > 0) {
    primaryPlatform = cms[0]!.technology;
    primaryConfidence = cms[0]!.confidence;
    platformNote = `Detected from ${cms[0]!.methods.join(', ').toLowerCase()}.`;
  } else if (fw.length > 0) {
    primaryPlatform = fw[0]!.technology;
    primaryConfidence = fw[0]!.confidence;
    platformNote = `Detected from ${fw[0]!.methods.join(', ').toLowerCase()}.`;
  } else {
    const weak = items.find((i) => i.confidence === 'LOW');
    if (weak) {
      primaryPlatform = `${weak.technology} (possible)`;
      primaryConfidence = 'LOW';
      platformNote = 'Only weak fingerprint evidence — treat as possible, not fact.';
    }
  }

  const signals = items.reduce((s, i) => s + i.evidence.length, 0) +
    wordpress.plugins.length + (wordpress.theme ? 2 : 0);
  return {
    items,
    primaryPlatform,
    primaryConfidence,
    platformNote,
    wordpress,
    quality: {
      level: signals >= 10 && conflicts.length === 0 ? 'Excellent' : signals >= 4 ? 'Good' : 'Limited',
      signals,
      conflicts: conflicts.length,
      reason: conflicts.length > 0
        ? conflicts.join(' ')
        : signals < 4
          ? 'Few public signals — site may block requests or be custom-built.'
          : `${signals} public signals, no conflicts.`,
    },
  };
}
