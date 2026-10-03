/**
 * In-browser scripts as PLAIN STRINGS. Playwright serializes callbacks via
 * toString(); tsx-compiled functions can reference module-scope helpers
 * (e.g. __name) that do not exist in the page — a silent empty-result bug.
 * Strings are parsed verbatim by the browser: what you read is what runs.
 * No TypeScript syntax inside — it must parse as browser JavaScript.
 */

export const INIT_SCRIPT_JS = `
(() => {
  window.__lcpMs = undefined;
  window.__lcpEntry = null;
  window.__cls = 0;
  window.__wv = null;
  try {
    var wv = window.webVitals;
    if (wv) {
      var store = {};
      var save = function (m) {
        try {
          store[m.name] = {
            value: m.value,
            el: (m.attribution && (m.attribution.lcpEntry || m.attribution.largestShiftTarget || m.attribution.eventTarget)) || null,
          };
          window.__wv = store;
        } catch (e) {}
      };
      if (wv.onLCP) wv.onLCP(save, { reportAllChanges: true });
      if (wv.onCLS) wv.onCLS(save, { reportAllChanges: true });
      if (wv.onINP) wv.onINP(save, { reportAllChanges: true });
    }
  } catch (e) { /* web-vitals absent — hand observer below still stands */ }
  try {
    // Genuine largest-contentful-paint entries: element + url + renderTime.
    // Never guessed from CSS selectors or img tags — this IS the paint event.
    var lcp = new PerformanceObserver(function (list) {
      var es = list.getEntries();
      for (var i = 0; i < es.length; i++) {
        var en = es[i];
        window.__lcpMs = en.startTime;
        try {
          var el = en.element || null;
          window.__lcpEntry = {
            startTime: en.startTime,
            url: en.url || null,
            renderTime: en.renderTime || null,
            loadTime: en.loadTime || null,
            tag: el && el.tagName ? String(el.tagName).toLowerCase() : null,
          };
        } catch (e) { /* entry shape varies — timing still stands */ }
      }
    });
    lcp.observe({ type: 'largest-contentful-paint', buffered: true });
    var cls = new PerformanceObserver(function (list) {
      var v = window.__cls || 0;
      var es = list.getEntries();
      for (var i = 0; i < es.length; i++) {
        if (!es[i].hadRecentInput) v += es[i].value || 0;
      }
      window.__cls = v;
    });
    cls.observe({ type: 'layout-shift', buffered: true });
  } catch (e) { /* observers unsupported — metrics stay null */ }
})();
`;

/**
 * Visitor mask: hides the stock Playwright automation flags so bot-filters
 * that key on `navigator.webdriver` stop refusing the audit pass.
 * Passive presentation only — no challenge is read, clicked, or solved;
 * Cloudflare Turnstile/CAPTCHA pages still report as blocked downstream.
 * No TypeScript syntax inside — plain browser JavaScript.
 */
export const VISITOR_MASK_JS = `
(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: function () { return false; } });
  } catch (e) {}
  try {
    if (!window.chrome) window.chrome = { runtime: {} };
    else if (!window.chrome.runtime) window.chrome.runtime = {};
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'languages', { get: function () { return ['en-US', 'en']; } });
  } catch (e) {}
})();
`;

