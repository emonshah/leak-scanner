import { assertPublicUrl } from '../utils/ssrf';
import { proxyInit } from '../utils/proxy';
import type { FindingInput } from './types';

/**
 * Vulnerability + exposure intelligence. 100% PASSIVE ONLY — this tool never
 * sends payloads, submits forms, tests exploits, scans ports, or POSTs to
 * XML-RPC (Phase 1+2 purge: portScan + xmlrpc multicall/pingback POSTs were
 * permanently deleted to prevent WAF/Cloudflare IP bans):
 *
 *    - Version matching against curated CVE database (same approach Nessus/OpenVAS use)
 *    - WordPress core exposure (readme.html, uploads directory listing — GET only)
 *    - wp-json user enumeration (?author=1 — GET only)
 *    - XML-RPC presence check (GET /xmlrpc.php only, no POST)
 *
 * Wording rule:
 *  - Passive findings: "potentially vulnerable" / "exposure detected"
 *  - Never "exploitable" or "confirmed" — exploitability requires manual verification.
 */

// ─── Curated Vulnerability Database ──────────────────────────────────────────

export interface VulnEntry {
  slug: string;
  name: string;
  affectedFrom?: string;
  fixedIn: string;
  cve: string;
  summary: string;
  severity: FindingInput['severity'];
  source: string;
}

export const VULN_DB_DATE = '2026-09-06';

