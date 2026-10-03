import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { CTA_KEYWORDS } from './crawler';
import {
  ABOVE_FOLD_PHONE_JS,
  DETECT_CTAS_JS,
  DISMISS_OVERLAYS_JS,
  INIT_SCRIPT_JS,
  OVERFLOW_OFFENDER_JS,
  PHONE_HITTEST_JS,
  TIMING_JS,
  TRACKING_KEYWORDS,
  VISITOR_MASK_JS,
} from './browser-scripts';
import type { BrowserResult, CtaObservation, ResourceEntry, ViewportResult } from './types';
import { decideCta } from './visibility';
import type { CtaSignals } from './visibility';
import { proxyServer } from '../utils/proxy';

export type ViewportName = 'desktop' | 'tablet' | 'mobile';

const VIEWPORTS: Record<ViewportName, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};
const NAV_TIMEOUT = 30000;

const BLOCK_TITLE_RE = /just a moment|attention required|verify you are|Verifying you are|captcha|access denied|request blocked|are you a robot/i;

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    const headless = process.env['HEADFUL'] !== '1';
    const args = ['--no-sandbox', '--disable-dev-shm-usage'];
    const proxy = proxyServer();
    const proxyOpt = proxy ? { proxy: { server: proxy } } : {};
    // Real Chrome first (genuine TLS/GPU fingerprint, fewer bot flags);
    // fall back to bundled Chromium when Chrome is not installed.
    try {
      browser = await chromium.launch({ channel: 'chrome', headless, args, ...proxyOpt });
    } catch {
      browser = await chromium.launch({ headless, args, ...proxyOpt });
    }
    // Pin the UA major to the actual engine (a UA claiming Chrome/120 on
    // engine 154 is itself a bot tell for picky filters).
    try {
      const m = /^(\d+)\./.exec(browser.version() ?? '');
      if (m?.[1]) chromeMajor = m[1];
    } catch {
      /* keep default */
    }
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => undefined);
    browser = null;
  }
}

function shotDir(scanId: number): string {
  return path.resolve(process.cwd(), 'screenshots', String(scanId));
}

