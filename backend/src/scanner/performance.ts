import { getPerfThresholds, megaGroupFor } from './niches';
import type { FindingInput, ScanArtifacts, Severity, ViewportResult } from './types';

/**
 * P11 — mobile speed white-screen lag (16-problem catalog ONLY).
 * Forensic Phase 1+2: thresholds are niche-aware (EMERGENCY 3000/1200,
 * BOOKING 4000/1800). Text-LCP (h1/h2) never attempts an image join —
 * it reports render-blocking font/CSS instead (no crash on null lcpUrl).
 * Measured locally via Playwright (Navigation Timing + LCP observers).
 *
 * Severity law: over-threshold = HIGH. EXTREME (2x threshold with the
 * branch's normal evidence) = EMERGENCY on mobile — a 6s+ blank screen is
 * not a polish item, it is a dead funnel. Desktop caps at HIGH with 1.5x
 * relaxed thresholds.
 */
export const PERF = {
  lcpBlocker: 4000,
  ttfbBlocker: 1800,
} as const;

function evalMobile(
  v: ViewportResult,
  home: string,
  out: FindingInput[],
  thresholds: { lcp: number; ttfb: number },
  mega: 'EMERGENCY' | 'BOOKING',
  fetch: { ttfbMs: number | null; responseMs: number | null },
  device: 'Mobile' | 'Desktop' = 'Mobile',
): void {
  const page = home;
  if (v.loadError) return;
  const emu = device.toLowerCase();
  // EXTREME = 2x over the gate: not slow, but a dead funnel.
  const extreme =
    (v.ttfbMs != null && v.ttfbMs > thresholds.ttfb * 2) ||
    (v.lcpMs != null && v.lcpMs > thresholds.lcp * 2);
  const severity: Severity = extreme && device === 'Mobile' ? 'EMERGENCY' : 'HIGH';
  // Dual-measurement corroboration: the browser pass and the independent
  // fetch-level probe (different stack, different moment) must agree the
  // server is slow. A one-off spike in either one stays silent.
  const fetchSlow =
    (fetch.ttfbMs != null && fetch.ttfbMs > thresholds.ttfb * 0.6) ||
    (fetch.responseMs != null && fetch.responseMs > thresholds.ttfb * 2);
  const corroboration = {
    ttfb_ms_browser: v.ttfbMs != null ? String(v.ttfbMs) : 'n/a',
    ttfb_ms_fetch: fetch.ttfbMs != null ? String(fetch.ttfbMs) : 'n/a',
    response_ms_fetch: fetch.responseMs != null ? String(fetch.responseMs) : 'n/a',
    corroborated: 'browser+fetch',
  };
  // P11: white-screen lag — either gate trips the finding (cap 1 each).
  if (v.ttfbMs != null && v.ttfbMs > thresholds.ttfb) {
    if (!fetchSlow) return; // uncorroborated spike — never emailed
    out.push({
      module: 'performance',
      category: 'loading',
      severity,
      title: `${device} page stays blank — slow server (TTFB ${(v.ttfbMs / 1000).toFixed(1)}s)`,
      description: mega === 'EMERGENCY'
        ? `Time to first byte above ${(thresholds.ttfb / 1000).toFixed(1)}s on ${emu} emulation. Emergency callers bounce to the next contractor within seconds — server latency is a direct call loss.`
        : `Time to first byte above ${(thresholds.ttfb / 1000).toFixed(1)}s on ${emu} emulation. The page stays white while visitors wait — quote/booking intent drops.`,
      pageUrl: page,
      measuredValue: `${v.ttfbMs}ms`,
      expectedValue: `≤${thresholds.ttfb}ms`,
      evidence: { page, viewport: `${v.width}x${v.height}`, details: { ttfb_ms: String(v.ttfbMs), niche_group: mega, ...corroboration } },
    });
  }
  if (v.lcpMs != null && v.lcpMs > thresholds.lcp) {
    const asset = v.lcpAsset;
    // Spec gate: image-asset bleed ONLY when BOTH duration > 4000ms AND
    // payload > 2.5MB (niche gate stays for text/slow LCP below).
    if (asset && asset.kind === 'image') {
      const heavy = asset.durationMs > 4000 && asset.bytesMB > 2.5;
      const joined = asset.bytesMB > 0 || asset.durationMs > 0;
      if (heavy) {
        out.push({
          module: 'performance',
          category: 'loading',
          severity,
          title: `Ad Budget Bleed: Massive Hero LCP Asset (LCP ${(v.lcpMs / 1000).toFixed(1)}s)`,
          description: `Largest paint blocked by ${asset.url.slice(0, 80)} (${asset.bytesMB.toFixed(1)}MB, ${asset.durationMs}ms). Paid visitors bounce before the quote/call action appears — compress this asset.`,
          pageUrl: page,
          measuredValue: `${v.lcpMs}ms`,
          expectedValue: `≤${thresholds.lcp}ms`,
          evidence: {
            page,
            viewport: `${v.width}x${v.height}`,
            details: {
              lcp_ms: String(v.lcpMs),
              lcp_url: asset.url.slice(0, 300),
              file_size_mb: asset.bytesMB.toFixed(2),
              duration_ms: String(asset.durationMs),
              ...(v.lcpElement ? { element_tag: v.lcpElement } : {}),
              niche_group: mega,
            },
          },
        });
        return;
      }
      // Image LCP over the niche gate but below the bleed gate: still slow,
      // but NOT the massive-asset claim (anti-false-positive).
      if (joined) {
        out.push({
          module: 'performance',
          category: 'loading',
          severity,
          title: `${device} content painfully slow (LCP ${(v.lcpMs / 1000).toFixed(1)}s)`,
          description: `Largest contentful paint above ${(thresholds.lcp / 1000).toFixed(1)}s on ${emu} emulation. The hero asset (${asset.bytesMB.toFixed(1)}MB) is implicated but below the massive-asset gate — verify on a real ${emu} screen before promising savings.`,
          pageUrl: page,
          measuredValue: `${v.lcpMs}ms`,
          expectedValue: `≤${thresholds.lcp}ms`,
          evidence: {
            page,
            viewport: `${v.width}x${v.height}`,
            details: {
              lcp_ms: String(v.lcpMs),
              lcp_url: asset.url.slice(0, 300),
              file_size_mb: asset.bytesMB.toFixed(2),
              lcp_duration_ms: String(asset.durationMs),
              ...(v.lcpElement ? { lcp_element: v.lcpElement } : {}),
              niche_group: mega,
            },
          },
        });
        return;
      }
      // Unjoined image URL (no resource match): fall through to generic slow.
    }
    if (asset?.kind === 'text') {
      out.push({
        module: 'performance',
        category: 'loading',
        severity,
        title: `Render-Blocking Typography/CSS Delay (LCP ${(v.lcpMs / 1000).toFixed(1)}s)`,
        description: `Largest paint is headline text (${v.lcpElement ?? 'h1/h2'}) at ${(v.lcpMs / 1000).toFixed(1)}s with no image payload — render-blocking font/CSS delays it on ${emu}. Inline critical CSS and preload the display font.`,
        pageUrl: page,
        measuredValue: `${v.lcpMs}ms`,
        expectedValue: `≤${thresholds.lcp}ms`,
        evidence: { page, viewport: `${v.width}x${v.height}`, details: { lcp_ms: String(v.lcpMs), ...(v.lcpElement ? { lcp_element: v.lcpElement } : {}), lcp_kind: 'text', niche_group: mega } },
      });
      return;
    }
    // Generic slow paint with no asset join and no text-LCP story is the
    // flakiest claim in the catalog — require fetch-level corroboration,
    // otherwise stay silent (asset-proven branches above already fired).
    if (!fetchSlow) return;
    out.push({
      module: 'performance',
      category: 'loading',
      severity,
      title: `${device} content painfully slow (LCP ${(v.lcpMs / 1000).toFixed(1)}s)`,
      description: `Largest contentful paint above ${(thresholds.lcp / 1000).toFixed(1)}s on ${emu} emulation. Visitors stare at a blank screen before any quote/call action can appear.`,
      pageUrl: page,
      measuredValue: `${v.lcpMs}ms`,
      expectedValue: `≤${thresholds.lcp}ms`,
      evidence: { page, viewport: `${v.width}x${v.height}`, details: { lcp_ms: String(v.lcpMs), ...(v.lcpElement ? { lcp_element: v.lcpElement } : {}), lcp_kind: asset?.kind ?? 'unknown', niche_group: mega, ...corroboration } },
    });
  }
}

export function evaluatePerformance(a: ScanArtifacts, homeUrl?: string, nicheId?: string): FindingInput[] {
  const out: FindingInput[] = [];
  const home = homeUrl || 'Homepage';
  if (!a.browser) return out;
  const mega = megaGroupFor(nicheId);
  const thresholds = getPerfThresholds(mega);
  evalMobile(a.browser.mobile, home, out, thresholds, mega, {
    ttfbMs: a.availability?.ttfbMs ?? null,
    responseMs: a.availability?.responseTimeMs ?? null,
  }, 'Mobile');
  // Desktop pass: same engine, 1.5x relaxed gates, HIGH max. Desktop
  // quote traffic converts too — but lab timing on desktop is noisier,
  // so it never shouts EMERGENCY.
  if (a.browser.desktop && !a.browser.desktop.loadError) {
    evalMobile(a.browser.desktop, home, out, { lcp: thresholds.lcp * 1.5, ttfb: thresholds.ttfb * 1.5 }, mega, {
      ttfbMs: a.availability?.ttfbMs ?? null,
      responseMs: a.availability?.responseTimeMs ?? null,
    }, 'Desktop');
  }
  for (const f of out) if (!f.pageUrl) f.pageUrl = home;
  return out;
}
