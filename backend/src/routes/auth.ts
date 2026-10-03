import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/mysql.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import {
  clearSessionCookie,
  ensureSeedAdmin,
  getSessionUser,
  sessionCookieHeader,
  signToken,
  toProfile,
} from '../services/auth.js';
import { actingUserId, authUser } from '../services/auth.js';
import { logActivity } from '../services/scans.js';

function dbUnavailable(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, _err: unknown) {
  return reply.code(503).send({ ok: false, error: 'Database unavailable. Check MySQL + .env.' });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email?: unknown; password?: unknown } }>('/api/auth/login', async (req, reply) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      return reply.code(400).send({ ok: false, error: 'Email and password are required.' });
    }
    try {
      const pool = getPool();
      const [rows] = await pool.query(
        'SELECT id, email, password_hash, role, display_name, avatar_updated_at FROM users WHERE email = ?',
        [email],
      );
      const row = (rows as { id: number; email: string; password_hash: string; role: string; display_name: string | null; avatar_updated_at: Date | null }[])[0];
      if (!row || !(await verifyPassword(password, row.password_hash))) {
        void logActivity(null, 'auth', 'login_fail', { reason: 'bad_credentials' });
        return reply.code(401).send({ ok: false, error: 'Invalid email or password.' });
      }
      if (row.role !== 'admin' && row.role !== 'user') {
        return reply.code(403).send({ ok: false, error: 'Account is disabled. Contact an admin.' });
      }
      const user = toProfile({
        id: row.id,
        email: row.email,
        role: row.role,
        display_name: row.display_name,
        avatar_updated_at: row.avatar_updated_at,
      });
      reply.header('Set-Cookie', sessionCookieHeader(signToken(user)));
      void logActivity(row.id, 'auth', 'login');
      return { ok: true, user };
    } catch (err) {
      req.log.error(err);
      return dbUnavailable(reply, err);
    }
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    void logActivity(authUser(_req)?.id ?? null, 'auth', 'logout');
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    try {
      const u = (await getSessionUser(req)) ?? authUser(req);
      if (!u) return reply.code(401).send({ ok: false, error: 'Not logged in. Please log in.' });
      return { ok: true, user: u };
    } catch (err) {
      req.log.error(err);
      return dbUnavailable(reply, err);
    }
  });

  app.patch<{ Body: { displayName?: unknown } }>('/api/auth/profile', async (req, reply) => {
    const me = authUser(req);
    if (!me) return reply.code(401).send({ ok: false, error: 'Not logged in. Please log in.' });
    const raw = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : null;
    if (raw === null) return reply.code(400).send({ ok: false, error: 'displayName must be a string.' });
    if (raw.length > 60) return reply.code(400).send({ ok: false, error: 'Name must be 60 characters or less.' });
    try {
      const name = raw.length === 0 ? null : raw;
      await getPool().query('UPDATE users SET display_name = ? WHERE id = ?', [name, me.id]);
      const u = await getSessionUser(req);
      return { ok: true, user: u };
    } catch (err) {
      req.log.error(err);
      return dbUnavailable(reply, err);
    }
  });

  app.post<{ Body: { current?: unknown; next?: unknown } }>('/api/auth/password', async (req, reply) => {
    const me = authUser(req);
    if (!me) return reply.code(401).send({ ok: false, error: 'Not logged in. Please log in.' });
    const current = typeof req.body?.current === 'string' ? req.body.current : '';
    const next = typeof req.body?.next === 'string' ? req.body.next : '';
    if (!current || !next) return reply.code(400).send({ ok: false, error: 'Current and new password are required.' });
    if (next.length < 8 || next.length > 200) {
      return reply.code(400).send({ ok: false, error: 'New password must be at least 8 characters.' });
    }
    try {
      const [rows] = await getPool().query('SELECT password_hash FROM users WHERE id = ?', [me.id]);
      const row = (rows as { password_hash: string }[])[0];
      if (!row || !(await verifyPassword(current, row.password_hash))) {
        return reply.code(401).send({ ok: false, error: 'Current password is wrong.' });
      }
      await getPool().query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(next), me.id]);
      return { ok: true };
    } catch (err) {
      req.log.error(err);
      return dbUnavailable(reply, err);
    }
  });

  app.post('/api/auth/seed-admin', async (_req, reply) => {
    try {
      await ensureSeedAdmin();
      return { ok: true };
    } catch (err) {
      _req.log.error(err);
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : 'Seed failed.' });
    }
  });
}