// Real-visitor User-Agents (no bot suffix). The fetch probe still
// identifies honestly as ConversionLeakScanner; the *browser* presents as
// a normal visitor because WAFs block automation-tagged UAs on sight —
// and the operator's own Chrome on the same IP loads these sites fine.
// Major version tracks the real engine (see getBrowser).
let chromeMajor = '120';
export function desktopUA(): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
}
export function mobileUA(): string {
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Mobile Safari/537.36`;
}

interface RawCta {
  text: string;
  aria: string | null;
  href: string | null;
  tag: string;
  role: string | null;
  inMenu: boolean;
  stickyOrFloating: boolean;
  box: { x: number; y: number; width: number; height: number } | null;
  displayed: boolean;
  visibilityVisible: boolean;
  opacityVisible: boolean;
  hasSize: boolean;
  inViewport: boolean;
  notClipped: boolean;
  hitTestPass: boolean | null;
  hitTestScore?: { pass: number; total: number } | null;
  /** Covering element at the tap point (null when CTA itself is on top). */
  cover?: { tag: string; selector: string } | null;
  clickable: boolean;
  hasClickListener: boolean | null;
  hasOnClick: boolean;
  hasDataAction: boolean;
  overlaySuppressed: boolean;
  selector: string;
  clickEffect?: 'dialog' | 'popup' | 'navigation' | 'none' | null;
}

interface TimingResult {
  inp?: number | null;
  lcpSrc?: string | null;
  lcpUrl?: string | null;
  lcpKind?: 'image' | 'text' | 'unknown' | string | null;
  /** Genuine largest-contentful-paint observer entry (null when never fired). */
  lcpEntry?: { startTime: number; url: string | null; renderMs: number | null; tag: string | null } | null;
  /** Real in-page viewport (overflowing content can expand it past 390x844). */
  vw?: number | null;
  vh?: number | null;
  title: string | null;
  ttfb: number | null;
  dcl: number | null;
  load: number | null;
  lcp: number | null;
  cls: number | null;
  overflow: number;
  navPresent: boolean;
  resources: { url: string; type: string; bytes: number; durationMs: number }[];
}

/**
 * Multi-signal CTA detection runs from a plain-string script
 * (browser-scripts.ts): tsx-compiled closures can reference module helpers
 * that do not exist in the page, silently yielding empty results.
 */
async function detectCtas(page: Page, vp: { width: number; height: number }): Promise<RawCta[]> {
  const args = JSON.stringify({ kws: CTA_KEYWORDS, vw: vp.width, vh: vp.height });
  const raw = (await page.evaluate(`(${DETECT_CTAS_JS})(${args})`).catch(() => [])) as unknown;
  return Array.isArray(raw) ? (raw as RawCta[]) : [];
}

function toObservation(raw: RawCta): CtaObservation {
  // Multi-signal upgrade: a real click listener rescues clickability even when
  // the href was swapped by a tracking script after first paint.
  const clickable = raw.clickable || raw.hasClickListener === true;
  const signals: CtaSignals = {
    domFound: true,
    displayed: raw.displayed,
    visibilityVisible: raw.visibilityVisible,
    opacityVisible: raw.opacityVisible,
    hasSize: raw.hasSize,
    box: raw.box,
    inViewport: raw.inViewport,
    notClipped: raw.notClipped,
    hitTestPass: raw.hitTestPass,
    clickable,
    inMenu: raw.inMenu,
  };
  const v = decideCta(signals);
  return {
    text: raw.text,
    aria: raw.aria,
    href: raw.href,
    tag: raw.tag,
    role: raw.role,
    inMenu: raw.inMenu,
    stickyOrFloating: raw.stickyOrFloating,
    box: raw.box,
    displayed: raw.displayed,
    visibilityVisible: raw.visibilityVisible,
    opacityVisible: raw.opacityVisible,
    hasSize: raw.hasSize,
    inViewport: raw.inViewport,
    notClipped: raw.notClipped,
    hitTestPass: raw.hitTestPass,
    hitTestScore: raw.hitTestScore ?? null,
    cover: raw.cover ?? null,
    selector: raw.selector ?? null,
    clickable,
    clickEffect: raw.clickEffect ?? null,
    hasClickListener: raw.hasClickListener ?? null,
    hasOnClick: !!raw.hasOnClick,
    hasDataAction: !!raw.hasDataAction,
    overlaySuppressed: !!raw.overlaySuppressed,
    verdict: v.verdict,
    confidence: v.confidence,
    screenshotCrop: null,
  };
}

/**
 * Synthetic click dispatch (mobile pass, phone candidates only, max 3).
 * Fires a REAL trusted click on tel:/callto:/wtai: or phone-digit elements
 * and records the observable effect. 'dialog'|'popup'|'navigation' are
 * positive dial-proofs. 'none' is recorded but NEVER used as negative
 * evidence (desktop Chromium shows nothing for tel:). Never throws.
 * Runs after all screenshots so scrolling cannot desync evidence.
 */
async function dispatchPhoneClicks(page: Page, raw: RawCta[]): Promise<void> {
  const isDial = (h: string | null): boolean => !!h && /^(tel|callto|wtai):/i.test(h);
  const cands = raw
    .filter((r) => isDial(r.href) || /\d{10,}/.test(r.text ?? ''))
    .slice(0, 3);
  for (const r of cands) {
    try {
      if (!r.selector || r.selector.length < 2) {
        r.clickEffect = null;
        continue;
      }
      let effect: 'dialog' | 'popup' | 'navigation' | 'none' = 'none';
      const url0 = page.url();
      const onDialog = (d: { dismiss: () => Promise<void> }): void => {
        effect = 'dialog';
        d.dismiss().catch(() => undefined);
      };
      const onPopup = (): void => {
        if (effect === 'none') effect = 'popup';
      };
      page.once('dialog', onDialog as never);
      page.once('popup', onPopup as never);
      await page.click(r.selector, { timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      page.off('dialog', onDialog as never);
      page.off('popup', onPopup as never);
      if (effect === 'none') {
        try {
          if (page.url() !== url0) effect = 'navigation';
        } catch { /* closed page — keep 'none' */ }
      }
      r.clickEffect = effect;
    } catch {
      r.clickEffect = null;
    }
  }
}

/**
 * Best-effort CDP click-listener inspection (multi-signal clickability).
 * For each observed CTA (cap 12), resolves the element via its recorded
 * selector and asks DOMDebugger for active listeners. A `click` listener
 * marks hasClickListener=true. Never throws — scan continues on failure.
 */
async function enrichClickListeners(page: Page, raw: RawCta[]): Promise<void> {
  if (raw.length === 0) return;
  let session: Awaited<ReturnType<Page['context']>> extends never ? never : unknown = null;
  try {
    const ctx = page.context();
    const cdp = await (ctx as unknown as { newCDPSession(p: Page): Promise<{ send(m: string, p?: Record<string, unknown>): Promise<Record<string, unknown>>; detach(): Promise<void> }> }).newCDPSession(page);
    session = cdp;
    await cdp.send('Runtime.enable').catch(() => undefined);
    await cdp.send('DOMDebugger.enable').catch(() => undefined);
    for (const r of raw.slice(0, 12)) {
      try {
        if (!r.selector || r.selector.length < 2) continue;
        const evalRes = (await cdp
          .send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(r.selector)})`, objectGroup: 'cta-click-check' })
          .catch(() => null)) as { result?: { objectId?: string; subtype?: string } } | null;
        const objectId = evalRes?.result?.objectId;
        if (!objectId) continue;
        const lis = (await cdp
          .send('DOMDebugger.getEventListeners', { objectId })
          .catch(() => null)) as { listeners?: { type: string }[] } | null;
        const types = (lis?.listeners ?? []).map((l) => l.type);
        if (types.includes('click') || types.includes('mousedown') || types.includes('touchstart')) {
          r.hasClickListener = true;
          r.clickable = true;
        } else if (r.hasClickListener == null) {
          r.hasClickListener = false;
        }
        await cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
      } catch {
        /* per-element failure is fine */
      }
    }
    await (cdp.detach().catch(() => undefined) as Promise<unknown>);
  } catch {
    /* CDP unavailable (headful/Firefox) — in-page signals still stand */
  }
  void session;
}

