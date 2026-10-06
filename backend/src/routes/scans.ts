import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPool } from '../db/mysql.js';
import { config } from '../config.js';
import { scanQueue } from '../services/queue.js';
import { ownerScope, actingUserId, authUser } from '../services/auth.js';
import {
  batchProgress,
  deleteFinding,
  deleteScan,
  getFindings,
  getQuality,
  getScan,
  getScanLog,
  getSecurityChecks,
  getTech,
  getUiChecks,
  listScans,
  listScansForWebsite,
  logActivity,
} from '../services/scans.js';
import type { ScanRow } from '../services/scans.js';
import { subscribe } from '../services/ws.js';
import type { FastifyReply } from 'fastify';

function dbError(reply: FastifyReply, _err: unknown) {
  return reply.code(503).send({ ok: false, error: 'Database unavailable. Check MySQL + .env.' });
}

function canSee(scan: ScanRow, owner: number | null): boolean {
  return owner == null || scan.createdBy?.id === owner;
}

async function ownedScan(
  req: FastifyRequest,
  reply: FastifyReply,
  id: number,
): Promise<ScanRow | null> {
  const scan = await getScan(id);
  if (!scan || !canSee(scan, ownerScope(req))) {
    await reply.code(404).send({ ok: false, error: 'Scan not found.' });
    return null;
  }
  return scan;
}

/**
 * Live scan-log stream. Exported for verify-ws.ts (shape + crash harness).
 *
 * @fastify/websocket v11+ passes the raw WebSocket as the first argument;
 * older versions passed a wrapper object with `.socket`. Support both
 * shapes and never throw — an unhandled rejection here kills the server.
 */
export function scanStreamHandler(connection: unknown, req: FastifyRequest<{ Params: { id: string } }>): void {
  type WsShape = {
    on?: (event: string, listener: () => void) => unknown;
    send?: (data: string) => unknown;
    close?: (code?: number, reason?: string) => unknown;
  };
  const ws = ((connection as { socket?: WsShape }).socket ?? connection) as WsShape;
  const closeSafe = (code: number, reason: string): void => {
    try {
      ws.close?.(code, reason);
    } catch {
      /* socket already closed */
    }
  };
  const id = Number(req.params?.id);
  if (!Number.isInteger(id) || id <= 0) {
    closeSafe(4001, 'Invalid id');
    return;
  }
  let unsub: (() => void) | null = null;
  let closed = false;
  try {
    ws.on?.('close', () => {
      closed = true;
      unsub?.();
      unsub = null;
    });
  } catch {
    /* no close event — send failures below drop the subscriber instead */
  }
  const owner = ownerScope(req);
  void getScan(id)
    .then((scan) => {
      if (closed) return;
      if (!scan || (owner != null && (scan.createdBy?.id ?? null) !== owner)) {
        closeSafe(4003, 'Scan not found');
        return;
      }
      try {
        unsub = subscribe(id, {
          send: (data) => {
            try {
              ws.send?.(String(data));
            } catch {
              unsub?.();
              unsub = null;
            }
          },
        });
      } catch {
        closeSafe(4003, 'Scan not found');
      }
    })
    .catch(() => closeSafe(4003, 'Scan not found'));
}