export const TIMING_JS = `
(() => {
  var t = performance.getEntriesByType('navigation')[0];
  var doc = document.documentElement;
  // Device width for the overflow gate (set by the runner before eval):
  // overflowing content can expand the layout viewport, so innerWidth lies.
  var deviceVw = typeof window.__deviceVw === 'number' && window.__deviceVw > 0 ? window.__deviceVw : window.innerWidth;
  var lcpEl = null;
  try { lcpEl = (window.__wv && window.__wv.LCP ? window.__wv.LCP.el : null); } catch (e) { lcpEl = null; }
  var lcpInfo = (function () {
    try {
      if (!lcpEl) return { src: null, url: null, kind: 'unknown' };
      var tag = (lcpEl.tagName || '').toLowerCase();
      // Text LCP (h1/h2/p): no image URL — caller MUST NOT join resources[].
      if (tag === 'h1' || tag === 'h2' || tag === 'p' || tag === 'span' || tag === 'div') {
        var bg = '';
        try { bg = window.getComputedStyle(lcpEl).getPropertyValue('background-image') || ''; } catch (e) {}
        var m = /url\\(["']?([^"')]+)["']?\\)/i.exec(bg || '');
        if (m && m[1] && m[1].indexOf('data:') !== 0) {
          var abs = m[1];
          try { abs = new URL(m[1], location.href).toString(); } catch (e) {}
          return { src: null, url: abs, kind: 'image' };
        }
        return { src: null, url: null, kind: 'text' };
      }
      var raw = null;
      try {
        if (tag === 'img' && lcpEl.currentSrc) raw = lcpEl.currentSrc;
        else if (lcpEl.src) raw = lcpEl.src;
        else if (tag === 'video' && lcpEl.poster) raw = lcpEl.poster;
        else if (tag === 'video' && lcpEl.currentSrc) raw = lcpEl.currentSrc;
      } catch (e) { raw = null; }
      if (!raw) return { src: null, url: null, kind: 'text' };
      var absUrl = raw;
      try { absUrl = new URL(raw, location.href).toString(); } catch (e) {}
      return { src: null, url: absUrl, kind: 'image' };
    } catch (err) { return { src: null, url: null, kind: 'unknown' }; }
  })();
  return {
    title: document.title || null,
    // Real in-page viewport: overflowing content can expand the layout
    // viewport beyond the emulated 390x844 — never assume, always measure.
    vw: window.innerWidth,
    vh: window.innerHeight,
    ttfb: t ? Math.round(t.responseStart - t.requestStart) : null,
    dcl: t ? Math.round(t.domContentLoadedEventEnd - t.startTime) : null,
    load: t ? Math.round(t.loadEventEnd - t.startTime) : null,
    lcp: (window.__wv && window.__wv.LCP ? window.__wv.LCP.value : (window.__lcpMs != null ? window.__lcpMs : null)),
    // Genuine observer entry (null when the observer never fired).
    lcpEntry: (function () {
      try {
        var en = window.__lcpEntry;
        if (!en || en.startTime == null) return null;
        return {
          startTime: Math.round(en.startTime),
          url: typeof en.url === 'string' && en.url ? en.url.slice(0, 400) : null,
          renderMs: en.renderTime != null ? Math.round(en.renderTime) : (en.loadTime != null ? Math.round(en.loadTime) : null),
          tag: typeof en.tag === 'string' ? en.tag.slice(0, 20) : null,
        };
      } catch (e) { return null; }
    })(),
    cls: (window.__wv && window.__wv.CLS ? window.__wv.CLS.value : (window.__cls != null ? window.__cls : null)),
    inp: (window.__wv && window.__wv.INP ? window.__wv.INP.value : null),
    lcpSrc: (function () {
      try {
        var e = lcpEl;
        if (!e) return null;
        var s = (e.tagName || '?').toLowerCase();
        var id = e.id ? '#' + e.id : '';
        var cls = e.className && e.className.baseVal === undefined ? String(e.className).split(' ')[0] : '';
        return (s + id + (cls ? '.' + cls : '')).slice(0, 80);
      } catch (err) { return null; }
    })(),
    lcpUrl: lcpInfo.url,
    lcpKind: lcpInfo.kind,
    // Overflow is measured against the DEVICE width: overflowing content can
    // expand the layout viewport, so innerWidth lies. Rects and vw/vh below
    // stay in real in-page coords for probes and clips.
    overflow: Math.max(doc.scrollWidth - deviceVw, 0),
    navPresent: document.querySelector('nav,[role="navigation"]') !== null ||
      document.querySelectorAll('header a').length >= 2,
    resources: performance.getEntriesByType('resource').slice(0, 120).map(function (r) {
      return {
        url: String(r.name).slice(0, 400),
        type: r.initiatorType,
        bytes: Math.round(r.transferSize || r.encodedBodySize || 0),
        durationMs: Math.round(r.duration),
      };
    }),
  };
})();
`;