/**
 * Forensic LCP join (Phase 2 + genuine entry): the observer's entry.url wins
 * over element-attribute guessing; resolution + pathname fallback as before.
 * Text LCP (null URL) returns a text marker — NEVER attempts a join, NEVER
 * crashes. CDN-safe via pathname fallback.
 */
function joinLcpAsset(
  pageUrl: string,
  measured: TimingResult,
): ViewportResult['lcpAsset'] {
  // Genuine entry first: text tag + null url = typography LCP, no join.
  const entry = measured.lcpEntry ?? null;
  if (entry && !entry.url) {
    return { url: '', bytesMB: 0, durationMs: 0, kind: 'text', renderMs: entry.renderMs };
  }
  const kind = measured.lcpKind === 'image' ? 'image' : measured.lcpKind === 'text' ? 'text' : 'unknown';
  const rawUrl = (entry?.url ?? (typeof measured.lcpUrl === 'string' ? measured.lcpUrl : null));
  if (!rawUrl) {
    if (kind === 'text') return { url: '', bytesMB: 0, durationMs: 0, kind: 'text' };
    return null;
  }
  let abs = rawUrl;
  try {
    abs = new URL(rawUrl, pageUrl).href;
  } catch {
    abs = rawUrl;
  }
  const res = measured.resources ?? [];
  let hit = res.find((r) => r.url === abs);
  if (!hit) {
    try {
      const want = new URL(abs).pathname;
      hit = res.find((r) => {
        try {
          return new URL(r.url).pathname === want;
        } catch {
          return false;
        }
      });
    } catch {
      hit = undefined;
    }
  }
  if (!hit) return { url: abs.slice(0, 400), bytesMB: 0, durationMs: 0, kind: 'other', renderMs: entry?.renderMs ?? null };
  return {
    url: hit.url.slice(0, 400),
    bytesMB: Math.round((hit.bytes / 1048576) * 100) / 100,
    durationMs: hit.durationMs,
    kind: 'image',
    renderMs: entry?.renderMs ?? null,
  };
}

/**
 * Per-problem close-up clips (Module: visual evidence per finding).
 * Primary path is SELECTOR-based: Playwright scrolls the real element into
 * view and screenshots it (robust against viewport/layout coordinate skew).
 * The element gets a red outline first; box-clip math is the fallback for
 * targets whose selector resolves to nothing.
 * Bounded (max 8, best-effort per target) — failures skip silently.
 */
export interface EvTarget {
  kind: 'phone' | 'overflow' | 'cta';
  box: { x: number; y: number; width: number; height: number };
  selector?: string | null;
}

