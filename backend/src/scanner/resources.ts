import type { FindingInput, ScanArtifacts } from './types';

/** MODULE 11 — resource thresholds (measured bytes, no optimization claims). */
export const RES = {
  imageSingle: 800 * 1024,
  imagesTotal: 3 * 1024 * 1024,
  jsSingle: 500 * 1024,
  cssSingle: 300 * 1024,
  countMany: 100,
} as const;

const kb = (b: number) => `${Math.round(b / 1024)}KB`;

export function evaluateResources(a: ScanArtifacts, homeUrl?: string): FindingInput[] {
  const out: FindingInput[] = [];
  const home = homeUrl || 'Homepage';
  const res = a.browser?.mobile.resources ?? [];
  if (res.length === 0) return out;
  const imgs = res.filter((r) => r.type === 'img' || r.type === 'image');
  const scripts = res.filter((r) => r.type === 'script');
  const styles = res.filter((r) => r.type === 'link' || r.type === 'css');

  for (const img of imgs.filter((r) => r.bytes > RES.imageSingle).slice(0, 3)) {
    out.push({
      module: 'resources',
      category: 'images',
      severity: 'MEDIUM',
      title: `Oversized image (${kb(img.bytes)})`,
      description: `An image larger than ${kb(RES.imageSingle)} slows mobile loading before conversion actions. Serve a smaller/resized variant. Manual verification required for visual impact.`,
      pageUrl: home,
      measuredValue: kb(img.bytes),
      expectedValue: `≤${kb(RES.imageSingle)} per image`,
      evidence: { page: 'Homepage', viewport: '390x844', details: { url: img.url.slice(0, 200) } },
    });
  }
  const imgTotal = imgs.reduce((s, r) => s + r.bytes, 0);
  if (imgs.length > 0 && imgTotal > RES.imagesTotal) {
    out.push({
      module: 'resources',
      category: 'images',
      severity: 'MEDIUM',
      title: `Heavy total image weight (${kb(imgTotal)})`,
      description: `All homepage images together exceed ${kb(RES.imagesTotal)}.`,
      pageUrl: home,
      measuredValue: kb(imgTotal),
      expectedValue: `≤${kb(RES.imagesTotal)} total`,
      evidence: { page: 'Homepage', viewport: '390x844', details: { image_count: String(imgs.length) } },
    });
  }
  for (const s of scripts.filter((r) => r.bytes > RES.jsSingle).slice(0, 3)) {
    out.push({
      module: 'resources',
      category: 'javascript',
      severity: 'MEDIUM',
      title: `Large JavaScript file (${kb(s.bytes)})`,
      description: `A script larger than ${kb(RES.jsSingle)} can delay interactivity of call/quote buttons.`,
      pageUrl: home,
      measuredValue: kb(s.bytes),
      expectedValue: `≤${kb(RES.jsSingle)}`,
      evidence: { page: 'Homepage', viewport: '390x844', details: { url: s.url.slice(0, 200) } },
    });
  }
  for (const s of styles.filter((r) => r.bytes > RES.cssSingle).slice(0, 2)) {
    out.push({
      module: 'resources',
      category: 'css',
      severity: 'MEDIUM',
      title: `Large stylesheet (${kb(s.bytes)})`,
      description: `A stylesheet larger than ${kb(RES.cssSingle)} can delay first render.`,
      pageUrl: home,
      measuredValue: kb(s.bytes),
      expectedValue: `≤${kb(RES.cssSingle)}`,
      evidence: { page: 'Homepage', viewport: '390x844', details: { url: s.url.slice(0, 200) } },
    });
  }
  if (res.length > RES.countMany) {
    out.push({
      module: 'resources',
      category: 'count',
      severity: 'MEDIUM',
      title: `Many page resources (${res.length})`,
      description: `More than ${RES.countMany} sub-resources were requested on the homepage.`,
      pageUrl: home,
      measuredValue: String(res.length),
      expectedValue: `≤${RES.countMany}`,
      evidence: { page: 'Homepage', viewport: '390x844', details: {} },
    });
  }
  return out;
}