export const OVERLAY_SELECTORS_JS = `
(function () {
  var sels = [
    '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i]',
    '[id*="gdpr" i],[class*="gdpr" i],#onetrust-banner-sdk,.onetrust-pc-dark-filter',
    '#trustarc,[class*="trustarc" i],[class*="iubenda" i],#cookiebot,[class*="cookiebot" i]',
    '[class*="cc-window" i],[class*="cc-banner" i],[id*="cc-window" i]',
    '[id*="intercom" i],[class*="intercom" i],[id*="drift" i],[class*="drift-widget" i]',
    '[id*="zendesk" i],[class*="zendesk" i],[id*="crisp" i],[class*="crisp-client" i]',
    '[id*="tawk" i],[class*="tawk" i],[id*="hubspot-messages" i]',
    '[class*="chat-widget" i],[class*="chat-bubble" i],[class*="livechat" i]',
    '[class*="sticky-notification" i],[class*="notice-bar" i],[class*="promo-bar" i]'
  ];
  var n = 0;
  for (var i = 0; i < sels.length; i++) {
    var nodes = document.querySelectorAll(sels[i]);
    for (var j = 0; j < nodes.length; j++) {
      var el = nodes[j];
      if (el.getAttribute('data-cls-suppressed') === '1') continue;
      el.setAttribute('data-cls-suppressed', '1');
      try { el.style.setProperty('pointer-events', 'none', 'important'); } catch (e) {}
      n++;
    }
  }
  window.__clsOverlaysSuppressed = (window.__clsOverlaysSuppressed || 0) + n;
  return n;
})
`;

export const TRACKING_KEYWORDS = ['callrail', 'ringba', 'invoca', 'ctm', 'calltracking', 'whatconverts', 'calltrk', 'dialogtech'];

/**
 * Pre-flight overlay dismisser (Master Directive §1). Runs BEFORE CTA
 * hit-testing on mobile: a human taps X/Accept first, then tests buttons.
 * Order: (1) click X/close inside known overlay roots, (2) click
 * Accept/Agree/OK consent buttons, (3) CSS-hide remaining
 * position:fixed + z-index>=9999 elements covering >50% of the viewport.
 * Scan-only fresh context — consent cookies never leave the scan.
 * Bounded: max 6 clicks, visible-in-viewport elements only, never throws.
 */
export const DISMISS_OVERLAYS_JS = `
(function (args) {
  var vw = args.vw, vh = args.vh;
  var clicked = 0, hidden = 0;
  function visible(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false;
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      return true;
    } catch (e) { return false; }
  }
  function tryClick(el) {
    if (clicked >= 6) return false;
    if (!visible(el)) return false;
    try {
      el.click();
      clicked++;
      return true;
    } catch (e) { return false; }
  }
  try {
    // (1) X / close controls inside overlay roots.
    var closeSels = [
      '[id*="cookie" i] [aria-label*="clos" i],[class*="cookie" i] [aria-label*="clos" i]',
      '[id*="consent" i] [aria-label*="clos" i],[class*="consent" i] [aria-label*="clos" i]',
      '[id*="cookie" i] .close,[class*="cookie" i] .close,[class*="cc-close" i]',
      '[class*="modal" i] .close,[class*="popup" i] .close,[class*="modal" i] [aria-label*="clos" i]',
      '[id*="onetrust" i] .close,[class*="onetrust" i] .close'
    ];
    for (var si = 0; si < closeSels.length && clicked < 6; si++) {
      var nodes = document.querySelectorAll(closeSels[si]);
      for (var ni = 0; ni < nodes.length && clicked < 6; ni++) tryClick(nodes[ni]);
    }
    // (2) Consent accept buttons by visible text.
    var btns = document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]');
    for (var bi = 0; bi < btns.length && clicked < 6; bi++) {
      var b = btns[bi];
      var label = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.value || '')).replace(/\\s+/g, ' ').trim().toLowerCase();
      if (/^(accept|agree|allow all|i agree|ok|got it|accept all|allow cookies|accept cookies|dismiss|close)$/.test(label)) {
        var root = b;
        try {
          var p = b.parentElement;
          for (var d = 0; d < 3 && p; d++) {
            var pid = (p.id || '') + ' ' + (p.className && typeof p.className === 'string' ? p.className : '');
            if (/cookie|consent|gdpr|banner|notice|modal|popup|banner/i.test(pid)) { root = p; break; }
            p = p.parentElement;
          }
        } catch (e) {}
        if (visible(b)) tryClick(b);
      }
    }
    // (3) CSS-hide remaining giant fixed overlays (paywall/modal/backdrop).
    var all = document.querySelectorAll('body *');
    var area = vw * vh;
    for (var ai = 0; ai < all.length; ai++) {
      var el = all[ai];
      try {
        if (el.getAttribute('data-cls-hidden') === '1') continue;
        var cs = window.getComputedStyle(el);
        if (cs.position !== 'fixed') continue;
        var z = parseInt(cs.zIndex || '0', 10);
        if (isNaN(z) || z < 9999) continue;
        var r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if ((r.width * r.height) < area * 0.5) continue;
        el.setAttribute('data-cls-hidden', '1');
        el.style.setProperty('display', 'none', 'important');
        hidden++;
      } catch (e) {}
    }
  } catch (e) {}
  return { clicked: clicked, hidden: hidden };
})
`;

