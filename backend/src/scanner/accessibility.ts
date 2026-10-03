import type { Page } from 'playwright';
import { getBrowser, desktopUA } from './browser';
import type { A11yViolation, FindingInput } from './types';

const CONVERSION_TAGS = ['button-name', 'label', 'select-name', 'input-button-name'];

async function getAxeBuilder() {
  const mod = await import('@axe-core/playwright');
  return mod.default ?? mod.AxeBuilder;
}

/**
 * MODULE 13 — automated axe-core pass on the homepage (desktop).
 * Results are phrased as automated findings, never compliance claims.
 */
export async function runA11y(url: string): Promise<A11yViolation[]> {
  const b = await getBrowser();
  const ctx = await b.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: desktopUA(),
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => undefined);
    const AxeBuilder = await getAxeBuilder();
    const results = await new AxeBuilder({ page }).analyze();
    return results.violations.slice(0, 15).map((v: any) => ({
      id: v.id,
      impact: v.impact ?? null,
      description: v.description.slice(0, 300),
      nodes: v.nodes.length,
      sampleTarget: v.nodes[0]?.target?.join(' ')?.slice(0, 120) ?? null,
    }));
  } catch (err) {
    throw new Error(`axe pass failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

export function evaluateA11y(violations: A11yViolation[], homeUrl?: string): FindingInput[] {
  const home = homeUrl || 'Homepage';
  // Triage v2: automated a11y warnings are MEDIUM technical debt (never LOW).
  return violations.map((v) => {
    const conversion = CONVERSION_TAGS.includes(v.id);
    return {
      module: 'accessibility',
      category: v.id,
      severity: 'MEDIUM' as FindingInput['severity'],
      title: `Automated accessibility finding: ${v.id} (${v.nodes} element${v.nodes === 1 ? '' : 's'})`,
      description: `${v.description} ${conversion ? 'This affects interactive elements used for contact/conversion.' : ''} Automated check only — manual verification required, not a compliance verdict.`.trim(),
      pageUrl: home,
      evidence: {
        page: 'Homepage',
        details: {
          rule: v.id,
          impact: v.impact ?? 'unknown',
          sample: v.sampleTarget ?? 'n/a',
        },
      },
    };
  });
}

export interface TargetSizeResult {
  nodes: number;
  sample: string | null;
}

/**
 * B3 — WCAG target-size (24px) corroboration on the LIVE mobile page.
 * Runs inside the existing browser pass (no extra session, ~2-4s).
 * Returns null when axe cannot run — callers must then leave hand-rule
 * verdicts untouched (absence of corroboration is not refutation).
 */
export async function runTargetSize(page: Page): Promise<TargetSizeResult | null> {
  try {
    const AxeBuilder = await getAxeBuilder();
    const results = await new AxeBuilder({ page }).withRules(['target-size']).analyze();
    const nodes = results.violations.flatMap((v: any) => v.nodes);
    return {
      nodes: nodes.length,
      sample: nodes[0]?.target?.join(' ')?.slice(0, 120) ?? null,
    };
  } catch {
    return null;
  }
}