export async function captureEvShots(
  page: Page,
  dir: string,
  targets: EvTarget[],
  vp: { width: number; height: number } = { width: 390, height: 844 },
): Promise<{ file: string; kind: string; box: EvTarget['box'] }[]> {
  const out: { file: string; kind: string; box: EvTarget['box'] }[] = [];
  const counters: Record<EvTarget['kind'], number> = { phone: 0, overflow: 0, cta: 0 };
  type SharpInstance = { webp(o: { quality: number }): { toFile(p: string): Promise<unknown> } };
  type SharpFn = (buf: Buffer) => SharpInstance;
  let sharp: SharpFn | null = null;
  try {
    sharp = ((await import('sharp')).default as unknown) as SharpFn;
  } catch {
    return out;
  }
  const sh: SharpFn | null = sharp;
  if (!sh) return out;
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    return out;
  }
  const save = async (buf: Buffer, file: string): Promise<boolean> => {
    try {
      await sh(buf).webp({ quality: 80 }).toFile(path.join(dir, file));
      return true;
    } catch {
      return false;
    }
  };
  const PAD = 16;
  for (const t of targets.slice(0, 8)) {
    const b = t.box;
    if (!b || b.width <= 0 || b.height <= 0) continue;
    const file = `ev-${t.kind}-${counters[t.kind]++}.webp`;
    const doneBox = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    // Path 1: selector element shot (scroll + outline handled by Playwright).
    if (t.selector) {
      try {
        const el = await page.$(t.selector).catch(() => null);
        if (el) {
          // Inset ring (inside the element box — always visible in element
          // shots) + outline (visible in wider captures).
          await el.evaluate((node) => {
            try {
              const st = (node as HTMLElement).style;
              st.setProperty('outline', '4px solid #dc2626', 'important');
              st.setProperty('outline-offset', '2px', 'important');
              st.setProperty('box-shadow', 'inset 0 0 0 4px #dc2626', 'important');
            } catch { /* never fail the shot */ }
          }).catch(() => undefined);
          await el.scrollIntoViewIfNeeded().catch(() => undefined);
          await page.waitForTimeout(250);
          const buf = await el.screenshot({ timeout: 15000 }).catch(() => null);
          await el.evaluate((node) => {
            try {
              const st = (node as HTMLElement).style;
              st.removeProperty('outline');
              st.removeProperty('outline-offset');
              st.removeProperty('box-shadow');
            } catch { /* never fail the shot */ }
          }).catch(() => undefined);
          if (buf && await save(buf as Buffer, file)) {
            out.push({ file, kind: t.kind, box: doneBox });
            continue;
          }
        }
      } catch {
        /* fall through to box-clip */
      }
    }
    // Path 2: box-clip fallback (works when the box sits inside 390x844 capture).
    try {
      await page.evaluate(`(function(b){
        try {
          var old = document.getElementById('cls-ev-mark');
          if (old && old.parentNode) old.parentNode.removeChild(old);
          var d = document.createElement('div');
          d.id = 'cls-ev-mark';
          d.setAttribute('style', 'position:absolute;left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.width + 'px;height:' + b.height + 'px;border:4px solid #dc2626;box-sizing:border-box;z-index:2147483647;pointer-events:none;margin:0;padding:0;');
          document.body.appendChild(d);
        } catch (e) {}
      })(${JSON.stringify(doneBox)})`).catch(() => undefined);
      const wantY = Math.max(0, doneBox.y - 140);
      await page.evaluate(`window.scrollTo(0, ${wantY})`).catch(() => undefined);
      await page.waitForTimeout(250);
      const sy = (await page.evaluate('window.scrollY').catch(() => wantY)) as number;
      const vy = doneBox.y - (typeof sy === 'number' ? sy : wantY);
      const cx = Math.max(0, doneBox.x - PAD);
      const cy = Math.max(0, vy - PAD);
      const cw = Math.min(vp.width - cx, doneBox.width + PAD * 2);
      const ch = Math.min(vp.height - cy, doneBox.height + PAD * 2);
      if (cw < 8 || ch < 8) continue;
      const buf = await page.screenshot({ clip: { x: cx, y: cy, width: cw, height: ch }, timeout: 15000 });
      if (await save(buf, file)) {
        out.push({ file, kind: t.kind, box: doneBox });
      }
    } catch {
      /* one bad target never stops the rest */
    } finally {
      await page.evaluate(`(function(){
        try { var old = document.getElementById('cls-ev-mark'); if (old && old.parentNode) old.parentNode.removeChild(old); } catch (e) {}
      })()`).catch(() => undefined);
    }
  }
  await page.evaluate('window.scrollTo(0, 0)').catch(() => undefined);
  return out;
}