export const DETECT_CTAS_JS = `
(function (args) {
  var kws = args.kws, vw = args.vw, vh = args.vh;
  function norm(s) { return String(s || '').replace(/\\s+/g, ' ').trim(); }
  // Overlay mitigation FIRST: cookie/chat/sticky bars must not steal hit-tests.
  // A CTA covered only by a consent banner is NOT "not clickable".
  try {
    var sels = [
      '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i]',
      '[id*="gdpr" i],[class*="gdpr" i],#onetrust-banner-sdk,.onetrust-pc-dark-filter',
      '[class*="cc-window" i],[class*="cc-banner" i]',
      '[id*="intercom" i],[class*="intercom" i],[id*="drift" i],[class*="drift-widget" i]',
      '[id*="zendesk" i],[class*="zendesk" i],[id*="crisp" i],[class*="crisp-client" i]',
      '[id*="tawk" i],[class*="tawk" i],[id*="hubspot-messages" i]',
      '[class*="chat-widget" i],[class*="chat-bubble" i],[class*="livechat" i]'
    ];
    for (var si = 0; si < sels.length; si++) {
      var nodes = document.querySelectorAll(sels[si]);
      for (var ni = 0; ni < nodes.length; ni++) {
        try { nodes[ni].style.setProperty('pointer-events', 'none', 'important'); } catch (e) {}
      }
    }
  } catch (e) {}
  var els = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],[data-action],[onclick]'));
  var out = [];
  for (var i = 0; i < Math.min(els.length, 80); i++) {
    var el = els[i];
    var text = norm(el.textContent);
    var aria = norm(el.getAttribute('aria-label'));
    var title = norm(el.getAttribute('title'));
    var rawHref = el.tagName === 'A' ? norm(el.getAttribute('href')) : '';
    // Parent fallback (5 levels): tracking scripts often move tel: onto a wrapper.
    var parentHref = '';
    var parentOnclick = false;
    var parentAction = false;
    try {
      var p = el.parentElement;
      for (var depth = 0; depth < 5 && p; depth++) {
        if (p.tagName === 'A') {
          var ph = norm(p.getAttribute('href'));
          if (ph && !parentHref) parentHref = ph;
        }
        if (p.hasAttribute && p.hasAttribute('onclick')) parentOnclick = true;
        if (p.hasAttribute && (p.hasAttribute('data-action') || p.hasAttribute('data-call') || p.hasAttribute('data-phone'))) parentAction = true;
        if (typeof p.onclick === 'function') parentOnclick = true;
        p = p.parentElement;
      }
    } catch (e) {}
    if (!rawHref && parentHref) rawHref = parentHref;
    var hay = (text + ' ' + aria + ' ' + title + ' ' + rawHref).toLowerCase();
    var lowerHref = rawHref.toLowerCase();
    var isTel = lowerHref.indexOf('tel:') === 0 || lowerHref.indexOf('callto:') === 0 || lowerHref.indexOf('wtai:') === 0;
    var matched = false;
    for (var k = 0; k < kws.length; k++) {
      // Word-boundary match: bare 'call'/'book' must not fire inside
      // 'recall'/'facebook' (same rule as the crawler-side hasWord).
      var kw = String(kws[k] || '').toLowerCase().replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
      if (kw && new RegExp('\\b' + kw + '\\b').test(hay)) { matched = true; break; }
    }
    // Scan 140 fix: tel: links are NEVER skipped — even icon-only buttons
    // with empty text (SVG phone icon) must be observed. Identity falls back
    // to aria-label → title → phone-digits regex → href so the visible
    // "CALL NOW! 732-850-5720" header is captured as VISIBLE.
    if (!matched && !isTel && el.tagName !== 'INPUT') continue;
    // Enrich empty/icon-only text for tel: links before any skip logic.
    if (isTel && !text) {
      var telLabel = aria || title;
      if (!telLabel) {
        var digitsOnly = String(rawHref || '').replace(/[^0-9]/g, '');
        telLabel = digitsOnly.length >= 7 ? rawHref : 'Call now';
      }
      text = norm(telLabel);
    }
    var abs = null;
    try {
      if (rawHref && rawHref.charAt(0) !== '#' && rawHref.toLowerCase().indexOf('javascript:') !== 0) {
        abs = new URL(rawHref, location.href).toString();
      } else if (isTel) {
        abs = rawHref;
      }
    } catch (e) { abs = null; }
    var r = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    var inMenu = el.closest('[aria-expanded="false"],.mobile-menu:not(.open),.nav-collapsed,.menu-closed') !== null;
    var notClipped = true;
    var node = el.parentElement;
    while (node && node !== document.body) {
      var cs = window.getComputedStyle(node);
      if ((cs.overflowX === 'hidden' || cs.overflow === 'hidden') && r.width > 0) {
        var nr = node.getBoundingClientRect();
        if (r.left < nr.left - 1 || r.right > nr.right + 1) { notClipped = false; break; }
      }
      node = node.parentElement;
    }
    var hit = null;
    var hitScore = null;
    var cover = null;
    function isAncestor(topEl) {
      try {
        return !!topEl && topEl !== el && !el.contains(topEl) && typeof topEl.contains === 'function' && topEl.contains(el);
      } catch (e) { return false; }
    }
    function coverOf(topEl) {
      try {
        if (!topEl || topEl === el || el.contains(topEl)) return null;
        if (isAncestor(topEl)) return null; // own container background is not a cover
        var s = (topEl.tagName || '?').toLowerCase();
        var id = topEl.id ? '#' + topEl.id : '';
        var cls = (typeof topEl.className === 'string' && topEl.className.trim())
          ? '.' + topEl.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return { tag: s, selector: (s + id + cls).slice(0, 120) };
      } catch (e) { return null; }
    }
    if (r.width > 0 && r.height > 0) {
      // Quad hit-test (Phase 2): center + 4 corners, majority vote.
      // Small-target safety: <20px in either dimension → center-only,
      // else 2px inset corners would fall outside the border (false COVERED).
      // Ancestor neutrality: a test point landing on el's OWN container
      // background (padding, inline line-gaps — e.g. a padded <a> inside
      // div.hero-action) is NEITHER a hit NOR a cover. Counting it as a
      // fail turns every padded button into a false COVERED (scan 36).
      // Foreign elements on top still fail and still record the cover.
      if (r.width < 20 || r.height < 20) {
        var scx = r.left + r.width / 2, scy = r.top + r.height / 2;
        if (scx >= 0 && scy >= 0 && scx < vw && scy < vh) {
          var stop = document.elementFromPoint(scx, scy);
          if (stop && (stop === el || el.contains(stop))) {
            hit = true;
            hitScore = { pass: 1, total: 1 };
          } else if (stop && isAncestor(stop)) {
            hit = null;
            hitScore = null;
          } else {
            hit = false;
            if (stop) cover = coverOf(stop);
            hitScore = { pass: 0, total: 1 };
          }
        }
      } else {
        var inset = 2;
        var pts = [
          [r.left + r.width / 2, r.top + r.height / 2],
          [r.left + inset, r.top + inset],
          [r.right - inset, r.top + inset],
          [r.left + inset, r.bottom - inset],
          [r.right - inset, r.bottom - inset]
        ];
        var p = 0, n0 = 0;
        for (var pi = 0; pi < pts.length; pi++) {
          var px = pts[pi][0], py = pts[pi][1];
          if (px < 0 || py < 0 || px >= vw || py >= vh) continue;
          try {
            var topEl = document.elementFromPoint(px, py);
            if (!topEl) continue;
            if (topEl === el || el.contains(topEl)) { p++; n0++; }
            else if (isAncestor(topEl)) { /* neutral: own container background */ }
            else { n0++; if (!cover) cover = coverOf(topEl); }
          } catch (e) {}
        }
        if (n0 > 0) {
          hitScore = { pass: p, total: n0 };
          hit = p >= Math.ceil(n0 / 2);
        } else {
          hit = null;
          hitScore = null;
          cover = null;
        }
      }
    }
    var hasOnClick = false;
    try {
      hasOnClick = (typeof el.onclick === 'function') || el.hasAttribute('onclick') || parentOnclick;
    } catch (e) {}
    var hasDataAction = false;
    try {
      hasDataAction = el.hasAttribute('data-action') || el.hasAttribute('data-call') ||
        el.hasAttribute('data-phone') || el.hasAttribute('data-target') || parentAction;
    } catch (e) {}
    var roleAttr = el.getAttribute('role');
    // Multi-signal clickability: tel: OR role=button OR onclick OR data-action
    // OR real link/button — never href alone. Tracking-swapped numbers keep
    // parent href, so parent signals count.
    var multiClickable = !el.disabled && style.pointerEvents !== 'none' && (
      isTel ||
      roleAttr === 'button' ||
      hasOnClick ||
      hasDataAction ||
      (el.tagName === 'A' && !!rawHref && rawHref.charAt(0) !== '#') ||
      el.tagName === 'BUTTON' ||
      el.tagName === 'INPUT'
    );
    var cls = '';
    if (typeof el.className === 'string' && el.className.trim()) {
      cls = '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    var idPart = el.id ? '#' + el.id : '';
    var testPart = '';
    try {
      var tid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('name');
      if (tid) testPart = '[data=' + String(tid).slice(0, 30) + ']';
    } catch (e) {}
    out.push({
      text: text.slice(0, 80),
      aria: aria || null,
      href: abs,
      tag: el.tagName.toLowerCase(),
      role: roleAttr,
      inMenu: inMenu,
      stickyOrFloating: style.position === 'fixed' || style.position === 'sticky',
      box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      displayed: style.display !== 'none',
      visibilityVisible: style.visibility !== 'hidden' && style.visibility !== 'collapse',
      opacityVisible: parseFloat(style.opacity || '1') > 0.1,
      hasSize: r.width > 2 && r.height > 2,
      inViewport: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
      notClipped: notClipped,
      hitTestPass: hit,
      hitTestScore: hitScore,
      cover: cover,
      clickable: multiClickable,
      hasClickListener: null,
      hasOnClick: hasOnClick,
      hasDataAction: hasDataAction,
      overlaySuppressed: true,
      selector: (el.tagName.toLowerCase() + idPart + cls + testPart).slice(0, 160),
    });
  }
  var seen = {};
  return out.filter(function (o) {
    var k = o.text + '::' + o.href;
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  }).slice(0, 25);
})
`;

