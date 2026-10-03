import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPool } from '../db/mysql.js';
import { NICHES } from '../scanner/niches.js';
import { normalizeUrl } from '../utils/normalizeUrl.js';
import { ownerScope, actingUserId } from '../services/auth.js';
import { scanQueue } from '../services/queue.js';
import {
  getWebsites,
  getWebsite,
  saveHarvestedContactEmail,
  setWebsiteNiche,
  markEmailManual,
  deleteWebsiteEverywhere,
  logActivity,
  setLeadStatus,
  LEAD_STATUSES,
  type LeadStatus,
} from '../services/scans.js';

const WEBSITE_SELECT = `SELECT w.*, u.email AS owner_email, u.display_name AS owner_name FROM websites w LEFT JOIN users u ON u.id = w.user_id`;

interface WebsiteRow {
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

function dbUnavailable(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, _err: unknown) {
  return reply.code(503).send({ ok: false, error: 'Database unavailable. Check MySQL + .env.' });
}

const LEAD_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function ownedWebsite(
  req: FastifyRequest,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  id: number,
): Promise<WebsiteRow | null> {
  const [rows] = await getPool().query(`${WEBSITE_SELECT} WHERE w.id = ?`, [id]);
  const row = (rows as WebsiteRow[])[0];
  const owner = ownerScope(req);
  if (!row || (owner != null && row.user_id !== owner)) {
    await reply.code(404).send({ ok: false, error: 'Website not found.' });
    return null;
  }
  return row;
}

export async function websiteRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { url?: unknown; email?: unknown; name?: unknown; business?: unknown; city?: unknown; country?: unknown; notes?: unknown } }>('/api/websites', async (req, reply) => {
    const raw = typeof req.body?.url === 'string' ? req.body.url : '';
    const emailRaw = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (emailRaw && (emailRaw.length > 320 || !LEAD_EMAIL_RE.test(emailRaw))) {
      return reply.code(400).send({ ok: false, error: `Invalid email: ${emailRaw.slice(0, 80)}` });
    }
    const opt = (v: unknown, max: number): string | null =>
      typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
    let normalized: string;
    try {
      normalized = normalizeUrl(raw);
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : 'Invalid URL. Example: emonshah.com' });
    }
    const me = actingUserId(req);
    if (me == null) return reply.code(401).send({ ok: false, error: 'Not logged in. Please log in.' });
    try {
      const pool = getPool();
      try {
        const [result] = await pool.query(
          'INSERT INTO websites (url, normalized_url, status, user_id, contact_email, contact_name, business_name, city, country, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [raw.trim(), normalized, 'pending', me, emailRaw || null, opt(req.body?.name, 255), opt(req.body?.business, 255), opt(req.body?.city, 128), opt(req.body?.country, 64), opt(req.body?.notes, 1000)],
        );
        const insertId = (result as { insertId: number }).insertId;
        const [rows] = await pool.query(`${WEBSITE_SELECT} WHERE w.id = ?`, [insertId]);
        return reply.code(201).send({ ok: true, website: (rows as WebsiteRow[])[0] ? toDTO((rows as WebsiteRow[])[0]!) : null });
      } catch (err) {
        if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
          return reply.code(409).send({ ok: false, error: 'Website already exists.' });
        }
        throw err;
      }
    } catch (err) {
      req.log.error(err);
      return dbUnavailable(reply, err);
    }
  });

  app.get('/api/websites', async (req, reply) => {
    try {
      const websites = await getWebsites(ownerScope(req));
      return { ok: true, websites: await withLatestScans(websites) };
    } catch (err) {
      req.log.error(err);
      return dbUnavailable(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/websites/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      const row = await ownedWebsite(req, reply, id);
      if (!row) return;
      return { ok: true, website: toDTO(row) };
    } catch (err) {
      req.log.error(err);
      return dbUnavailable(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: { status?: unknown } }>('/api/websites/:id/verify-email', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      if (!(await ownedWebsite(req, reply, id))) return;
      const ok = await markEmailManual(id, 'VALID');
      if (!ok) return reply.code(400).send({ ok: false, error: 'No client email on file to confirm.' });
      const [rows] = await getPool().query(`${WEBSITE_SELECT} WHERE w.id = ?`, [id]);
      return { ok: true, website: toDTO((rows as WebsiteRow[])[0]!) };
    } catch (err) {
      req.log.error(err);
      return dbUnavailable(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: { niche?: unknown; email?: unknown; name?: unknown; business?: unknown; city?: unknown; country?: unknown; notes?: unknown } }>(
    '/api/websites/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const hasLeadPatch = ['email', 'name', 'business', 'city', 'country', 'notes'].some((k) => body[k] !== undefined);
      const niche = typeof req.body?.niche === 'string' ? req.body.niche.toLowerCase() : '';
      if (niche && !NICHES.some((n) => n.id === niche)) {
        return reply.code(400).send({ ok: false, error: `Unknown niche. Allowed: ${NICHES.map((n) => n.id).join(', ')}` });
      }
      if (!niche && !hasLeadPatch) return reply.code(400).send({ ok: false, error: 'Nothing to update.' });
      try {
        const existing = await ownedWebsite(req, reply, id);
        if (!existing) return;
        if (niche) {
          const updated = await setWebsiteNiche(id, niche);
          if (!updated) return reply.code(404).send({ ok: false, error: 'Website not found.' });
        }
        if (hasLeadPatch) {
          const emailRaw = body['email'];
          const email = emailRaw === null || (typeof emailRaw === 'string' && !emailRaw.trim())
            ? null
            : typeof emailRaw === 'string'
              ? emailRaw.trim().slice(0, 320)
              : undefined;
          if (email !== undefined && email !== null && !LEAD_EMAIL_RE.test(email)) {
            return reply.code(400).send({ ok: false, error: `Invalid email: ${email.slice(0, 80)}` });
          }
          const opt = (k: string, max: number): string | null | undefined => {
            const v = body[k];
            if (v === undefined) return undefined;
            if (v === null || (typeof v === 'string' && !v.trim())) return null;
            return typeof v === 'string' ? v.trim().slice(0, max) : undefined;
          };
          const sets: string[] = [];
          const params: unknown[] = [];
          const put = (col: string, v: string | null | undefined): void => {
            if (v !== undefined) {
              sets.push(`${col} = ?`);
              params.push(v);
            }
          };
          put('contact_email', email);
          put('contact_name', opt('name', 255));
          put('business_name', opt('business', 255));
          put('city', opt('city', 128));
          put('country', opt('country', 64));
          put('notes', opt('notes', 1000));
          if (email !== undefined && email !== null && email !== existing.contact_email) {
            sets.push(`email_status = 'unknown'`, 'email_checked_at = NULL', 'verified_email = NULL', 'email_manual = 0', 'email_evidence = NULL', 'email_reason = NULL', 'email_confidence = NULL');
          }
          if (sets.length > 0) {
            await getPool().query(`UPDATE websites SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
          }
        }
        const [rows] = await getPool().query(`${WEBSITE_SELECT} WHERE w.id = ?`, [id]);
        return { ok: true, website: toDTO((rows as WebsiteRow[])[0]!) };
      } catch (err) {
        req.log.error(err);
        return dbUnavailable(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { status?: unknown; note?: unknown } }>(
    '/api/websites/:id/lead-status',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
      const status = typeof req.body?.status === 'string' ? req.body.status : '';
      if (!(LEAD_STATUSES as readonly string[]).includes(status)) {
        return reply.code(400).send({ ok: false, error: `Unknown lead status. Allowed: ${LEAD_STATUSES.join(', ')}` });
      }
      const note = typeof req.body?.note === 'string' && req.body.note.trim()
        ? req.body.note.trim().slice(0, 500)
        : null;
      try {
        const existing = await ownedWebsite(req, reply, id);
        if (!existing) return;
        if (status === 'contacted' && !existing.contact_email) {
          return reply.code(400).send({ ok: false, error: 'No email on file — add one before marking Contacted.' });
        }
        const updated = await setLeadStatus(id, status as LeadStatus, note);
        if (!updated) return reply.code(404).send({ ok: false, error: 'Website not found.' });
        void logActivity(actingUserId(req), 'website', 'lead-status', { websiteId: id, status });
        const [rows] = await getPool().query(`${WEBSITE_SELECT} WHERE w.id = ?`, [id]);
        return { ok: true, website: toDTO((rows as WebsiteRow[])[0]!) };
      } catch (err) {
        req.log.error(err);
        return dbUnavailable(reply, err);
      }
    },
  );

  app.delete<{ Body: { ids?: unknown } }>('/api/websites', async (req, reply) => {
    const raw = (req.body as { ids?: unknown } | undefined)?.ids;
    const ids = Array.isArray(raw)
      ? [...new Set(raw.filter((n): n is number => Number.isInteger(n) && (n as number) > 0))]
      : [];
    if (ids.length === 0) return reply.code(400).send({ ok: false, error: 'No website ids provided.' });
    if (ids.length > 100) return reply.code(400).send({ ok: false, error: 'Max 100 websites per bulk delete.' });
    try {
      const owner = ownerScope(req);
      // Ownership gate: only delete rows belonging to the caller.
      const [ownRows] = owner == null
        ? await getPool().query(`SELECT id FROM websites WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
        : await getPool().query(`SELECT id FROM websites WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [owner, ...ids]);
      const allowed = new Set((ownRows as { id: number }[]).map((r) => r.id));
      const deleted: number[] = [];
      const skipped: number[] = [];
      for (const id of ids) {
        if (!allowed.has(id)) {
          skipped.push(id);
          continue;
        }
        const r = await deleteWebsiteEverywhere(id);
        if (r.deleted) deleted.push(id);
        else skipped.push(id);
      }
      void logActivity(actingUserId(req), 'website', 'bulk-delete', { websiteIds: deleted });
      return { ok: true, deleted, deletedCount: deleted.length, skipped };
    } catch (err) {
      req.log.error(err);
      return dbUnavailable(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/websites/:id', async (req, reply) => {    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      if (!(await ownedWebsite(req, reply, id))) return;
      const r = await deleteWebsiteEverywhere(id);
      if (!r.deleted) return reply.code(404).send({ ok: false, error: 'Website not found.' });
      void logActivity(actingUserId(req), 'website', 'delete', { websiteId: id, scans: r.scans, files: r.removedFiles });
      return { ok: true, removed: { scans: r.scans, files: r.removedFiles } };
    } catch (err) {
      req.log.error(err);
      return dbUnavailable(reply, err);
    }
  });

  app.get<{ Querystring: { q?: string } }>('/api/websites/search', async (req, reply) => {
    const q = typeof req.query?.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
    if (!q) return { ok: true, websites: [] };
    try {
      const owner = ownerScope(req);
      const [rows] = owner == null
        ? await getPool().query(`${WEBSITE_SELECT} WHERE w.url LIKE ? OR w.normalized_url LIKE ? OR w.contact_email LIKE ? ORDER BY w.created_at DESC, w.id DESC LIMIT 50`, [`%${q}%`, `%${q}%`, `%${q}%`])
        : await getPool().query(`${WEBSITE_SELECT} WHERE w.user_id = ? AND (w.url LIKE ? OR w.normalized_url LIKE ? OR w.contact_email LIKE ?) ORDER BY w.created_at DESC, w.id DESC LIMIT 50`, [owner, `%${q}%`, `%${q}%`, `%${q}%`]);
      return { ok: true, websites: (rows as WebsiteRow[]).map(toDTO) };
    } catch (err) {
      req.log.error(err);
      return dbUnavailable(reply, err);
    }
  });
}

export interface LatestScanDTO {
  id: number;
  status: string;
  opportunityScore: number | null;
  findingCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface SuggestedAction {
  action: 'message' | 'skip' | 'needs-scan';
  reason: string;
}

/**
 * Marketing rule: message only when there is something real to sell
 * (completed scan, score >= 10) AND a way to reach them (email on file,
 * not parked). Everything else is skip — except unscanned sites which
 * need a scan first.
 */
export function suggestLeadAction(
  w: { doNotEmail: boolean; contactEmail: string | null },
  ls: LatestScanDTO | null,
): SuggestedAction {
  if (w.doNotEmail) return { action: 'skip', reason: 'Parked — dead site' };
  if (!w.contactEmail) return { action: 'skip', reason: 'No email on file' };
  if (!ls) return { action: 'needs-scan', reason: 'Not scanned yet' };
  if (ls.status !== 'completed') return { action: 'needs-scan', reason: `Scan ${ls.status}` };
  const score = ls.opportunityScore ?? 0;
  if (score >= 10) return { action: 'message', reason: `Score ${score} — worth outreach` };
  return { action: 'skip', reason: `Score ${score} — no real leaks` };
}

/**
 * One query for the newest scan of every website in the list, so the
 * Websites table can show live status + a View button without N requests.
 */
async function withLatestScans<T extends { id: number }>(
  websites: T[],
): Promise<(T & { latestScan: LatestScanDTO | null; suggestedAction: SuggestedAction | null })[]> {
  if (websites.length === 0) return [];
  try {
    const ids = websites.map((w) => w.id);
    const [rows] = await getPool().query(
      `SELECT s.website_id, s.id, s.status, s.opportunity_score, s.created_at, s.completed_at,
              (SELECT COUNT(*) FROM findings f WHERE f.scan_id = s.id) AS finding_count
       FROM scans s
       WHERE s.id IN (SELECT MAX(s2.id) FROM scans s2 WHERE s2.website_id IN (${ids.map(() => '?').join(',')}) GROUP BY s2.website_id)`,
      ids,
    );
    const byWebsite = new Map<number, LatestScanDTO>();
    for (const r of rows as { website_id: number; id: number; status: string; opportunity_score: number | null; finding_count: number; created_at: Date; completed_at: Date | null }[]) {
      byWebsite.set(r.website_id, {
        id: r.id,
        status: r.status,
        opportunityScore: r.opportunity_score,
        findingCount: Number(r.finding_count ?? 0),
        createdAt: new Date(r.created_at).toISOString(),
        completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
      });
    }
    return websites.map((w) => {
      const latestScan = byWebsite.get(w.id) ?? null;
      const dto = w as T & { doNotEmail?: boolean; contactEmail?: string | null };
      const suggestedAction =
        typeof dto.doNotEmail === 'boolean'
          ? suggestLeadAction(
            { doNotEmail: dto.doNotEmail, contactEmail: dto.contactEmail ?? null },
            latestScan,
          )
          : null;
      return { ...w, latestScan, suggestedAction };
    });
  } catch {
    return websites.map((w) => ({ ...w, latestScan: null, suggestedAction: null }));
  }
}

function toDTO(r: WebsiteRow) {
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
    leadStatus: (LEAD_STATUSES as readonly string[]).includes(r.lead_status ?? '') ? r.lead_status : 'new',
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