export async function scanRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { websiteIds?: unknown } }>('/api/scans', async (req, reply) => {
    const ids = req.body?.websiteIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
      return reply.code(400).send({ ok: false, error: 'Provide 1–100 website ids.' });
    }
    const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (clean.length === 0) return reply.code(400).send({ ok: false, error: 'No valid website ids.' });
    try {
      const [rows] = await getPool().query(
        `SELECT id, user_id, status FROM websites WHERE id IN (${clean.map(() => '?').join(',')})`,
        clean,
      );
      const owner = ownerScope(req);
      const found = new Set(
        (rows as { id: number; user_id: number | null; status: string }[])
          .filter((r) => owner == null || r.user_id === owner)
          .map((r) => r.id),
      );
      const missing = clean.filter((id) => !found.has(id));
      if (missing.length > 0) return reply.code(404).send({ ok: false, error: `Websites not found: ${missing.join(', ')}` });
      const scanIds = await scanQueue.enqueueMany(clean);
      void logActivity(actingUserId(req), 'scan', 'scan_start', { websites: clean.length, scanIds });
      return reply.code(201).send({ ok: true, scanIds });
    } catch (err) {
      req.log.error(err);
      return dbError(reply, err);
    }
  });

  app.get('/api/scans/progress', async (req, reply) => {
    try {
      const owner = ownerScope(req);
      const p = await batchProgress(owner);
      let running = scanQueue.runningCount;
      let queued = scanQueue.queuedCount;
      if (owner != null) {
        const ids = [...scanQueue.activeIds, ...scanQueue.pendingIds];
        if (ids.length === 0) {
          running = 0;
          queued = 0;
        } else {
          const [rows] = await getPool().query(
            `SELECT s.id FROM scans s JOIN websites w ON w.id = s.website_id WHERE s.id IN (${ids.map(() => '?').join(',')}) AND w.user_id = ?`,
            [...ids, owner],
          );
          const mine = new Set((rows as { id: number }[]).map((r) => r.id));
          running = scanQueue.activeIds.filter((id) => mine.has(id)).length;
          queued = scanQueue.pendingIds.filter((id) => mine.has(id)).length;
        }
      }
      return { ok: true, ...p, running, queued };
    } catch (err) {
      req.log.error(err);
      return dbError(reply, err);
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/api/scans', async (req, reply) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
      return { ok: true, scans: await listScans(limit, ownerScope(req)) };
    } catch (err) {
      req.log.error(err);
      return dbError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/scans/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      const scan = await ownedScan(req, reply, id);
      if (!scan) return;
      const findings = await getFindings(id);
      return { ok: true, scan, findings };
    } catch (err) {
      req.log.error(err);
      return dbError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/scans/:id/security', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      if (!(await ownedScan(req, reply, id))) return;
      const [checks, uiChecks, quality] = await Promise.all([getSecurityChecks(id), getUiChecks(id), getQuality(id)]);
      return {
        ok: true,
        checks,
        uiChecks,
        quality,
        disclaimer:
          'Automated, non-destructive assessment only. It does not guarantee the absence of all vulnerabilities.',
      };
    } catch (err) {
      req.log.error(err);
      return dbError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/scans/:id/tech', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      if (!(await ownedScan(req, reply, id))) return;
      return { ok: true, ...(await getTech(id)) };
    } catch (err) {
      req.log.error(err);
      return dbError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/scans/:id/log', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      if (!(await ownedScan(req, reply, id))) return;
      return { ok: true, log: await getScanLog(id) };
    } catch (err) {
      return dbError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/scans/:id/pages', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      if (!(await ownedScan(req, reply, id))) return;
      const [rows] = await getPool().query(
        `SELECT url, normalized_url, status_code, final_url, response_time_ms, is_homepage, title FROM pages WHERE scan_id = ? ORDER BY id ASC LIMIT 200`,
        [id],
      );
      return {
        ok: true,
        pages: (rows as Record<string, unknown>[]).map((r) => ({
          url: r['url'],
          normalizedUrl: r['normalized_url'],
          statusCode: r['status_code'],
          finalUrl: r['final_url'],
          responseTimeMs: r['response_time_ms'],
          isHomepage: (r['is_homepage'] as number) === 1,
          title: r['title'],
        })),
      };
    } catch (err) {
      req.log.error(err);
      return dbError(reply, err);
    }
  });

  const VIEWPORT_FILES = new Set([
    'mobile', 'desktop', 'tablet',
    'mobile-full', 'desktop-full', 'tablet-full',
    'mobile-annotated',
  ]);
  const CROP_FILE_RE = /^(mobile|desktop|tablet)(-recheck)?-cta-\d+\.png$/;
  const HERO_FILE_RE = /^(mobile|desktop|tablet)(-recheck)?-hero\.webp$/;
  const HERO_ANNOTATED_RE = /^mobile(-recheck)?-hero-annotated\.webp$/;
  const EV_FILE_RE = /^ev-(phone|overflow|cta|tap)-\d+\.webp$/;

  app.get<{ Params: { id: string }; Querystring: { viewport?: string; file?: string } }>(
    '/api/scans/:id/screenshot',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
      let name: string | null = null;
      let contentType = 'image/png';
      if (typeof req.query.file === 'string' && CROP_FILE_RE.test(req.query.file)) {
        name = req.query.file;
      } else if (typeof req.query.file === 'string' && HERO_FILE_RE.test(req.query.file)) {
        name = req.query.file;
        contentType = 'image/webp';
      } else if (typeof req.query.file === 'string' && EV_FILE_RE.test(req.query.file)) {
        name = req.query.file;
        contentType = 'image/webp';
      } else if (typeof req.query.file === 'string' && HERO_ANNOTATED_RE.test(req.query.file)) {
        name = req.query.file;
        contentType = 'image/webp';
      } else if (typeof req.query.viewport === 'string' && VIEWPORT_FILES.has(req.query.viewport)) {
        name = `${req.query.viewport}.png`;
      } else {
        return reply.code(400).send({ ok: false, error: 'Invalid screenshot name.' });
      }
      try {
        if (!(await ownedScan(req, reply, id))) return;
      } catch (err) {
        req.log.error(err);
        return dbError(reply, err);
      }
      const file = path.resolve(process.cwd(), 'screenshots', String(id), name);
      const screenshotsRoot = path.resolve(process.cwd(), 'screenshots');
      if (!file.startsWith(screenshotsRoot + path.sep)) {
        return reply.code(400).send({ ok: false, error: 'Invalid path.' });
      }
      try {
        const buf = await fs.readFile(file);
        return reply.header('Content-Type', contentType).header('Cache-Control', 'private, max-age=300').send(buf);
      } catch {
        return reply.code(404).send({ ok: false, error: 'Screenshot not available.' });
      }
    },
  );

  // List servable evidence files for a scan (heroes + annotated + clips).
  // Only allowlisted names are ever returned — no raw directory dump.
  app.get<{ Params: { id: string } }>('/api/scans/:id/screenshots', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      if (!(await ownedScan(req, reply, id))) return;
    } catch (err) {
      req.log.error(err);
      return dbError(reply, err);
    }
    const dir = path.resolve(process.cwd(), 'screenshots', String(id));
    const screenshotsRoot = path.resolve(process.cwd(), 'screenshots');
    if (!dir.startsWith(screenshotsRoot + path.sep)) {
      return reply.code(400).send({ ok: false, error: 'Invalid path.' });
    }
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return { ok: true, heroes: [], annotated: [], clips: [] };
    }
    const heroes = entries
      .filter((f) => HERO_FILE_RE.test(f))
      .sort((a, b) => a.localeCompare(b));
    const annotated = entries.filter((f) => HERO_ANNOTATED_RE.test(f)).sort();
    const clips = entries.filter((f) => EV_FILE_RE.test(f)).sort();
    return { ok: true, heroes, annotated, clips };
  });

  app.post<{ Params: { id: string } }>('/api/scans/:id/retry', async (req, reply) => {    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      if (!(await ownedScan(req, reply, id))) return;
      await scanQueue.retry(id);
      void logActivity(actingUserId(req), 'scan', 'scan_retry', { scanId: id });
      return { ok: true };
    } catch (err) {
      req.log.error(err);
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : 'Retry failed.' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/scans/:id/pause', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      if (!(await ownedScan(req, reply, id))) return;
      await scanQueue.pause(id);
      return { ok: true };
    } catch (err) {
      req.log.error(err);
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : 'Pause failed.' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/scans/:id/resume', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      if (!(await ownedScan(req, reply, id))) return;
      await scanQueue.resume(id);
      return { ok: true };
    } catch (err) {
      req.log.error(err);
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : 'Resume failed.' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/scans/:id/cancel', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      if (!(await ownedScan(req, reply, id))) return;
      await scanQueue.cancel(id);
      return { ok: true };
    } catch (err) {
      req.log.error(err);
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : 'Cancel failed.' });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/scans/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      if (!(await ownedScan(req, reply, id))) return;
      const r = await deleteScan(id);
      if (!r.deleted) return reply.code(404).send({ ok: false, error: 'Scan not found.' });
      return { ok: true };
    } catch (err) {
      if (err instanceof Error && /still running/.test(err.message)) {
        return reply.code(409).send({ ok: false, error: err.message });
      }
      req.log.error(err);
      return dbError(reply, err);
    }
  });

  app.delete<{ Params: { id: string; fid: string } }>('/api/scans/:id/findings/:fid', async (req, reply) => {
    const id = Number(req.params.id);
    const fid = Number(req.params.fid);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(fid) || fid <= 0) {
      return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    }
    try {
      if (!(await ownedScan(req, reply, id))) return;
      const r = await deleteFinding(id, fid);
      if (!r.deleted) return reply.code(404).send({ ok: false, error: 'Finding not found.' });
      return { ok: true, opportunityScore: r.opportunityScore };
    } catch (err) {
      req.log.error(err);
      return dbError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/websites/:id/scans', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'Invalid id.' });
    try {
      const owner = ownerScope(req);
      const [rows] = owner == null
        ? await getPool().query(`SELECT id FROM websites WHERE id = ?`, [id])
        : await getPool().query(`SELECT id FROM websites WHERE id = ? AND user_id = ?`, [id, owner]);
      if ((rows as unknown[]).length === 0) return reply.code(404).send({ ok: false, error: 'Website not found.' });
      return { ok: true, scans: await listScansForWebsite(id) };
    } catch (err) {
      req.log.error(err);
      return dbError(reply, err);
    }
   });

  app.get<{ Params: { id: string } }>('/api/scans/:id/stream', { websocket: true }, scanStreamHandler);
}
