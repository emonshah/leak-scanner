import fs from 'node:fs/promises';
import path from 'node:path';
import { getPool } from '../db/mysql.js';
import type { FindingInput, FindingRow, ScanQuality, ScanStatus, SecurityCheck } from '../scanner/types.js';
import type { TechReport } from '../scanner/technology.js';
import { broadcastLog } from './ws.js';
import { scoreCapped } from '../scanner/intelligence.js';

export interface ScanRow {
  id: number;
  websiteId: number;
  websiteUrl: string;
  normalizedUrl: string;
  status: ScanStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  opportunityScore: number | null;
  minorIssuesCount: number;
  quality: ScanQuality | null;
  findingCount: number;
  createdAt: string;
  createdBy: { id: number; email: string; name: string | null } | null;
}

interface ScanDbRow {
  id: number;
  website_id: number;
  website_url: string;
  normalized_url: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  error: string | null;
  opportunity_score: number | null;
  minor_issues_count: number | null;
  quality: string | object | null;
  finding_count: number;
  created_at: Date;
  owner_id: number | null;
  owner_email: string | null;
  owner_name: string | null;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function toScan(r: ScanDbRow): ScanRow {
  let quality: ScanRow['quality'] = null;
  try {
    quality = r.quality
      ? ((typeof r.quality === 'string' ? JSON.parse(r.quality) : r.quality) as ScanRow['quality'])
      : null;
  } catch {
    quality = null;
  }
  return {
    id: r.id,
    websiteId: r.website_id,
    websiteUrl: r.website_url,
    normalizedUrl: r.normalized_url,
    status: r.status as ScanStatus,
    startedAt: iso(r.started_at),
    completedAt: iso(r.completed_at),
    error: r.error,
    opportunityScore: r.opportunity_score,
    minorIssuesCount: Number(r.minor_issues_count ?? 0),
    quality,
    findingCount: Number(r.finding_count ?? 0),
    createdAt: new Date(r.created_at).toISOString(),
    createdBy:
      r.owner_id != null && r.owner_email
        ? { id: r.owner_id, email: r.owner_email, name: r.owner_name ?? null }
        : null,
  };
}

const LIST_SQL = `
  SELECT s.id, s.website_id, s.status, s.started_at, s.completed_at, s.error,
         s.opportunity_score, s.minor_issues_count, s.quality,
         s.created_at,
         w.url AS website_url, w.normalized_url, w.user_id AS owner_id,
         u.email AS owner_email, u.display_name AS owner_name,
         (SELECT COUNT(*) FROM findings f WHERE f.scan_id = s.id) AS finding_count
  FROM scans s JOIN websites w ON w.id = s.website_id LEFT JOIN users u ON u.id = w.user_id`;

export async function createScan(websiteId: number): Promise<number> {
  const pool = getPool();
  const [r] = await pool.query('INSERT INTO scans (website_id, status) VALUES (?, ?)', [websiteId, 'pending']);
  return (r as { insertId: number }).insertId;
}

export async function getScan(id: number): Promise<ScanRow | null> {
  const [rows] = await getPool().query(`${LIST_SQL} WHERE s.id = ?`, [id]);
  const r = (rows as ScanDbRow[])[0];
  return r ? toScan(r) : null;
}

export async function listScans(limit = 100, ownerId: number | null = null): Promise<ScanRow[]> {
  const where = ownerId == null ? '' : 'WHERE w.user_id = ?';
  const params: unknown[] = ownerId == null ? [limit] : [ownerId, limit];
  const [rows] = await getPool().query(
    `${LIST_SQL} ${where} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
    params,
  );
  return (rows as ScanDbRow[]).map(toScan);
}

export async function listScansForWebsite(websiteId: number): Promise<ScanRow[]> {
  const [rows] = await getPool().query(
    `${LIST_SQL} WHERE s.website_id = ? ORDER BY s.created_at DESC, s.id DESC`,
    [websiteId],
  );
  return (rows as ScanDbRow[]).map(toScan);
}

export async function setScanStatus(
  id: number,
  status: ScanStatus,
  extra: { error?: string | null; opportunityScore?: number | null } = {},
): Promise<void> {
  const pool = getPool();
  if (status === 'scanning') {
    await pool.query(
      'UPDATE scans SET status = ?, started_at = COALESCE(started_at, NOW()), error = NULL WHERE id = ?',
      [status, id],
    );
  } else if (status === 'completed' || status === 'failed' || status === 'blocked' || status === 'cancelled') {
    await pool.query(
      'UPDATE scans SET status = ?, completed_at = NOW(), error = ?, opportunity_score = ? WHERE id = ?',
      [status, extra.error ?? null, extra.opportunityScore ?? null, id],
    );
  } else {
    await pool.query('UPDATE scans SET status = ?, error = ? WHERE id = ?', [status, extra.error ?? null, id]);
  }
}

export interface PageRow {
  url: string;
  normalizedUrl: string;
  statusCode: number | null;
  finalUrl: string | null;
  responseTimeMs: number | null;
  isHomepage: boolean;
  title: string | null;
}

export async function savePages(scanId: number, pages: PageRow[]): Promise<void> {
  if (pages.length === 0) return;
  const pool = getPool();
  await pool.query(
    'INSERT INTO pages (scan_id, url, normalized_url, status_code, final_url, response_time_ms, is_homepage, title) VALUES ?',
    [
      pages.map((p) => [
        scanId,
        p.url.slice(0, 2048),
        p.normalizedUrl.slice(0, 2048),
        p.statusCode,
        p.finalUrl?.slice(0, 2048) ?? null,
        p.responseTimeMs,
        p.isHomepage ? 1 : 0,
        p.title?.slice(0, 512) ?? null,
      ]),
    ],
  );
}

export function splitMoneyLeaks(findings: FindingInput[]): { major: FindingInput[]; minorCount: number } {
  const major: FindingInput[] = [];
  let minorCount = 0;
  for (const f of findings) {
    if (f.severity === 'EMERGENCY' || f.severity === 'HIGH') {
      major.push(f);
      continue;
    }
    if ((f.severity as string) === 'CRITICAL') {
      major.push({ ...f, severity: 'EMERGENCY' });
      continue;
    }
    minorCount++;
  }
  return { major, minorCount };
}

export const EVIDENCE_JSON_MAX = 4096;

function deepTrim(v: unknown, perString: number): unknown {
  if (typeof v === 'string') return v.length > perString ? `${v.slice(0, perString)}…[truncated]` : v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => deepTrim(x, perString));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, val]) => [k, deepTrim(val, perString)]));
  }
  return v;
}

export function trimEvidenceJson(evidence: Record<string, unknown> | undefined): string {
  let per = 500;
  let out = JSON.stringify(deepTrim(evidence ?? {}, per));
  while (out.length > EVIDENCE_JSON_MAX && per > 50) {
    per = Math.floor(per / 2);
    out = JSON.stringify(deepTrim(evidence ?? {}, per));
  }
  if (out.length <= EVIDENCE_JSON_MAX) return out;
  return JSON.stringify({ truncated: true, preview: JSON.stringify(evidence ?? {}).slice(0, EVIDENCE_JSON_MAX - 100) });
}

export async function saveFindings(scanId: number, websiteId: number, findings: FindingInput[]): Promise<number> {
  const { major: filtered, minorCount } = splitMoneyLeaks(findings);
  const pool = getPool();
  await pool.query('UPDATE scans SET minor_issues_count = ? WHERE id = ?', [minorCount, scanId]);
  if (filtered.length === 0) return minorCount;
  await pool.query(
    `INSERT INTO findings (scan_id, website_id, page_url, module, category, severity, title,
      description, measured_value, expected_value, evidence,
      business_category, conversion_impact, confidence, priority_score, group_key, is_group_primary)
     VALUES ?`,
    [
      filtered.map((f) => [
        scanId,
        websiteId,
        f.pageUrl?.slice(0, 2048) ?? null,
        f.module.slice(0, 64),
        f.category.slice(0, 64),
        f.severity,
        f.title.slice(0, 255),
        f.description?.slice(0, 2000) ?? null,
        f.measuredValue?.slice(0, 512) ?? null,
        f.expectedValue?.slice(0, 512) ?? null,
        trimEvidenceJson({ ...(f.evidence ?? {}), ...(f.groupTitle ? { group: f.groupTitle } : {}), ...(f.whyPrioritized?.length ? { why: f.whyPrioritized } : {}) }),
        f.businessCategory?.slice(0, 64) ?? null,
        f.conversionImpact?.slice(0, 32) ?? null,
        f.confidence?.slice(0, 16) ?? null,
        f.priorityScore ?? null,
        f.groupKey?.slice(0, 128) ?? null,
        f.isGroupPrimary === false ? 0 : 1,
      ]),
    ],
  );
  return minorCount;
}

export function safeJsonObject(raw: unknown): Record<string, unknown> {
  if (raw == null || Array.isArray(raw)) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function mapFindingRow(r: Record<string, unknown>): FindingRow {
  const rawSev = r['severity'] as string;
  const severity = (rawSev === 'CRITICAL' ? 'EMERGENCY' : rawSev) as FindingInput['severity'];
  return {
    id: r['id'] as number,
    scanId: r['scan_id'] as number,
    websiteId: r['website_id'] as number,
    pageUrl: (r['page_url'] as string | null) ?? undefined,
    module: r['module'] as string,
    category: r['category'] as string,
    severity,
    title: r['title'] as string,
    description: (r['description'] as string | null) ?? '',
    measuredValue: (r['measured_value'] as string | null) ?? undefined,
    expectedValue: (r['expected_value'] as string | null) ?? undefined,
    evidence: safeJsonObject(r['evidence']),
    businessCategory: (r['business_category'] as string | null) ?? undefined,
    conversionImpact: (r['conversion_impact'] as string | null) ?? undefined,
    confidence: (r['confidence'] as string | null) ?? undefined,
    priorityScore: (r['priority_score'] as number | null) ?? undefined,
    groupKey: (r['group_key'] as string | null) ?? undefined,
    isGroupPrimary: (r['is_group_primary'] as number | null) !== 0,
    createdAt: new Date(r['created_at'] as Date).toISOString(),
  };
}

export async function getFindings(scanId: number): Promise<FindingRow[]> {
  const [rows] = await getPool().query(
    `SELECT id, scan_id, website_id, page_url, module, category, severity, title, description,
            measured_value, expected_value, evidence,
            business_category, conversion_impact, confidence, priority_score,
            group_key, is_group_primary, created_at
     FROM findings WHERE scan_id = ? ORDER BY
        priority_score DESC, FIELD(severity, 'EMERGENCY','CRITICAL','HIGH','MEDIUM','LOW','INFO'), id ASC`,
    [scanId],
  );
  return (rows as Record<string, unknown>[]).map(mapFindingRow);
}

export async function deleteFinding(scanId: number, findingId: number): Promise<{ deleted: boolean; opportunityScore: number | null }> {
  const pool = getPool();
  await pool.query('DELETE FROM finding_verifications WHERE scan_id = ? AND finding_id = ?', [scanId, findingId]);
  try {
    const [evRows] = await pool.query('SELECT evidence FROM findings WHERE id = ? AND scan_id = ?', [findingId, scanId]);
    const rawEv = (evRows as { evidence?: unknown }[])[0]?.evidence;
    const parsed = safeJsonObject(typeof rawEv === 'string' ? rawEv : rawEv);
    const det = (parsed['details'] ?? {}) as Record<string, unknown>;
    const shot = typeof det['screenshot'] === 'string' ? det['screenshot'] : null;
    if (shot && /^ev-(phone|overflow|cta|tap)-\d+\.webp$/.test(shot)) {
      const root = screenshotsRoot();
      const file = path.resolve(root, String(scanId), shot);
      if (file.startsWith(root + path.sep)) {
        await fs.unlink(file).catch(() => undefined);
      }
    }
  } catch {
    /* file cleanup must never fail the delete */
  }
  const [r] = await pool.query('DELETE FROM findings WHERE id = ? AND scan_id = ?', [findingId, scanId]);
  if ((r as { affectedRows: number }).affectedRows === 0) return { deleted: false, opportunityScore: null };
  const [rows] = await pool.query('SELECT module, category, severity, priority_score, title FROM findings WHERE scan_id = ?', [scanId]);
  // Same capped math as the pipeline (titles + per-story cap) so a manual
  // delete recomputes the identical number the scan would show.
  const opportunityScore = scoreCapped(
    (rows as { module: string; category: string; severity: string; priority_score: number | null; title: string }[]).map((f) => ({
      module: f.module,
      category: f.category,
      severity: f.severity,
      priorityScore: Number(f.priority_score ?? 0),
      title: f.title,
    })),
  ).score;
  await pool.query('UPDATE scans SET opportunity_score = ? WHERE id = ?', [opportunityScore, scanId]);
  return { deleted: true, opportunityScore };
}

export async function deleteScan(id: number): Promise<{ deleted: boolean }> {
  const pool = getPool();
  const scan = await getScan(id);
  if (!scan) return { deleted: false };
  if (ACTIVE_FOR_DELETE.has(scan.status)) {
    throw new Error('Scan is still running — cancel it before deleting.');
  }
  await pool.query('DELETE FROM findings WHERE scan_id = ?', [id]);
  await pool.query('DELETE FROM pages WHERE scan_id = ?', [id]);
  await pool.query('DELETE FROM technologies WHERE scan_id = ?', [id]);
  await pool.query('DELETE FROM security_checks WHERE scan_id = ?', [id]);
  await pool.query('DELETE FROM ui_checks WHERE scan_id = ?', [id]);
  await pool.query('DELETE FROM scan_logs WHERE scan_id = ?', [id]);
  await pool.query('DELETE FROM scans WHERE id = ?', [id]);
  const root = screenshotsRoot();
  const dir = path.resolve(root, String(id));
  if (dir !== root && dir.startsWith(root + path.sep)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return { deleted: true };
}

const ACTIVE_FOR_DELETE = new Set(['scanning', 'pending', 'paused']);

export async function batchProgress(ownerId: number | null = null): Promise<{
  total: number;
  completed: number;
  scanning: number;
  pending: number;
  failed: number;
  blocked: number;
  paused: number;
  cancelled: number;
}> {
  const [rows] = ownerId == null
    ? await getPool().query('SELECT status, COUNT(*) AS n FROM scans GROUP BY status')
    : await getPool().query(
      `SELECT s.status, COUNT(*) AS n FROM scans s JOIN websites w ON w.id = s.website_id WHERE w.user_id = ? GROUP BY s.status`,
      [ownerId],
    );
  const out = { total: 0, completed: 0, scanning: 0, pending: 0, failed: 0, blocked: 0, paused: 0, cancelled: 0 };
  for (const r of rows as { status: string; n: number }[]) {
    const n = Number(r.n);
    out.total += n;
    if (r.status in out) (out as Record<string, number>)[r.status] = n;
  }
  return out;
}

export interface WebsiteRow {
  id: number;
  url: string;
  normalized_url: string;
  status: string;
  niche: string | null;
  primary_tech: string | null;
  contact_email: string | null;
  contact_name: string | null;
  business_name: string | null;
  city: string | null;
  country: string | null;
  notes: string | null;
  email_status: string | null;
  email_checked_at: Date | null;
  email_manual: number | null;
  do_not_email: number | null;
  parked_at: Date | null;
  lead_status: string | null;
  lead_status_at: Date | null;
  lead_status_note: string | null;
  created_at: Date;
  user_id: number | null;
  owner_email: string | null;
  owner_name: string | null;
}

export const LEAD_STATUSES = ['new', 'qualified', 'skipped', 'contacted', 'replied'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface WebsiteDTO {
  id: number;
  url: string;
  normalizedUrl: string;
  status: string;
  niche: string;
  primaryTech: string | null;
  contactEmail: string | null;
  contactName: string | null;
  businessName: string | null;
  city: string | null;
  country: string | null;
  emailStatus: string | null;
  emailCheckedAt: string | null;
  emailManual: boolean;
  doNotEmail: boolean;
  parkedAt: string | null;
  leadStatus: LeadStatus;
  leadStatusAt: string | null;
  leadStatusNote: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: { id: number; email: string; name: string | null } | null;
}

const WEBSITE_SELECT = `SELECT w.*, u.email AS owner_email, u.display_name AS owner_name FROM websites w LEFT JOIN users u ON u.id = w.user_id`;

function toWebsiteDTO(r: WebsiteRow): WebsiteDTO {
  return {
    id: r.id,
    url: r.url,
    normalizedUrl: r.normalized_url,
    status: r.status,
    niche: r.niche ?? 'general',
    primaryTech: r.primary_tech ?? null,
    contactEmail: r.contact_email ?? null,
    contactName: r.contact_name ?? null,
    businessName: r.business_name ?? null,
    city: r.city ?? null,
    country: r.country ?? null,
    emailStatus: r.email_status ?? null,
    emailCheckedAt: r.email_checked_at ? new Date(r.email_checked_at).toISOString() : null,
    emailManual: (r.email_manual ?? 0) !== 0,
    doNotEmail: (r.do_not_email ?? 0) !== 0,
    parkedAt: r.parked_at ? new Date(r.parked_at).toISOString() : null,
    leadStatus: (LEAD_STATUSES as readonly string[]).includes(r.lead_status ?? '') ? (r.lead_status as LeadStatus) : 'new',
    leadStatusAt: r.lead_status_at ? new Date(r.lead_status_at).toISOString() : null,
    leadStatusNote: r.lead_status_note ?? null,
    notes: r.notes ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    createdBy:
      r.user_id != null && r.owner_email
        ? { id: r.user_id, email: r.owner_email, name: r.owner_name ?? null }
        : null,
  };
}

export async function getWebsites(ownerId: number | null = null): Promise<WebsiteDTO[]> {
  const [rows] =
    ownerId == null
      ? await getPool().query(`${WEBSITE_SELECT} ORDER BY w.created_at DESC, w.id DESC`)
      : await getPool().query(
          `${WEBSITE_SELECT} WHERE w.user_id = ? ORDER BY w.created_at DESC, w.id DESC`,
          [ownerId],
        );
  return (rows as WebsiteRow[]).map(toWebsiteDTO);
}

export async function getWebsite(id: number): Promise<WebsiteDTO | null> {
  const [rows] = await getPool().query(`${WEBSITE_SELECT} WHERE w.id = ?`, [id]);
  const row = (rows as WebsiteRow[])[0];
  return row ? toWebsiteDTO(row) : null;
}

export async function saveTech(scanId: number, report: TechReport): Promise<void> {
  const pool = getPool();
  const rows: unknown[][] = [];
  for (const i of report.items) {
    rows.push([
      scanId,
      i.category.slice(0, 64),
      i.technology.slice(0, 128),
      i.version?.slice(0, 64) ?? null,
      i.confidence,
      JSON.stringify({ methods: i.methods, evidence: i.evidence.slice(0, 6) }),
    ]);
  }
  if (report.wordpress.detected) {
    rows.push([
      scanId,
      'CMS',
      'WordPress',
      report.wordpress.version?.slice(0, 64) ?? null,
      report.wordpress.confidence,
      JSON.stringify({ versionState: report.wordpress.versionState, versionEvidence: report.wordpress.versionEvidence }),
    ]);
    const t = report.wordpress.theme;
    if (t) {
      rows.push([
        scanId,
        'WordPress Theme',
        t.name ?? t.slug,
        t.version?.slice(0, 64) ?? null,
        t.confidence,
        JSON.stringify({
          slug: t.slug,
          childTheme: t.childTheme,
          parent: t.parentSlug,
          state: report.wordpress.themeState,
          evidence: t.evidence.slice(0, 4),
        }),
      ]);
    }
    for (const p of report.wordpress.plugins) {
      rows.push([
        scanId,
        'WordPress Plugin',
        p.name.slice(0, 128),
        p.version?.slice(0, 64) ?? null,
        p.confidence,
        JSON.stringify({ slug: p.slug, evidence: p.evidence.slice(0, 4), pages: p.pages.slice(0, 5) }),
      ]);
    }
  }
  rows.push([scanId, 'Meta', '_detection_quality', null, 'HIGH', JSON.stringify(report.quality)]);
  if (rows.length > 0) {
    await pool.query(`INSERT INTO technologies (scan_id, category, technology, version, confidence, evidence) VALUES ?`, [rows]);
  }
  await pool.query(
    'UPDATE websites SET primary_tech = ? WHERE id = (SELECT website_id FROM scans WHERE id = ?)',
    [report.primaryPlatform.slice(0, 64), scanId],
  );
}

export async function getTech(scanId: number): Promise<{
  items: TechRow[];
  primaryPlatform: string | null;
  wordpress: import('../scanner/technology.js').WpInfo | null;
  quality: import('../scanner/technology.js').TechReport['quality'] | null;
}> {
  const [rows] = await getPool().query(
    `SELECT category, technology, version, confidence, evidence FROM technologies WHERE scan_id = ? ORDER BY id ASC LIMIT 200`,
    [scanId],
  );
  const items = (rows as Record<string, unknown>[]).map((r) => ({
    category: r['category'] as string,
    technology: r['technology'] as string,
    version: (r['version'] as string | null) ?? null,
    confidence: r['confidence'] as string,
    evidence: (() => {
      try {
        const e = r['evidence'];
        return typeof e === 'string' ? JSON.parse(e) : (e ?? {});
      } catch {
        return {};
      }
    })(),
  }));
  const qualityRow = items.find((i) => i.category === 'Meta' && i.technology === '_detection_quality');
  const quality = (() => {
    try {
      const e = (qualityRow?.evidence ?? {}) as Record<string, unknown>;
      return e && typeof e['level'] === 'string'
        ? (e as unknown as import('../scanner/technology.js').TechReport['quality'])
        : null;
    } catch {
      return null;
    }
  })();
  const itemsOut = items.filter((i) => i.category !== 'Meta');
  const wpRow = itemsOut.find((i) => i.category === 'CMS' && i.technology === 'WordPress');
  const themeRow = itemsOut.find((i) => i.category === 'WordPress Theme');
  const pluginRows = itemsOut.filter((i) => i.category === 'WordPress Plugin');
  const evOf = (r: TechRow) => (r.evidence ?? {}) as Record<string, unknown>;
  type WpInfo = import('../scanner/technology.js').WpInfo;
  type WpConfidence = WpInfo['confidence'];
  type EvItem = { type: 'header' | 'html' | 'asset' | 'cookie' | 'dom' | 'endpoint'; value: string; page: string };
  const wordpress: WpInfo | null = wpRow
    ? {
        detected: true,
        confidence: (wpRow.confidence ?? 'MEDIUM') as WpConfidence,
        version: wpRow.version,
        versionState: (wpRow.version ? 'detected' : 'unknown') as WpInfo['versionState'],
        versionEvidence: ((evOf(wpRow)['versionEvidence'] as string[]) ?? []) as string[],
        theme: themeRow
          ? {
              slug: ((evOf(themeRow)['slug'] as string) ?? ''),
              name: themeRow.technology,
              version: themeRow.version,
              childTheme: !!evOf(themeRow)['childTheme'],
              parentSlug: (evOf(themeRow)['parent'] as string | null) ?? null,
              confidence: (themeRow.confidence ?? 'MEDIUM') as WpConfidence,
              evidence: ((evOf(themeRow)['evidence'] as EvItem[]) ?? []) as EvItem[],
            }
          : null,
        themeState: (themeRow ? 'detected' : 'unknown') as WpInfo['themeState'],
        plugins: pluginRows.map((p) => ({
          slug: (evOf(p)['slug'] as string) ?? '',
          name: p.technology,
          version: p.version,
          confidence: (p.confidence ?? 'MEDIUM') as WpConfidence,
          evidence: ((evOf(p)['evidence'] as EvItem[]) ?? []) as EvItem[],
          pages: ((evOf(p)['pages'] as string[]) ?? []) as string[],
        })),
        pluginNote: 'Plugins detected from publicly observable website assets.',
      }
    : null;
  const [wrows] = await getPool().query(
    `SELECT w.primary_tech FROM scans s JOIN websites w ON w.id = s.website_id WHERE s.id = ?`,
    [scanId],
  );
  return {
    items: itemsOut,
    primaryPlatform: ((wrows as { primary_tech: string | null }[])[0]?.primary_tech ?? null) as string | null,
    wordpress,
    quality,
  };
}

export interface TechRow {
  category: string;
  technology: string;
  version: string | null;
  confidence: string;
  evidence: unknown;
}

export async function saveSecurityChecks(scanId: number, checks: SecurityCheck[]): Promise<void> {
  if (checks.length === 0) return;
  await getPool().query(
    `INSERT INTO security_checks (scan_id, check_id, title, status, observed, expected,
      risk, recommendation, evidence, owasp, automated) VALUES ?`,
    [
      checks.map((c) => [
        scanId,
        c.checkId.slice(0, 64),
        c.title.slice(0, 255),
        c.status,
        c.observed?.slice(0, 1024) ?? null,
        c.expected.slice(0, 1024),
        c.risk,
        c.recommendation.slice(0, 1024),
        JSON.stringify(c.evidence ?? {}),
        c.owasp.slice(0, 16),
        c.automated,
      ]),
    ],
  );
}

export async function getSecurityChecks(scanId: number): Promise<SecurityCheck[]> {
  const [rows] = await getPool().query(
    `SELECT check_id, title, status, observed, expected, risk, recommendation,
            evidence, owasp, automated FROM security_checks
     WHERE scan_id = ? ORDER BY
       FIELD(status, 'FAIL','WARNING','BLOCKED','INCONCLUSIVE','NOT_TESTED','REQUIRES_MANUAL_REVIEW','PASS'), id ASC`,
    [scanId],
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    checkId: r['check_id'] as string,
    title: r['title'] as string,
    status: r['status'] as SecurityCheck['status'],
    observed: (r['observed'] as string | null) ?? null,
    expected: (r['expected'] as string | null) ?? '',
    risk: (r['risk'] as SecurityCheck['risk']) ?? 'Info',
    recommendation: (r['recommendation'] as string | null) ?? '',
    evidence: safeJsonObject(r['evidence']) as Record<string, string>,
    owasp: (r['owasp'] as string | null) ?? '',
    automated: (r['automated'] as SecurityCheck['automated']) ?? 'AUTOMATED',
  }));
}

export interface UiCheckRow {
  viewport: string;
  kind: string;
  label: string;
  domFound: boolean;
  visible: boolean;
  box: Record<string, number>;
  hitTest: string | null;
  screenshot: string | null;
  verdict: string;
  confidence: string;
}

export async function saveUiChecks(scanId: number, a: import('../scanner/types.js').ScanArtifacts): Promise<void> {
  const rows: unknown[][] = [];
  for (const vp of [a.browser?.mobile, a.browser?.tablet, a.browser?.desktop]) {
    if (!vp || vp.loadError) continue;
    for (const o of vp.ctaObservations.slice(0, 15)) {
      rows.push([
        scanId,
        vp.name,
        'cta',
        o.text.slice(0, 255) || '(no text)',
        1,
        o.verdict === 'VISIBLE' ? 1 : 0,
        JSON.stringify(o.box ?? {}),
        o.hitTestPass == null ? 'SKIPPED' : o.hitTestPass ? 'PASS' : 'COVERED',
        o.screenshotCrop ? path.basename(o.screenshotCrop).slice(0, 128) : null,
        o.verdict,
        o.confidence,
      ]);
    }
  }
  if (rows.length === 0) return;
  await getPool().query(
    `INSERT INTO ui_checks (scan_id, viewport, kind, label, dom_found, visible,
      box_json, hit_test, screenshot, verdict, confidence) VALUES ?`,
    [rows],
  );
}

export async function getUiChecks(scanId: number): Promise<UiCheckRow[]> {
  const [rows] = await getPool().query(
    `SELECT viewport, kind, label, dom_found, visible, box_json, hit_test,
            screenshot, verdict, confidence FROM ui_checks WHERE scan_id = ? ORDER BY id ASC LIMIT 100`,
    [scanId],
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    viewport: r['viewport'] as string,
    kind: r['kind'] as string,
    label: r['label'] as string,
    domFound: (r['dom_found'] as number) === 1,
    visible: (r['visible'] as number) === 1,
    box: safeJsonObject(r['box_json']) as Record<string, number>,
    hitTest: (r['hit_test'] as string | null) ?? null,
    screenshot: (r['screenshot'] as string | null) ?? null,
    verdict: r['verdict'] as string,
    confidence: r['confidence'] as string,
  }));
}

export async function saveQuality(scanId: number, quality: ScanQuality): Promise<void> {
  await getPool().query('UPDATE scans SET quality = ? WHERE id = ?', [JSON.stringify(quality), scanId]);
}

export async function getQuality(scanId: number): Promise<ScanQuality | null> {
  const [rows] = await getPool().query('SELECT quality FROM scans WHERE id = ?', [scanId]);
  const raw = (rows as { quality: string | object | null }[])[0]?.quality ?? null;
  if (!raw) return null;
  try {
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as ScanQuality;
  } catch {
    return null;
  }
}

export interface ScanLogEntry {
  t: string;
  stage: string;
  status: 'running' | 'done' | 'error';
  msg: string;
}

export async function appendScanLog(scanId: number, entry: ScanLogEntry): Promise<void> {
  const pool = getPool();
  const msg = entry.msg.length > 3000 ? `${entry.msg.slice(0, 3000)}\n  ...truncated` : entry.msg;
  await pool.query(
    `INSERT INTO scan_logs (scan_id, timestamp, stage, status, message) VALUES (?, ?, ?, ?, ?)`,
    [scanId, entry.t, entry.stage, entry.status, msg],
  );
  broadcastLog(scanId, { t: entry.t, stage: entry.stage, status: entry.status, msg });
}

export async function getScanLog(scanId: number): Promise<ScanLogEntry[]> {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT timestamp, stage, status, message FROM scan_logs WHERE scan_id = ? ORDER BY id ASC LIMIT 500`,
    [scanId],
  );
  return (rows as { timestamp: string; stage: string; status: string; message: string }[]).map((r) => ({
    t: r.timestamp,
    stage: r.stage,
    status: r.status as ScanLogEntry['status'],
    msg: r.message,
  }));
}

export async function getWebsiteContactEmail(websiteId: number): Promise<string | null> {
  try {
    const [rows] = await getPool().query('SELECT contact_email FROM websites WHERE id = ?', [websiteId]);
    return ((rows as { contact_email: string | null }[])[0]?.contact_email ?? null) as string | null;
  } catch {
    return null;
  }
}

export async function saveHarvestedContactEmail(websiteId: number, email: string): Promise<boolean> {
  try {
    const [r] = await getPool().query(
      'UPDATE websites SET contact_email = ? WHERE id = ? AND contact_email IS NULL',
      [email.slice(0, 320), websiteId],
    );
    return ((r as { affectedRows: number }).affectedRows ?? 0) > 0;
  } catch {
    return false;
  }
}

export interface EmailVerification {
  status: string | null;
  checkedAt: string | null;
  verifiedEmail: string | null;
  manual: boolean;
}

export async function getEmailVerification(websiteId: number): Promise<EmailVerification> {
  try {
    const [rows] = await getPool().query(
      'SELECT email_status, email_checked_at, verified_email, email_manual FROM websites WHERE id = ?',
      [websiteId],
    );
    const r = (rows as { email_status: string | null; email_checked_at: Date | null; verified_email: string | null; email_manual: number | null }[])[0];
    return {
      status: r?.email_status ?? null,
      checkedAt: r?.email_checked_at ? new Date(r.email_checked_at).toISOString() : null,
      verifiedEmail: r?.verified_email ?? null,
      manual: (r?.email_manual ?? 0) !== 0,
    };
  } catch {
    return { status: null, checkedAt: null, verifiedEmail: null, manual: false };
  }
}

export async function saveEmailVerification(
  websiteId: number,
  email: string,
  outcome: { verdict: string; confidence: string; reason: string; evidence: unknown },
): Promise<void> {
  try {
    await getPool().query(
      'UPDATE websites SET email_status = ?, email_checked_at = NOW(), verified_email = ?, email_evidence = ?, email_reason = ?, email_confidence = ? WHERE id = ? AND (email_manual IS NULL OR email_manual = 0)',
      [
        outcome.verdict,
        email.slice(0, 320),
        JSON.stringify(outcome.evidence ?? {}).slice(0, 8000),
        outcome.reason.slice(0, 255),
        outcome.confidence,
        websiteId,
      ],
    );
  } catch {
    /* verification must never break a scan */
  }
}

export async function markEmailManual(websiteId: number, status: 'VALID' | 'UNVERIFIED'): Promise<boolean> {
  try {
    const [rows] = await getPool().query('SELECT contact_email FROM websites WHERE id = ?', [websiteId]);
    const email = (rows as { contact_email: string | null }[])[0]?.contact_email;
    if (!email) return false;
    const evidence = JSON.stringify({
      manual: true,
      reason: 'Confirmed by operator — rescan-proof until the address changes',
    });
    const [r] = await getPool().query(
      'UPDATE websites SET email_status = ?, email_checked_at = NOW(), verified_email = ?, email_reason = ?, email_confidence = ?, email_evidence = ?, email_manual = 1 WHERE id = ?',
      [status, email.slice(0, 320), 'Confirmed by operator', status === 'VALID' ? 'HIGH' : 'MEDIUM', evidence, websiteId],
    );
    return ((r as { affectedRows: number }).affectedRows ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * M1 park filter: dead sites stay in MySQL (never hard-deleted) but are
 * excluded from outreach until a later scan succeeds. Parking must never
 * break a scan, so all failures are swallowed.
 */
export async function setParked(websiteId: number, parked: boolean): Promise<void> {
  try {
    if (parked) {
      await getPool().query('UPDATE websites SET do_not_email = 1, parked_at = NOW() WHERE id = ?', [websiteId]);
    } else {
      await getPool().query('UPDATE websites SET do_not_email = 0, parked_at = NULL WHERE id = ?', [websiteId]);
    }
  } catch {
    /* parking must never break a scan */
  }
}

/**
 * Manual lead-pipeline status (new → qualified → contacted → replied,
 * or skipped). Returns false when the website row was not found.
 */
export async function setLeadStatus(websiteId: number, status: LeadStatus, note: string | null): Promise<boolean> {
  const [result] = await getPool().query(
    'UPDATE websites SET lead_status = ?, lead_status_at = NOW(), lead_status_note = ? WHERE id = ?',
    [status, note, websiteId],
  );
  return ((result as { affectedRows: number }).affectedRows ?? 0) > 0;
}

/**
 * Auto-revive: a manually skipped lead whose re-scan now scores >= 10
 * (real leaks found) goes back to 'new' so it shows up in To-message.
 * Never touches contacted/replied — human outreach state is sacred.
 * Failures are swallowed: revive must never break a scan.
 */
export async function maybeReviveSkippedLead(websiteId: number, score: number): Promise<boolean> {
  if (score < 10) return false;
  try {
    const [result] = await getPool().query(
      `UPDATE websites SET lead_status = 'new', lead_status_at = NOW(), lead_status_note = ?
       WHERE id = ? AND lead_status = 'skipped'`,
      [`Auto-revived: re-scan scored ${score}/100`, websiteId],
    );
    return (((result as { affectedRows: number }).affectedRows ?? 0) > 0);
  } catch {
    return false;
  }
}

export async function getWebsiteNiche(websiteId: number): Promise<string> {
  try {
    const [rows] = await getPool().query('SELECT niche FROM websites WHERE id = ?', [websiteId]);
    return ((rows as { niche: string }[])[0]?.niche ?? 'general') as string;
  } catch {
    return 'general';
  }
}

export async function resetScanForRetry(id: number): Promise<void> {
  const pool = getPool();
  await pool.query('DELETE FROM findings WHERE scan_id = ?', [id]);
  await pool.query('DELETE FROM pages WHERE scan_id = ?', [id]);
  await pool.query('DELETE FROM technologies WHERE scan_id = ?', [id]);
  await pool.query('DELETE FROM security_checks WHERE scan_id = ?', [id]);
  await pool.query('DELETE FROM ui_checks WHERE scan_id = ?', [id]);
  await pool.query('DELETE FROM scan_logs WHERE scan_id = ?', [id]);
  await pool.query(
    'UPDATE scans SET status = ?, started_at = NULL, completed_at = NULL, error = NULL, opportunity_score = NULL, minor_issues_count = 0, quality = NULL, triage_brief = NULL, triage_chosen = NULL, triage_at = NULL, triage_model = NULL WHERE id = ?',
    ['pending', id],
  );
  const root = screenshotsRoot();
  const dir = path.resolve(root, String(id));
  if (dir !== root && dir.startsWith(root + path.sep)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function setWebsiteNiche(websiteId: number, niche: string): Promise<boolean> {
  const [result] = await getPool().query('UPDATE websites SET niche = ? WHERE id = ?', [niche, websiteId]);
  return (result as { affectedRows: number }).affectedRows > 0;
}

function screenshotsRoot(): string {
  return path.resolve(process.cwd(), 'screenshots');
}

export async function deleteWebsiteEverywhere(
  websiteId: number,
): Promise<{ deleted: boolean; scans: number; removedFiles: number }> {
  const pool = getPool();
  const [scanRows] = await pool.query('SELECT id FROM scans WHERE website_id = ?', [websiteId]);
  const scanIds = (scanRows as { id: number }[]).map((r) => r.id);
  const [result] = await pool.query('DELETE FROM websites WHERE id = ?', [websiteId]);
  if ((result as { affectedRows: number }).affectedRows === 0) {
    return { deleted: false, scans: 0, removedFiles: 0 };
  }
  let removedFiles = 0;
  const root = screenshotsRoot();
  for (const sid of scanIds) {
    const dir = path.resolve(root, String(sid));
    if (dir !== root && dir.startsWith(root + path.sep)) {
      try {
        const entries = await fs.readdir(dir).catch(() => [] as string[]);
        removedFiles += entries.length;
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* file cleanup must never fail the delete */
      }
    }
  }
  return { deleted: true, scans: scanIds.length, removedFiles };
}

export async function logActivity(userId: number | null, category: string, action: string, detail?: unknown, ip: string | null = null): Promise<void> {
  try {
    await getPool().query(
      'INSERT INTO activity_log (user_id, category, action, detail, ip) VALUES (?, ?, ?, ?, ?)',
      [userId, category, action, detail ? JSON.stringify(detail) : null, ip],
    );
  } catch {
    /* activity logging must never break requests */
  }
}