async function runViewport(
  url: string,
  name: ViewportName,
  scanId: number,
  opts: { scrollThrough?: boolean; shotTag?: string } = {},
): Promise<ViewportResult> {
  const vp = VIEWPORTS[name];
  const b = await getBrowser();
  // Real mobile physics: touch + mobile viewport (not just a narrow window).
  // Desktop/tablet stay plain viewports — only mobile emulates a handset.
  // Locale/timezone/language are set so the fingerprint reads as a normal
  // US visitor instead of a headless datacenter bot.
  const ctx = await b.newContext({
    viewport: vp,
    userAgent: name === 'mobile' ? mobileUA() : desktopUA(),
    javaScriptEnabled: true,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    ...(name === 'mobile' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  // Plain string: must parse verbatim in the page.
  await ctx.addInitScript(INIT_SCRIPT_JS);
  await ctx.addInitScript(VISITOR_MASK_JS);
  // Google web-vitals (canonical LCP/CLS/INP + attribution). Best-effort:
  // if the file is missing, the hand observer in INIT_SCRIPT_JS still stands.
  for (const cand of [
    'node_modules/web-vitals/dist/web-vitals.iife',
    'backend/node_modules/web-vitals/dist/web-vitals.iife',
  ]) {
    try {
      const resolved = path.resolve(process.cwd(), cand);
      if (!existsSync(resolved)) continue;
      await ctx.addInitScript({ path: resolved });
      break;
    } catch {
      /* try next candidate; hand observer remains */
    }
  }

  const page = await ctx.newPage();
  const jsErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: { url: string; reason: string }[] = [];
  const seenRequestUrls: string[] = [];
  page.on('pageerror', (err) => {
    if (jsErrors.length < 10) jsErrors.push(String(err).slice(0, 300));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' && consoleErrors.length < 10) {
      consoleErrors.push(msg.text().slice(0, 300));
    }
  });
  page.on('requestfailed', (req) => {
    if (failedRequests.length < 15) {
      failedRequests.push({ url: req.url().slice(0, 300), reason: req.failure()?.errorText ?? 'failed' });
    }
  });
  page.on('request', (req) => {
    if (seenRequestUrls.length < 200) seenRequestUrls.push(req.url().slice(0, 300));
  });

  const base: ViewportResult = {
    name,
    width: vp.width,
    height: vp.height,
    title: null,
    loadError: null,
    jsErrors,
    consoleErrors,
    failedRequests,
    horizontalOverflow: false,
    overflowWidth: 0,
    hiddenCtaCount: 0,
    navPresent: false,
    aboveFold: null,
    ctaObservations: [],
    screenshotPath: null,
    fullScreenshotPath: null,
    heroCropPath: null,
    annotatedCropPath: null,
    phoneHitTest: null,
    overflowOffender: null,
    ttfbMs: null,
    domContentLoadedMs: null,
    loadMs: null,
    lcpMs: null,
    cls: null,
    resources: [],
  };

  try {
    // Anti-hang resource defense (Master Directive §4): abort streaming
    // video/backgrounds that hang networkidle on chatbot/video-heavy sites.
    // Render-safe: stylesheets/fonts/images/scripts still load; only
    // media-stream payloads (mp4/webm/m3u8) are dropped. Navigation stays
    // 30s — slow sites fail gracefully as blocked/unreachable, never hang.
    await page.route(
      '**/*.{mp4,webm,m3u8,mov}',
      (route) => void route.abort().catch(() => undefined),
    ).catch(() => undefined);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    if (!resp) {
      base.loadError = 'Navigation produced no response';
      return base;
    }
    if (resp.status() === 403 || resp.status() === 429) {
      const body = (await page.content().catch(() => '')).slice(0, 4000).toLowerCase();
      if (/captcha|cloudflare|just a moment|verify you are human|are you a robot|datadome|perimeterx/.test(body)) {
        base.loadError = `Blocked by bot protection (HTTP ${resp.status()})`;
        return base;
      }
    }
    // Deterministic stabilization (human-level accuracy): NEVER audit right
    // after DOMContentLoaded. Await full load + webfont readiness, then a
    // 1.5s post-load settle so client hydration (React/Elementor) and sticky
    // header animations finish before any measurement or hit-test.
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => undefined);
    try {
      await page.evaluate('document.fonts.ready.then(function(){return 1;})').catch(() => undefined);
    } catch {
      /* fonts API missing — settle delay below still applies */
    }
    await page.waitForTimeout(1500);
    if (opts.scrollThrough) {
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)').catch(() => undefined);
      await page.waitForTimeout(800);
      await page.evaluate('window.scrollTo(0, 0)').catch(() => undefined);
      await page.waitForTimeout(800);
    } else {
      await page.waitForTimeout(2000);
    }
    // Dynamic call-tracking settle guard: CallRail/Ringba/Invoca swap number
    // text + tel: hrefs AFTER first paint. When their scripts are present in
    // network traffic or DOM, wait a deterministic 1500ms window and THEN
    // observe — observations below always read the settled DOM.
    try {
      const netHit = seenRequestUrls.some((u) =>
        TRACKING_KEYWORDS.some((k) => u.toLowerCase().includes(k)),
      );
      const domHit = netHit
        ? true
        : ((await page
            .evaluate(
              `(function(){try{var h=document.documentElement.outerHTML.slice(0,200000).toLowerCase();var ks=${JSON.stringify(TRACKING_KEYWORDS)};for(var i=0;i<ks.length;i++){if(h.indexOf(ks[i])!==-1)return true;}return false;}catch(e){return false;}})()`,
            )
            .catch(() => false)) as boolean);
      if (netHit || domHit) {
        await page.waitForTimeout(1500);
      }
    } catch {
      /* settle guard must never fail the viewport */
    }

    // Pre-flight overlay dismissal (Master Directive §1): a human taps X /
    // Accept first, then tests buttons. Clicks bounded (6 max, no nav wait);
    // survivors get CSS-hidden. Runs BEFORE timing + CTA detection so the
    // hit-test sees the real layout, not the cookie modal.
    try {
      const dismissed = (await page
        .evaluate(`(${DISMISS_OVERLAYS_JS})(${JSON.stringify({ vw: vp.width, vh: vp.height })})`)
        .catch(() => null)) as { clicked?: number; hidden?: number } | null;
      if (dismissed && ((dismissed.clicked ?? 0) > 0 || (dismissed.hidden ?? 0) > 0)) {
        await page.waitForTimeout(600);
      }
    } catch {
      /* dismisser must never fail the viewport */
    }

    // Device width for in-page overflow gates (layout viewport may expand).
    await page.evaluate(`window.__deviceVw = ${vp.width}`).catch(() => undefined);
    const measured = (await page.evaluate(TIMING_JS).catch(() => null)) as TimingResult | null;
    // Real viewport for every downstream probe (never the assumed 390x844).
    const realVw = typeof measured?.vw === 'number' && measured.vw > 0 ? Math.round(measured.vw) : vp.width;
    const realVh = typeof measured?.vh === 'number' && measured.vh > 0 ? Math.round(measured.vh) : vp.height;
    if (measured) {
      base.title = measured.title?.slice(0, 200) ?? null;
      base.ttfbMs = measured.ttfb;
      base.domContentLoadedMs = measured.dcl;
      base.loadMs = measured.load;
      base.lcpMs = measured.lcp != null ? Math.round(measured.lcp) : null;
      base.cls = measured.cls != null ? Math.round(measured.cls * 1000) / 1000 : null;
      base.inpMs = typeof measured.inp === 'number' ? Math.round(measured.inp) : null;
      // Genuine observer tag wins for element identity (never guessed).
      base.lcpElement = typeof measured.lcpSrc === 'string'
        ? measured.lcpSrc
        : (measured.lcpEntry?.tag ? `lcp:${measured.lcpEntry.tag}` : null);
      // 5px tolerance: sub-pixel rounding is not a layout bug.
      base.horizontalOverflow = measured.overflow > 5;
      base.overflowWidth = measured.overflow;
      base.navPresent = measured.navPresent;
      base.resources = measured.resources as ResourceEntry[];
      base.lcpAsset = joinLcpAsset(url, measured);
    }

    // Multi-signal CTA pass (overlay-suppressed hit-tests inside the page
    // script) + CDP click-listener enrichment. Detection only — no element
    // crops are captured here (per-problem close-ups come later in evShots).
    const rawCtas = await detectCtas(page, { width: realVw, height: realVh });
    await enrichClickListeners(page, rawCtas);
    let observations = rawCtas.map(toObservation);
    const dir = shotDir(scanId);
    // Evidence filename tag. The recheck pass MUST NOT overwrite the main
    // pass files — the hero image must come from the same pass as the
    // timings/observations the findings reference.
    const tag = opts.shotTag ?? name;
    // B3: axe target-size on the same live page (mobile only, best-effort).
    if (name === 'mobile' && !base.loadError) {
      try {
        const { runTargetSize } = await import('./accessibility');
        base.targetSize = await runTargetSize(page);
      } catch {
        base.targetSize = null;
      }
    }
    // No layout-shift pixel-diff: it needed the (removed) viewport PNG.
    // CLS from web-vitals above remains the signal.
    base.layoutShiftPct = null;
    base.ctaObservations = observations;
    base.hiddenCtaCount = observations.filter(
      (o) => o.verdict === 'HIDDEN' || o.verdict === 'COVERED' || o.verdict === 'ZERO_SIZE',
    ).length;

    // Module-2 phone hit-test + Module-4 overflow offender (settled DOM,
    // mobile pass only): real-browser visibility, selector + box evidence.
    // Never throws — findings fall back to crawler signals without them.
    if (name === 'mobile' && !base.loadError) {
      try {
        const hit = (await page
          .evaluate(`(${PHONE_HITTEST_JS})(${JSON.stringify({ vh: realVh })})`)
          .catch(() => null)) as ViewportResult['phoneHitTest'];
        if (hit && Array.isArray(hit.offenders)) {
          base.phoneHitTest = {
            offenders: hit.offenders.slice(0, 10),
            proofs: Array.isArray(hit.proofs) ? hit.proofs.slice(0, 10) : [],
          };
        }
      } catch {
        /* crawler phone signals still stand */
      }
      try {
        const offender = (await page
          .evaluate(`(${OVERFLOW_OFFENDER_JS})()`)
          .catch(() => null)) as ViewportResult['overflowOffender'];
        if (offender && typeof offender.overflowPx === 'number') {
          base.overflowOffender = offender;
        }
      } catch {
        /* scrollWidth fallback below still stands */
      }
    }

    // Above-the-fold from validated observations (not heuristics).
    const foldVisible = observations.some((o) => {
      if (!o.box || o.verdict !== 'VISIBLE') return false;
      return o.box.y >= 0 && o.box.y < realVh;
    });
    const phoneInFold = (await page
      .evaluate(`(${ABOVE_FOLD_PHONE_JS})(${JSON.stringify({ vh: realVh })})`)
      .catch(() => false)) as boolean;
    base.aboveFold = {
      ctaVisible: foldVisible,
      phoneVisible: phoneInFold === true,
      ctaCount: observations.length,
    };

    if (base.title && BLOCK_TITLE_RE.test(base.title)) {
      base.loadError = `Possible bot-protection page (title: ${base.title.slice(0, 80)})`;
      return base;
    }

    // Hero captures (one per viewport): the outreach-visible proof that
    // the scan really looked at the page. Mobile 390x1300 is the money
    // shot; tablet/desktop ride along cheaply so the Evidence tab can show
    // every viewport. Recheck passes (shotTag) skip it: evidence must come
    // from the main pass.
    if (!opts.shotTag && !base.loadError) {
      // Settled DOM snapshot (mobile homepage): feeds phone/form
      // extractors a second time so JS-injected numbers and forms that
      // static fetch never sees still get detected downstream.
      if (name === 'mobile') {
        try {
          const dom = await page.content().catch(() => '');
          base.renderedHtml = dom && dom.length > 1000 ? dom.slice(0, 2_000_000) : null;
        } catch {
          base.renderedHtml = null;
        }
      }
      try {
        await fs.mkdir(dir, { recursive: true });
        await page.setViewportSize({ width: vp.width, height: 1300 });
        await page.evaluate('window.scrollTo(0, 0)').catch(() => undefined);
        await page.waitForTimeout(300);
        const heroBuf = await page.screenshot({ timeout: 15000 });
        const { default: sharp } = await import('sharp');
        await sharp(heroBuf).webp({ quality: 80 }).toFile(path.join(dir, `${tag}-hero.webp`));
        base.heroCropPath = path.join(dir, `${tag}-hero.webp`);
      } catch {
        /* hero is optional — findings still stand without it */
      } finally {
        await page.setViewportSize({ width: vp.width, height: vp.height }).catch(() => undefined);
        await page.evaluate('window.scrollTo(0, 0)').catch(() => undefined);
      }
    }
    // Module-5 visual evidence highlighter: red-outline critical offenders
    // on a SEPARATE annotated copy (plain hero stays untouched for AI).
    // Offenders: phone plain-text numbers + overflow element + elements
    // covering the primary CTA. Outline removed immediately after capture.
    if (name === 'mobile' && !opts.shotTag && !base.loadError) {
      try {
        const targets: string[] = [];
        for (const o of base.phoneHitTest?.offenders ?? []) {
          if (o.selector && targets.length < 8) targets.push(o.selector);
        }
        if (base.overflowOffender?.selector && targets.length < 8) {
          targets.push(base.overflowOffender.selector);
        }
        for (const o of observations) {
          if (targets.length >= 8) break;
          if ((o.verdict === 'COVERED' || o.verdict === 'HIDDEN') && o.cover?.selector) {
            targets.push(o.cover.selector);
          }
        }
        if (targets.length > 0) {
          await fs.mkdir(dir, { recursive: true });
          await page.evaluate(`(function(sels){
            window.__hlMarked = [];
            for (var i = 0; i < sels.length; i++) {
              try {
                var el = document.querySelector(sels[i]);
                if (!el || !(el instanceof Element)) continue;
                el.setAttribute('data-cls-hl', '1');
                el.style.setProperty('outline', '4px solid #dc2626', 'important');
                el.style.setProperty('outline-offset', '2px', 'important');
                window.__hlMarked.push(el);
              } catch (e) {}
            }
          })(${JSON.stringify(targets)})`).catch(() => undefined);
          await page.setViewportSize({ width: vp.width, height: 1300 });
          await page.evaluate('window.scrollTo(0, 0)').catch(() => undefined);
          await page.waitForTimeout(300);
          const annBuf = await page.screenshot({ timeout: 15000 });
          const { default: sharp } = await import('sharp');
          await sharp(annBuf).webp({ quality: 80 }).toFile(path.join(dir, `${tag}-hero-annotated.webp`));
          base.annotatedCropPath = path.join(dir, `${tag}-hero-annotated.webp`);
        }
      } catch {
        /* annotated shot is optional — plain hero + findings still stand */
      } finally {
        await page
          .evaluate(`(function(){
            try {
              var marked = window.__hlMarked || [];
              for (var i = 0; i < marked.length; i++) {
                marked[i].style.removeProperty('outline');
                marked[i].style.removeProperty('outline-offset');
                marked[i].removeAttribute('data-cls-hl');
              }
              window.__hlMarked = [];
            } catch (e) {}
          })()`)
          .catch(() => undefined);
        await page.setViewportSize({ width: vp.width, height: vp.height }).catch(() => undefined);
        await page.evaluate('window.scrollTo(0, 0)').catch(() => undefined);
      }
    }
    // can move elements between first detection and the hero capture, so the
    // stored observations could describe a stale layout. Re-observe once.
    // Per-problem close-up clips (red-marked, same pass as the findings).
    // Priority: phone plain-text numbers → overflow offender → covered CTAs.
    // Viewport is 390x844 here (hero blocks restore it). Best-effort.
    if (name === 'mobile' && !opts.shotTag && !base.loadError) {
      try {
        const targets: EvTarget[] = [];
        for (const o of base.phoneHitTest?.offenders ?? []) {
          if (o.box && targets.length < 8) targets.push({ kind: 'phone', box: o.box, selector: o.selector ?? null });
        }
        const ov = base.overflowOffender;
        if (ov && targets.length < 8) {
          targets.push({ kind: 'overflow', box: ov.rect, selector: ov.selector ?? null });
        }
        for (const o of observations) {
          if (targets.length >= 8) break;
          if (o.verdict === 'COVERED' && o.box && o.box.width > 0 && o.box.height > 0) {
            targets.push({ kind: 'cta', box: o.box, selector: o.selector ?? o.cover?.selector ?? null });
          }
        }
        if (targets.length > 0) {
          base.evShots = await captureEvShots(page, dir, targets, { width: realVw, height: realVh });
        }
      } catch {
        /* close-ups optional — annotated hero + findings still stand */
      }
    }
    // Settle refresh: late layout shifts (webfonts, heavy page builders)
    // can move elements between first detection and the hero capture, so the
    // stored observations could describe a stale layout. Re-observe once.
    try {
      const freshRaw = await detectCtas(page, { width: realVw, height: realVh });
      if (freshRaw.length > 0) {
        await enrichClickListeners(page, freshRaw);
        // Synthetic clicks AFTER screenshots: mobile phone candidates only.
        if (name === 'mobile' && !base.loadError) {
          await dispatchPhoneClicks(page, freshRaw);
        }
        const fresh = freshRaw.map(toObservation);
        observations = fresh;
        base.ctaObservations = observations;
        base.hiddenCtaCount = observations.filter(
          (o) => o.verdict === 'HIDDEN' || o.verdict === 'COVERED' || o.verdict === 'ZERO_SIZE',
        ).length;
        const foldNow = observations.some((o) => {
          if (!o.box || o.verdict !== 'VISIBLE') return false;
          return o.box.y >= 0 && o.box.y < realVh;
        });
        const phoneNow = (await page
          .evaluate(`(${ABOVE_FOLD_PHONE_JS})(${JSON.stringify({ vh: realVh })})`)
          .catch(() => null)) as boolean | null;
        base.aboveFold = {
          ctaVisible: foldNow,
          phoneVisible: typeof phoneNow === 'boolean' ? phoneNow : (base.aboveFold?.phoneVisible ?? false),
          ctaCount: observations.length,
        };
      }
    } catch {
      /* keep first-pass observations */
    }
    return base;
  } catch (err) {
    base.loadError = err instanceof Error ? err.message.slice(0, 300) : String(err);
    return base;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * MODULES 7+8+15–18 — desktop + tablet + mobile pass.
 * Never bypasses bot protection: blocking is reported, not evaded.
 */
export async function runBrowser(url: string, scanId: number): Promise<BrowserResult> {
  const desktop = await runViewport(url, 'desktop', scanId);
  const tablet = await runViewport(url, 'tablet', scanId);
  const mobile = await runViewport(url, 'mobile', scanId);
  const blocked =
    /blocked|bot protection|captcha|cloudflare/i.test(desktop.loadError ?? '') &&
    /blocked|bot protection|captcha|cloudflare/i.test(mobile.loadError ?? '');
  return { desktop, tablet, mobile, blocked, blockedReason: blocked ? desktop.loadError : null };
}

/**
 * Recheck pass (§20): when the first mobile pass found no CTA at all but
 * other detectors did, scroll through the page and look again before any
 * "missing" claim is allowed.
 */
export async function recheckMobileCtas(url: string, scanId: number): Promise<CtaObservation[]> {
  const second = await runViewport(url, 'mobile', scanId, { scrollThrough: true, shotTag: 'mobile-recheck' });
  // Keep the scroll-through screenshots out of the evidence set.
  for (const o of second.ctaObservations) o.screenshotCrop = null;
  return second.ctaObservations;
}