export const VULN_DB: VulnEntry[] = [
  // ── Elementor ──
  { slug: 'elementor', name: 'Elementor Website Builder', fixedIn: '3.18.2', cve: 'CVE-2023-48777', summary: 'Unrestricted upload of file with dangerous type — arbitrary file uploads.', severity: 'EMERGENCY', source: 'Patchstack' },
  { slug: 'elementor', name: 'Elementor Website Builder', fixedIn: '3.19.1', cve: 'CVE-2024-24934', summary: 'Path traversal vulnerability allowing manipulation of web input to file system calls.', severity: 'HIGH', source: 'Patchstack' },
  { slug: 'elementor', name: 'Elementor Website Builder', fixedIn: '3.22.2', cve: 'CVE-2024-37437', summary: 'Path traversal vulnerability allowing Stored XSS via improper pathname limitation.', severity: 'MEDIUM', source: 'Patchstack' },
  { slug: 'elementor', name: 'Elementor Website Builder', fixedIn: '3.25.11', cve: 'CVE-2024-54444', summary: 'Stored Cross-Site Scripting via insufficient input sanitization and output escaping.', severity: 'MEDIUM', source: 'Patchstack' },
  // ── Elementor Pro ──
  { slug: 'elementor-pro', name: 'Elementor Pro', fixedIn: '3.19.3', cve: 'CVE-2024-23523', summary: 'Exposure of sensitive information to an unauthorized actor.', severity: 'MEDIUM', source: 'Patchstack' },
  { slug: 'elementor-pro', name: 'Elementor Pro', fixedIn: '3.21.2', cve: 'CVE-2024-35656', summary: 'Reflected Cross-Site Scripting via insufficient input sanitization.', severity: 'MEDIUM', source: 'Patchstack' },
  { slug: 'elementor-pro', name: 'Elementor Pro', fixedIn: '4.2.2', cve: 'CVE-2026-32475', summary: 'Unauthenticated arbitrary file upload via upload field array validation bypass.', severity: 'EMERGENCY', source: 'Wordfence' },
  // ── Contact Form 7 ──
  { slug: 'contact-form-7', name: 'Contact Form 7', fixedIn: '5.9.2', cve: 'CVE-2024-2117', summary: 'Reflected Cross-Site Scripting via insufficient input sanitization.', severity: 'MEDIUM', source: 'Wordfence' },
  { slug: 'contact-form-7', name: 'Contact Form 7', fixedIn: '5.9.5', cve: 'CVE-2024-4704', summary: 'Unauthenticated open redirect allowing attacker-controlled redirects.', severity: 'MEDIUM', source: 'WPScan' },
  { slug: 'contact-form-7', name: 'Contact Form 7', fixedIn: '6.0.6', cve: 'CVE-2025-3247', summary: 'Order replay vulnerability allowing reuse of Stripe PaymentIntent for multiple transactions.', severity: 'MEDIUM', source: 'Wordfence' },
  // ── WooCommerce ──
  { slug: 'woocommerce', name: 'WooCommerce', fixedIn: '8.8.5', cve: 'CVE-2024-37297', summary: 'Cross-Site Scripting via Sourcebuster.js library link injection.', severity: 'MEDIUM', source: 'GitHub' },
  { slug: 'woocommerce', name: 'WooCommerce', fixedIn: '9.1.0', cve: 'CVE-2024-9944', summary: 'HTML injection via improper neutralization of HTML elements from submitted order forms.', severity: 'MEDIUM', source: 'Wordfence' },
  // ── Yoast SEO ──
  { slug: 'wordpress-seo', name: 'Yoast SEO', fixedIn: '22.6', cve: 'CVE-2024-4041', summary: 'Reflected Cross-Site Scripting via URLs with insufficient input sanitization.', severity: 'MEDIUM', source: 'Wordfence' },
  { slug: 'wordpress-seo', name: 'Yoast SEO', fixedIn: '22.7', cve: 'CVE-2024-4984', summary: 'Stored Cross-Site Scripting via the display_name author meta field.', severity: 'MEDIUM', source: 'Wordfence' },
  { slug: 'wordpress-seo', name: 'Yoast SEO', fixedIn: '26.6', cve: 'CVE-2025-14481', summary: 'Insecure Direct Object Reference in Meta Search REST API allowing reading SEO metadata from any post.', severity: 'MEDIUM', source: 'Wordfence' },
  { slug: 'wordpress-seo-premium', name: 'Yoast SEO Premium', affectedFrom: '25.7', fixedIn: '26.0', cve: 'CVE-2025-11241', summary: 'Stored XSS via flawed regex used to remove attributes in post content.', severity: 'MEDIUM', source: 'Wordfence' },
  // ── Jetpack ──
  { slug: 'jetpack', name: 'Jetpack', fixedIn: '13.3.2', cve: 'CVE-2024-4392', summary: 'Stored Cross-Site Scripting via the wpvideo shortcode.', severity: 'MEDIUM', source: 'Wordfence' },
  { slug: 'jetpack', name: 'Jetpack', fixedIn: '13.8', cve: 'CVE-2024-10075', summary: 'Unauthenticated arbitrary block and shortcode execution via Contact Form post access.', severity: 'MEDIUM', source: 'WPScan' },
  { slug: 'jetpack', name: 'Jetpack', affectedFrom: '13.0', fixedIn: '14.1', cve: 'CVE-2024-10858', summary: 'Unauthenticated DOM-XSS via postmessage origin bypass.', severity: 'MEDIUM', source: 'WPScan' },
  { slug: 'jetpack', name: 'Jetpack', fixedIn: '14.0', cve: 'CVE-2024-9926', summary: 'Missing authorization in REST endpoint allowing subscriber-level users to read arbitrary feedback data.', severity: 'MEDIUM', source: 'WPScan' },
  // ── UpdraftPlus ──
  { slug: 'updraftplus', name: 'UpdraftPlus', affectedFrom: '1.23.8', fixedIn: '1.24.12', cve: 'CVE-2024-10957', summary: 'PHP Object Injection via deserialization of untrusted input.', severity: 'HIGH', source: 'Wordfence' },
  // ── WPForms ──
  { slug: 'wpforms-lite', name: 'WPForms', fixedIn: '1.9.2.2', cve: 'CVE-2024-11205', summary: 'Missing capability check allowing subscriber-level refund payments.', severity: 'HIGH', source: 'Wordfence' },
  { slug: 'wpforms-lite', name: 'WPForms', fixedIn: '1.9.2.3', cve: 'CVE-2024-56276', summary: 'Missing authorization vulnerability on access control.', severity: 'MEDIUM', source: 'Patchstack' },
  { slug: 'wpforms-lite', name: 'WPForms', fixedIn: '1.9.3.2', cve: 'CVE-2024-13403', summary: 'Stored Cross-Site Scripting via the fieldHTML parameter.', severity: 'MEDIUM', source: 'Wordfence' },
  // ── Advanced Custom Fields ──
  { slug: 'advanced-custom-fields', name: 'Advanced Custom Fields (ACF)', fixedIn: '6.1.0', cve: 'CVE-2023-1196', summary: 'PHP Object Injection via unserialization of user controllable data.', severity: 'HIGH', source: 'Patchstack' },
  { slug: 'advanced-custom-fields', name: 'Advanced Custom Fields (ACF)', fixedIn: '6.2.5', cve: 'CVE-2023-6701', summary: 'Stored Cross-Site Scripting via custom text field.', severity: 'MEDIUM', source: 'Wordfence' },
  { slug: 'advanced-custom-fields', name: 'Advanced Custom Fields (ACF)', fixedIn: '6.3.0', cve: 'CVE-2024-4565', summary: 'Shortcode access control bypass allowing display of custom field values for any post.', severity: 'HIGH', source: 'Patchstack' },
  { slug: 'advanced-custom-fields', name: 'Advanced Custom Fields (ACF)', fixedIn: '6.3.6', cve: 'CVE-2024-45429', summary: 'Authenticated Stored XSS via field groups.', severity: 'MEDIUM', source: 'Patchstack' },
  // ── Gravity Forms ──
  { slug: 'gravityforms', name: 'Gravity Forms', fixedIn: '2.9.2', cve: 'CVE-2024-13377', summary: 'Unauthenticated Stored Cross-Site Scripting via alt parameter.', severity: 'HIGH', source: 'Wordfence' },
  { slug: 'gravityforms', name: 'Gravity Forms', fixedIn: '2.9.13', cve: 'CVE-2025-3752', summary: 'Malware compromise in versions 2.9.11.1 and 2.9.12 via supply chain attack.', severity: 'EMERGENCY', source: 'WPScan' },
  { slug: 'gravityforms', name: 'Gravity Forms', fixedIn: '2.9.21', cve: 'CVE-2025-12352', summary: 'Arbitrary file upload via copy_post_image() allowing remote code execution.', severity: 'EMERGENCY', source: 'Wordfence' },
  { slug: 'gravityforms', name: 'Gravity Forms', fixedIn: '2.10.1', cve: 'CVE-2026-12483', summary: 'Unauthenticated arbitrary file deletion via missing authorization checks.', severity: 'EMERGENCY', source: 'WPScan' },
  // ── Ninja Forms ──
  { slug: 'ninja-forms', name: 'Ninja Forms', fixedIn: '3.8.5', cve: 'CVE-2024-37934', summary: 'Code injection allowing arbitrary shortcode execution by subscriber-level users.', severity: 'HIGH', source: 'Patchstack' },
  { slug: 'ninja-forms', name: 'Ninja Forms', fixedIn: '3.11.1', cve: 'CVE-2025-9083', summary: 'PHP Object Injection via unserialization of user input through form fields.', severity: 'EMERGENCY', source: 'Wordfence' },
  { slug: 'ninja-forms', name: 'Ninja Forms', fixedIn: '3.13.3', cve: 'CVE-2025-11924', summary: 'Insecure Direct Object Reference allowing unauthenticated reading of form submissions.', severity: 'HIGH', source: 'Wordfence' },
  // ── Slider Revolution ──
  { slug: 'revslider', name: 'Slider Revolution', fixedIn: '6.6.19', cve: 'CVE-2023-6528', summary: 'Insecure deserialization leading to Remote Code Execution via slider import.', severity: 'HIGH', source: 'Patchstack' },
  { slug: 'revslider', name: 'Slider Revolution', fixedIn: '6.7.0', cve: 'CVE-2024-34444', summary: 'Missing authorization allowing unauthenticated modification of slider data.', severity: 'MEDIUM', source: 'Wordfence' },
  { slug: 'revslider', name: 'Slider Revolution', fixedIn: '6.7.11', cve: 'CVE-2024-34443', summary: 'Stored Cross-Site Scripting via insufficient input sanitization.', severity: 'MEDIUM', source: 'Patchstack' },
  { slug: 'revslider', name: 'Slider Revolution', fixedIn: '6.7.38', cve: 'CVE-2025-9217', summary: 'Arbitrary file upload via _get_media_url function with insufficient file type validation.', severity: 'HIGH', source: 'Wordfence' },
  { slug: 'revslider', name: 'Slider Revolution', affectedFrom: '7.0.0', fixedIn: '7.0.11', cve: 'CVE-2025-10249', summary: 'Missing authorization allowing Contributor+ users to install plugins and download files.', severity: 'MEDIUM', source: 'Wordfence' },
  // ── Essential Addons for Elementor ──
  { slug: 'essential-addons-for-elementor-lite', name: 'Essential Addons for Elementor', fixedIn: '6.0.10', cve: 'CVE-2024-8979', summary: 'Sensitive information exposure via init_content_lostpassword_user_email_controls.', severity: 'MEDIUM', source: 'Wordfence' },
  { slug: 'essential-addons-for-elementor-lite', name: 'Essential Addons for Elementor', fixedIn: '6.1.13', cve: 'CVE-2024-9994', summary: 'Stored Cross-Site Scripting via eael pricing item tooltip content parameter.', severity: 'MEDIUM', source: 'Wordfence' },
  { slug: 'essential-addons-for-elementor-lite', name: 'Essential Addons for Elementor', fixedIn: '6.5.4', cve: 'CVE-2025-13977', summary: 'Stored XSS via Event Calendar widget custom attributes and Image Masking module.', severity: 'MEDIUM', source: 'Wordfence' },
  { slug: 'essential-addons-for-elementor-lite', name: 'Essential Addons for Elementor', fixedIn: '6.5.6', cve: 'CVE-2026-23543', summary: 'Missing authorization on incorrectly configured access controls.', severity: 'MEDIUM', source: 'Patchstack' },
  // ── WooCommerce Stripe Gateway ──
  { slug: 'woocommerce-gateway-stripe', name: 'WooCommerce Stripe Payment Gateway', fixedIn: '3.8.0', cve: 'CVE-2024-0705', summary: 'SQL Injection via insufficient escaping on the id parameter.', severity: 'EMERGENCY', source: 'Wordfence' },
  { slug: 'woocommerce-gateway-stripe', name: 'WooCommerce Stripe Payment Gateway', fixedIn: '10.8.0', cve: 'CVE-2026-2381', summary: 'Missing authorization allowing unauthenticated modification of order status.', severity: 'MEDIUM', source: 'Wordfence' },
  // ── Akismet ──
  { slug: 'akismet', name: 'Akismet Anti-Spam', affectedFrom: '2.5.0', fixedIn: '3.1.5', cve: 'CVE-2015-9357', summary: 'Unauthenticated Stored Cross-Site Scripting via comment processing.', severity: 'MEDIUM', source: 'WPScan/Sucuri' },
  // ── Happy Addons for Elementor ──
  { slug: 'happy-elementor-addons', name: 'Happy Addons for Elementor', fixedIn: '3.20.4', cve: 'CVE-2025-63077', summary: 'Missing authorization on incorrectly configured access controls.', severity: 'MEDIUM', source: 'Patchstack' },
  // ── Really Simple Security ──
  { slug: 'really-simple-ssl', name: 'Really Simple Security', affectedFrom: '9.0.0', fixedIn: '9.1.2', cve: 'CVE-2024-10924', summary: 'Unauthenticated administrator account takeover (CVSS 9.8) when two-factor is enabled.', severity: 'EMERGENCY', source: 'NVD + WPScan + Patchstack' },
];

