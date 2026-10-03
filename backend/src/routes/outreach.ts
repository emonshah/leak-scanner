import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/mysql.js';
import { NICHES } from '../scanner/niches.js';
import { normalizeUrl } from '../utils/normalizeUrl.js';
import { actingUserId, ownerScope } from '../services/auth.js';
import { scanQueue } from '../services/queue.js';
import { getFindings, getQuality, getScan, getTech, logActivity, LEAD_STATUSES } from '../services/scans.js';
import { parseBulkInput, toLeadCsv } from '../services/outreach.js';
import { buildLlmBrief } from '../services/llm-brief.js';

const LEAD_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const nicheIds = new Set(NICHES.map((n) => n.id));

export async function outreachRoutes(app: FastifyInstance): Promise<void> {
  // Bulk import: textarea paste or CSV rows. Dedupes per-owner via normalized_url.
  app.post<{ Body: { text?: unknown; items?: unknown; autoScan?: unknown; niche?: unknown } }>(
    '/api/websites/bulk',
    async (req, reply) => {
      const me = actingUserId(req);
      if (me == null) return reply.code(401).send({ ok: false, error: 'Not logged in.' });
      let raw = '';
      if (typeof req.body?.text === 'string') raw = req.body.text;
      else if (Array.isArray(req.body?.items)) {
        raw = (req.body.items as unknown[])
          .map((it) => {
            if (typeof it === 'string') return it;
            if (it && typeof it === 'object') {
              const o = it as Record<string, unknown>;
              return [o['url'], o['email'], o['niche'], o['name'], o['business'], o['city']]
                .filter((v) => typeof v === 'string' && (v as string).trim())
                .join(', ');
            }
            return '';
          })
          .join('\n');
      }
      if (!raw.trim()) return reply.code(400).send({ ok: false, error: 'Paste 1+ URLs (one per line: url, email, niche, name, business, city).' });
      if (raw.length > 100_000) return reply.code(400).send({ ok: false, error: 'Bulk input too large (max 100KB).' });

      const { rows, errors } = parseBulkInput(raw);
      if (rows.length === 0) return reply.code(400).send({ ok: false, error: 'No valid rows found.', errors });
      const defaultNiche = typeof req.body?.niche === 'string' && nicheIds.has(req.body.niche.toLowerCase())
        ? (req.body.niche as string).toLowerCase()
        : 'general';
      const autoScan = req.body?.autoScan === true;

      const pool = getPool();
      let created = 0;
      let skipped = 0;
      const createdIds: number[] = [];
      const rowErrors: { line: number; error: string }[] = [...errors];

      for (const r of rows.slice(0, 100)) {
        let normalized: string;
        try {
          normalized = normalizeUrl(r.url);
        } catch (err) {
          rowErrors.push({ line: r.line, error: err instanceof Error ? err.message : `Invalid URL: ${r.url.slice(0, 80)}` });
          continue;
        }
        const email = r.email?.trim() || null;
        if (email && (email.length > 320 || !LEAD_EMAIL_RE.test(email))) {
          rowErrors.push({ line: r.line, error: `Invalid email: ${email.slice(0, 80)}` });
          continue;
        }
        const niche = r.niche && nicheIds.has(r.niche) ? r.niche : defaultNiche;
        try {
          const [res] = await pool.query(
            `INSERT INTO websites (url, normalized_url, status, user_id, contact_email, contact_name, business_name, city, niche)
             VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
            [
              r.url.trim().slice(0, 2048),
              normalized.slice(0, 2048),
              me,
              email,
              r.name?.slice(0, 255) ?? null,
              r.business?.slice(0, 255) ?? null,
              r.city?.slice(0, 128) ?? null,
              niche,
            ],
          );
          const insertId = (res as { insertId: number }).insertId;
          // Detect true insert vs duplicate: check affectedRows==1 means new.
          const affected = (res as { affectedRows: number }).affectedRows ?? 0;
          if (affected === 1) {
            created++;
            createdIds.push(insertId);
          } else {
            skipped++;
          }
        } catch (err) {
          req.log.error(err);
          rowErrors.push({ line: r.line, error: 'DB insert failed' });
        }
      }

      let scanIds: number[] = [];
      if (autoScan && createdIds.length > 0) {
        try {
          scanIds = await scanQueue.enqueueMany(createdIds);
        } catch (err) {
          req.log.error(err);
        }
      }
      void logActivity(me, 'website', 'bulk_import', { created, skipped, autoScan });
      return { ok: true, created, skipped, websiteIds: createdIds, scanIds, errors: rowErrors.slice(0, 30) };
    },
  );

  // Lead export: latest scan per website (owner-scoped) as JSON or CSV.
  app.get<{ Querystring: { format?: string; minScore?: string; niche?: string; leadStatus?: string; excludeActed?: string } }>(
    '/api/leads/export',
    async (req, reply) => {
      try {
        const owner = ownerScope(req);
        const minScore = Math.max(0, Number(req.query.minScore ?? 0) || 0);
        const niche = typeof req.query.niche === 'string' && req.query.niche ? req.query.niche.toLowerCase() : null;
        const leadStatus = typeof req.query.leadStatus === 'string' && req.query.leadStatus ? req.query.leadStatus : null;
        const leadStatuses = (leadStatus ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const s of leadStatuses) {
          if (!(LEAD_STATUSES as readonly string[]).includes(s)) {
            return reply.code(400).send({ ok: false, error: `Unknown lead status: ${s.slice(0, 40)}. Allowed: ${LEAD_STATUSES.join(', ')}` });
          }
        }
        // excludeActed=1 hides skipped/contacted/replied — the "still to work" list.
        const excludeActed = req.query.excludeActed === '1';
        const params: unknown[] = [];
        let where = '';
        if (owner != null) {
          where += ' AND w.user_id = ?';
          params.push(owner);
        }
        if (niche) {
          where += ' AND w.niche = ?';
          params.push(niche);
        }
        if (leadStatuses.length > 0) {
          where += ` AND w.lead_status IN (${leadStatuses.map(() => '?').join(',')})`;
          params.push(...leadStatuses);
        } else if (excludeActed) {
          where += ` AND (w.lead_status IS NULL OR w.lead_status NOT IN ('skipped','contacted','replied'))`;
        }
        const [rows] = await getPool().query(
          `SELECT w.id AS website_id, w.url, w.contact_email, w.email_status, w.niche,
                  w.business_name, w.contact_name, w.city, w.lead_status,
                  s.id AS scan_id, s.status AS scan_status, s.opportunity_score AS score,
                  (SELECT f.title FROM findings f WHERE f.scan_id = s.id ORDER BY f.priority_score DESC LIMIT 1) AS top_issue
           FROM websites w
           LEFT JOIN scans s ON s.id = (SELECT MAX(s2.id) FROM scans s2 WHERE s2.website_id = w.id)
           WHERE 1=1 ${where} AND (w.do_not_email IS NULL OR w.do_not_email = 0) AND (s.opportunity_score IS NULL OR s.opportunity_score >= ?)
           ORDER BY s.opportunity_score DESC, w.id DESC LIMIT 500`,
          [...params, minScore],
        );
        const list = rows as Record<string, unknown>[];
        // Parked (M1 dead-site) leads are excluded above; report counts so
        // the operator knows what was skipped and what is due a re-scan.
        let parkedSkipped = 0;
        let rescanDue = 0;
        try {
          const [pRows] = owner == null
            ? await getPool().query(
              `SELECT COUNT(*) AS n, SUM(parked_at IS NOT NULL AND parked_at < NOW() - INTERVAL 7 DAY) AS due
               FROM websites w WHERE w.do_not_email = 1 ${niche ? 'AND w.niche = ?' : ''}`,
              niche ? [niche] : [],
            )
            : await getPool().query(
              `SELECT COUNT(*) AS n, SUM(parked_at IS NOT NULL AND parked_at < NOW() - INTERVAL 7 DAY) AS due
               FROM websites w WHERE w.do_not_email = 1 AND w.user_id = ? ${niche ? 'AND w.niche = ?' : ''}`,
              niche ? [owner, niche] : [owner],
            );
          const pr = (pRows as { n: number; due: number | null }[])[0];
          parkedSkipped = Number(pr?.n ?? 0);
          rescanDue = Number(pr?.due ?? 0);
        } catch {
          /* counts are informational only */
        }
        if (req.query.format === 'csv') {
          const csv = toLeadCsv(list);
          return reply.header('Content-Type', 'text/csv; charset=utf-8')
            .header('Content-Disposition', 'attachment; filename="leads.csv"')
            .send(csv);
        }
        return { ok: true, leads: list, count: list.length, parkedSkipped, rescanDue };
      } catch (err) {
        req.log.error(err);
        return reply.code(503).send({ ok: false, error: 'Database unavailable.' });
      }
    },
  );

  // Cold-email draft for a scan: deterministic subject + body + fix bullets.
  // LLM brief for a scan: copy-paste prompt pack (instruction + lead facts
  // + scan evidence + output rules) so any LLM can write the cold email.
  app.get<{ Params: { id: string }; Querystring: { sender?: string } }>(
    '/api/scans/:id/llm-brief',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
      try {
        const scan = await getScan(id);
        if (!scan) return reply.code(404).send({ ok: false, error: 'Scan not found.' });
        const owner = ownerScope(req);
        if (owner != null && scan.createdBy?.id !== owner) {
          return reply.code(404).send({ ok: false, error: 'Scan not found.' });
        }
        const [wrows] = await getPool().query(
          'SELECT id, url, business_name, contact_name, contact_email, niche, city FROM websites WHERE id = ?',
          [scan.websiteId],
        );
        const w = (wrows as Record<string, unknown>[])[0];
        if (!w) return reply.code(404).send({ ok: false, error: 'Website not found.' });
        const [findings, tech, pageRows] = await Promise.all([
          getFindings(id),
          getTech(id),
          getPool().query('SELECT COUNT(*) AS n FROM pages WHERE scan_id = ?', [id]),
        ]);
        const sender = typeof req.query.sender === 'string' && req.query.sender.trim()
          ? req.query.sender.trim().slice(0, 60)
          : 'Emon';
        const techItems = ((tech as { items?: { technology: string; version: string | null }[] }).items ?? [])
          .slice(0, 6)
          .map((t) => (t.version ? `${t.technology} ${t.version}` : t.technology));
        const platform = (tech as { primaryPlatform?: string | null }).primaryPlatform ?? null;
        const techSummary = [...(platform ? [`Platform: ${platform}`] : []), ...(techItems.length > 0 ? [`Stack: ${techItems.join(', ')}`] : [])].join(' | ') || null;
        const brief = buildLlmBrief(
          {
            id: w['id'] as number,
            url: w['url'] as string,
            businessName: (w['business_name'] as string | null) ?? null,
            contactName: (w['contact_name'] as string | null) ?? null,
            contactEmail: (w['contact_email'] as string | null) ?? null,
            niche: ((w['niche'] as string) ?? 'general') as string,
            city: (w['city'] as string | null) ?? null,
          },
          { id: scan.id, opportunityScore: scan.opportunityScore, status: scan.status },
          findings,
          techSummary,
          sender,
          {
            pagesCrawled: Number((((pageRows as unknown) as { n: number }[])[0] ?? { n: 0 }).n),
            scanDate: scan.completedAt ?? scan.createdAt ?? null,
          },
        );
        return { ok: true, scanId: scan.id, chars: brief.length, brief };
      } catch (err) {
        req.log.error(err);
        return reply.code(503).send({ ok: false, error: 'Database unavailable.' });
      }
    },
  );

  // Printable 1-page client report (JSON -> frontend print view / PDF via browser).
  app.get<{ Params: { id: string } }>('/api/scans/:id/report', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      const scan = await getScan(id);
      if (!scan) return reply.code(404).send({ ok: false, error: 'Scan not found.' });
      const owner = ownerScope(req);
      if (owner != null && scan.createdBy?.id !== owner) {
        return reply.code(404).send({ ok: false, error: 'Scan not found.' });
      }
      const [wrows] = await getPool().query(
        'SELECT id, url, business_name, contact_name, contact_email, niche, city, primary_tech FROM websites WHERE id = ?',
        [scan.websiteId],
      );
      const website = (wrows as Record<string, unknown>[])[0] ?? null;
      const [findings, quality, tech] = await Promise.all([getFindings(id), getQuality(id), getTech(id)]);
      return {
        ok: true,
        scan,
        website,
        findings: findings.slice(0, 20),
        quality,
        tech,
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ ok: false, error: 'Database unavailable.' });
    }
  });

}