export const ABOVE_FOLD_PHONE_JS = `
(function (args) {
  var vh = args.vh;
  var tel = Array.from(document.querySelectorAll('a[href^="tel:"]')).some(function (el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < vh;
  });
  if (tel) return true;
  var re = /(\\+\\d[\\d\\s().-]{7,}\\d)/;
  if (!re.test(document.body.innerText || '')) return false;
  return Array.from(document.querySelectorAll('header,main')).some(function (sec) {
    var r = sec.getBoundingClientRect();
    return r.top < vh && r.bottom > 0 && re.test(sec.textContent || '');
  });
})
`;

/**
 * Zero-false-positive phone hit-test (Module 2). Runs in the settled page:
 * finds phone-number text in header/hero scope, keeps ONLY truly visible
 * nodes (offsetParent + computed display/visibility/opacity), then checks
 * the node or its direct ancestor for a valid tel: link. Plain-text numbers
 * with NO tel: wrap come back as offenders with exact text/selector/box.
 * tel: links (incl. icon-only SVG buttons) come back as dial-proofs.
 * Bounded: max 40 text nodes scanned, max 10 offenders. Never throws.
 */
export const PHONE_HITTEST_JS = `
(function (args) {
  var vh = args.vh;
  var PHONE_RE = /(\\+?\\d[\\d\\s().-]{6,}\\d)/g;
  function isVisible(el) {
    try {
      if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') return false;
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (parseFloat(cs.opacity || '1') <= 0) return false;
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return true;
    } catch (e) { return false; }
  }
  function describe(el) {
    try {
      var s = (el.tagName || '?').toLowerCase();
      var id = el.id ? '#' + el.id : '';
      var cls = (typeof el.className === 'string' && el.className.trim())
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      return (s + id + cls).slice(0, 120);
    } catch (e) { return 'unknown'; }
  }
  function telAncestor(el) {
    try {
      // closest() semantics: the link may wrap several nested spans/icons
      // (call-tracking buttons nest 4-5 deep) — walk generously.
      var n = el;
      for (var d = 0; d < 6 && n; d++) {
        if (n.tagName === 'A') {
          var h = String(n.getAttribute('href') || '');
          if (/^(tel|callto|wtai):/i.test(h)) return h.slice(0, 60);
        }
        n = n.parentElement;
      }
      if (el.closest) {
        var a = el.closest('a[href]');
        if (a) {
          var hh = String(a.getAttribute('href') || '');
          if (/^(tel|callto|wtai):/i.test(hh)) return hh.slice(0, 60);
        }
      }
    } catch (e) {}
    return null;
  }
  var offenders = [];
  var proofs = [];
  try {
    var scopes = [];
    var header = document.querySelector('header');
    if (header) scopes.push({ el: header, name: 'header' });
    var hero = document.querySelector('main');
    if (hero) scopes.push({ el: hero, name: 'main' });
    if (scopes.length === 0 && document.body) scopes.push({ el: document.body, name: 'body' });
    var checked = 0;
    for (var si = 0; si < scopes.length && checked < 40; si++) {
      var walker = document.createTreeWalker(scopes[si].el, NodeFilter.SHOW_TEXT, null);
      var node = walker.nextNode();
      while (node && checked < 40) {
        var t = String(node.nodeValue || '');
        PHONE_RE.lastIndex = 0;
        var m = PHONE_RE.exec(t);
        if (m) {
          checked++;
          var digits = m[0].replace(/\D/g, '');
          if (digits.length >= 10 && digits.length <= 15) {
            var host = node.parentElement;
            if (host && isVisible(host)) {
              var tel = telAncestor(host);
              var r = host.getBoundingClientRect();
              if (tel) {
                proofs.push({ text: m[0].slice(0, 40), tel: tel });
              } else if (offenders.length < 10) {
                offenders.push({
                  text: m[0].slice(0, 40),
                  selector: describe(host),
                  scope: scopes[si].name,
                  box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
                });
              }
            }
          }
        } else {
          checked++;
        }
        node = walker.nextNode();
      }
    }
    var telLinks = document.querySelectorAll('a[href]');
    for (var ti = 0; ti < telLinks.length; ti++) {
      var a = telLinks[ti];
      var ahref = String(a.getAttribute('href') || '');
      if (!/^(tel|callto|wtai):/i.test(ahref)) continue;
      if (isVisible(a)) proofs.push({ text: (a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').trim().slice(0, 40), tel: ahref.slice(0, 60) });
    }
  } catch (e) {}
  return { offenders: offenders, proofs: proofs };
})
`;

/**
 * Horizontal overflow offender finder (Module 4). Returns the single element
 * whose right edge sticks out furthest past the viewport (with selector +
 * rect), or null when no overflow beyond the 5px tolerance exists.
 */
export const OVERFLOW_OFFENDER_JS = `
(function () {
  var vw = typeof window.__deviceVw === 'number' && window.__deviceVw > 0 ? window.__deviceVw : window.innerWidth;
  var TOL = 5;
  function describe(el) {
    try {
      var s = (el.tagName || '?').toLowerCase();
      var id = el.id ? '#' + el.id : '';
      var cls = (typeof el.className === 'string' && el.className.trim())
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      return (s + id + cls).slice(0, 120);
    } catch (e) { return 'unknown'; }
  }
  try {
    if (document.documentElement.scrollWidth <= vw + TOL) return null;
    var best = null;
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      try {
        var r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.right <= vw + TOL) continue;
        var over = r.right - vw;
        if (!best || over > best.overflowPx) {
          best = {
            selector: describe(el),
            tag: (el.tagName || '?').toLowerCase(),
            overflowPx: Math.round(over),
            rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
          };
        }
      } catch (e) {}
    }
    return best;
  } catch (e) { return null; }
})
`;