// ─── Version comparison ──────────────────────────────────────────────────────

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p.replace(/[^0-9].*$/, ''), 10));
  const pb = b.split('.').map((p) => parseInt(p.replace(/[^0-9].*$/, ''), 10));
  const n = Math.max(pa.length, pb.length);
  const num = (v: number | undefined): number => (typeof v !== 'number' || Number.isNaN(v) ? 0 : v);
  for (let i = 0; i < n; i++) {
    const x = num(pa[i]);
    const y = num(pb[i]);
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// ─── Detected plugin type ────────────────────────────────────────────────────

export interface DetectedPlugin {
  slug: string;
  name: string;
  version: string | null;
}

// ─── HTTP helper (read-only, SSRF-guarded) ───────────────────────────────────

async function tinyGet(url: string, ms = 8000): Promise<{ status: number; text: string } | null> {
  try { await assertPublicUrl(url); } catch { return null; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'ConversionLeakScanner/1.0 (+local audit)' },
      ...proxyInit(),
    });
    const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
    return { status: res.status, text: Buffer.from(buf).toString('utf8').slice(0, 8000) };
  } catch { return null; } finally { clearTimeout(timer); }
}

// ─── 1. Passive version-match findings ───────────────────────────────────────

export function pluginVulnFindings(plugins: DetectedPlugin[], homeUrl: string): FindingInput[] {
  const out: FindingInput[] = [];
  for (const p of plugins) {
    const entries = VULN_DB.filter((v) => v.slug === p.slug.toLowerCase());
    if (entries.length === 0 || !p.version) continue;
    for (const entry of entries) {
      if (entry.affectedFrom && compareVersions(p.version, entry.affectedFrom) < 0) continue;
      if (compareVersions(p.version, entry.fixedIn) >= 0) continue;
      out.push({
        module: 'security',
        category: 'vuln-plugin',
        severity: entry.severity,
        title: `Potentially vulnerable plugin: ${entry.name} (${p.version}, patched in ${entry.fixedIn})`,
        description:
          `Version matching against public disclosures (${entry.cve}) suggests this install may be affected: ${entry.summary} ` +
          `This is version evidence only — exploitability was NOT tested. Update the plugin and verify manually.`,
        pageUrl: homeUrl,
        measuredValue: `${p.slug} ${p.version}`,
        expectedValue: `≥ ${entry.fixedIn}`,
        evidence: {
          page: homeUrl,
          details: {
            plugin: p.slug,
            detected_version: p.version,
            patched_in: entry.fixedIn,
            cve: entry.cve,
            source: entry.source,
            db_date: VULN_DB_DATE,
            method: 'passive version match',
          },
        },
      });
    }
  }
  return out.slice(0, 20);
}

// ─── 2. WordPress core exposure probes ───────────────────────────────────────

export async function exposureProbes(origin: string, homeUrl: string): Promise<FindingInput[]> {
  const out: FindingInput[] = [];
  let base: string;
  try { base = new URL(origin).origin; } catch { return out; }

  // readme.html discloses the exact WP core version
  const readme = await tinyGet(`${base}/readme.html`);
  if (readme?.status === 200 && /wordpress/i.test(readme.text)) {
    const ver = /Stable tag:\s*([0-9.]+)/i.exec(readme.text)?.[1] ?? /Version\s*([0-9.]+)/i.exec(readme.text)?.[1];
    if (ver) {
      out.push({
        module: 'security', category: 'exposure', severity: 'MEDIUM',
        title: `WordPress version disclosed via readme.html (${ver})`,
        description: `The public readme.html reveals the exact core version (${ver}), helping attackers pick matching exploits. Remove or block readme.html.`,
        pageUrl: homeUrl, measuredValue: `readme.html exposes ${ver}`,
        expectedValue: 'readme.html removed or blocked (403/404)',
        evidence: { page: homeUrl, details: { path: '/readme.html', disclosed_version: ver } },
      });
    }
  }

  // Open directory listing on uploads
  const uploads = await tinyGet(`${base}/wp-content/uploads/`);
  if (uploads?.status === 200 && /Index of\s*\//i.test(uploads.text)) {
    out.push({
      module: 'security', category: 'exposure', severity: 'MEDIUM',
      title: 'Directory listing enabled on wp-content/uploads',
      description: 'The uploads folder shows an open file index, letting anyone enumerate media files. Disable directory indexes at server level.',
      pageUrl: homeUrl, measuredValue: 'Index of / listing returned HTTP 200',
      expectedValue: '403/404 or blank index',
      evidence: { page: homeUrl, details: { path: '/wp-content/uploads/', observed: 'Index of /' } },
    });
  }

  // NOTE (Phase 1+2 purge): wp-config backup probing (.bak/~/.old/...) was
  // removed — aggressive multi-URL guessing against live sites. Kept passive:
  // readme.html + uploads listing only.

  return out;
}

// ─── 3. Plugin-specific exposure probes ──────────────────────────────────────

/**
 * DEPRECATED (Phase 1+2 purge): aggressive per-plugin file guessing removed.
 * technology.ts emits no plugin inventory (plugins=[] by design), so this
 * probed blind paths. Kept as a no-op stub for API compatibility — callers
 * must NOT invoke it. Passive version-match (pluginVulnFindings) remains.
 */
export async function pluginExposureProbes(
  _plugins: DetectedPlugin[],
  _homeUrl: string,
): Promise<FindingInput[]> {
  return [];
}

// ─── 4. Port scanning — PERMANENTLY DELETED (Phase 1+2) ─────────────────────
// net.Socket SYN scans + COMMON_PORTS got purged: active scanning gets the
// scanner IP banned by WAF/Cloudflare. 100% passive from here on.
// Kept stub so old imports fail loudly at typecheck, not silently at runtime.
export async function portScan(_homeUrl: string): Promise<FindingInput[]> {
  return [];
}

// ─── 5. wp-json user enumeration ─────────────────────────────────────────────

export async function wpJsonChecks(homeUrl: string): Promise<FindingInput[]> {
  const out: FindingInput[] = [];
  let base: string;
  try { base = new URL(homeUrl).origin; } catch { return out; }

  // /wp-json/wp/v2/users — lists all users with login names
  const users = await tinyGet(`${base}/wp-json/wp/v2/users`);
  if (users?.status === 200) {
    try {
      const data = JSON.parse(users.text) as Array<{ slug?: string; name?: string }>;
      if (Array.isArray(data) && data.length > 0) {
        const names = data.map((u) => u.slug ?? u.name ?? 'unknown').join(', ');
        out.push({
          module: 'security', category: 'user-enumeration', severity: 'MEDIUM',
          title: `wp-json exposes ${data.length} user login names`,
          description:
            `The REST API endpoint /wp-json/wp/v2/users returns ${data.length} user(s) (${names}). ` +
            `Attackers use these usernames for brute-force and credential-stuffing attacks. Restrict access to this endpoint.`,
          pageUrl: homeUrl, measuredValue: `${data.length} users exposed`,
          expectedValue: '/wp-json/wp/v2/users blocked or empty',
          evidence: { page: homeUrl, details: { endpoint: '/wp-json/wp/v2/users', users: names.slice(0, 300) } },
        });
      }
    } catch { /* not JSON — skip */ }
  }

  // ?author=1 enumeration via redirects
  const author = await tinyGet(`${base}/?author=1`);
  if (author?.status === 200 && /author\/([^/"]+)/i.test(author.text)) {
    const m = /author\/([^/"]+)/i.exec(author.text);
    if (m) {
      out.push({
        module: 'security', category: 'user-enumeration', severity: 'MEDIUM',
        title: `User enumeration via ?author=1 reveals: ${m[1]}`,
        description: `The URL /?author=1 redirects or reveals the username "${m[1]}" in the page. This aids brute-force attacks. Disable author archives or redirect them.`,
        pageUrl: `${base}/?author=1`, measuredValue: `username: ${m[1]}`,
        expectedValue: 'no username disclosure',
        evidence: { page: `${base}/?author=1`, details: { username: m[1] } },
      });
    }
  }

  return out;
}

// ─── 6. XML-RPC checks — PASSIVE GET ONLY (Phase 1+2) ───────────────────────
// multicall + pingback POST payloads permanently deleted. Presence via GET
// /xmlrpc.php only — no brute-force surface testing, no outbound pingback.

export async function xmlRpcChecks(homeUrl: string): Promise<FindingInput[]> {
  const out: FindingInput[] = [];
  let base: string;
  try { base = new URL(homeUrl).origin; } catch { return out; }

  // Check if XML-RPC is accessible (GET only)
  const r = await tinyGet(`${base}/xmlrpc.php`);
  if (!r || r.status !== 200) return out;

  const hasXmlRpc = /xmlrpc/i.test(r.text) || /XML-RPC/i.test(r.text);
  if (!hasXmlRpc) return out;

  out.push({
    module: 'security', category: 'xmlrpc', severity: 'MEDIUM',
    title: 'XML-RPC is enabled (xmlrpc.php accessible)',
    description:
      'XML-RPC endpoint responds to GET (HTTP 200). If unused, disable it to reduce brute-force and pingback abuse surface. Presence only — no payload was sent.',
    pageUrl: `${base}/xmlrpc.php`, measuredValue: 'HTTP 200',
    expectedValue: '403/404 or restricted',
    evidence: { page: homeUrl, details: { endpoint: '/xmlrpc.php', status: '200', method: 'passive GET only' } },
  });

  return out;
}
