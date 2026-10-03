import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getPool } from '../db/mysql.js';
import { hashPassword } from '../utils/password.js';

export const SESSION_COOKIE = 'ls_session';

export interface SessionUser {
  id: number;
  email: string;
  role: 'admin' | 'user';
}

export interface ProfileUser extends SessionUser {
  displayName: string | null;
  hasAvatar: boolean;
}

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  role: string;
  status: string;
  display_name: string | null;
  avatar_updated_at: Date | null;
  created_at: Date;
}

export function toProfile(row: {
  id: number;
  email: string;
  role: string;
  display_name?: string | null;
  avatar_updated_at?: Date | null;
}): ProfileUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role as 'admin' | 'user',
    displayName: row.display_name ?? null,
    hasAvatar: row.avatar_updated_at != null,
  };
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

export function signToken(user: SessionUser): string {
  const exp = Date.now() + config.auth.sessionDays * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ uid: user.id, email: user.email, role: user.role, exp }));
  const sig = crypto.createHmac('sha256', config.auth.secret).update(payload).digest();
  return `${b64urlEncode(payload)}.${b64urlEncode(sig)}`;
}

export function verifyToken(token: string): SessionUser | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const payload = b64urlDecode(parts[0]);
    const sig = b64urlDecode(parts[1]);
    const expected = crypto.createHmac('sha256', config.auth.secret).update(payload).digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
    const data = JSON.parse(payload.toString('utf8')) as { uid: unknown; email: unknown; role: unknown; exp: unknown };
    if (typeof data.uid !== 'number' || typeof data.email !== 'string') return null;
    if (data.role !== 'admin' && data.role !== 'user') return null;
    if (typeof data.exp !== 'number' || Date.now() > data.exp) return null;
    return { id: data.uid, email: data.email, role: data.role };
  } catch {
    return null;
  }
}

export function readSessionCookie(req: FastifyRequest): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export function sessionCookieHeader(token: string): string {
  const maxAge = config.auth.sessionDays * 24 * 60 * 60;
  const secure = config.auth.cookieSecure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function getSessionUser(req: FastifyRequest): Promise<ProfileUser | null> {
  const token = readSessionCookie(req);
  if (!token) return null;
  const claimed = verifyToken(token);
  if (!claimed) return null;
  const [rows] = await getPool().query(
    'SELECT id, email, role, display_name, avatar_updated_at FROM users WHERE id = ?',
    [claimed.id],
  );
  const row = (rows as { id: number; email: string; role: string; display_name: string | null; avatar_updated_at: Date | null }[])[0];
  if (!row) return null;
  if (row.role !== 'admin' && row.role !== 'user') return null;
  return toProfile(row);
}

export function authUser(req: FastifyRequest): SessionUser | null {
  return (req as unknown as { authUser?: SessionUser }).authUser ?? null;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const u = authUser(req);
  if (!u) {
    await reply.code(401).send({ ok: false, error: 'Not logged in. Please log in.' });
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const u = authUser(req);
  if (!u) {
    await reply.code(401).send({ ok: false, error: 'Not logged in. Please log in.' });
    return;
  }
  if (u.role !== 'admin') {
    await reply.code(403).send({ ok: false, error: 'Admin only.' });
  }
}

export async function ensureSeedAdmin(): Promise<void> {
  const pool = getPool();
  const [rows] = await pool.query('SELECT COUNT(*) AS n FROM users');
  const count = (rows as { n: number }[])[0]?.n ?? 0;
  if (count > 0) return;
  const email = config.auth.adminEmail.trim().toLowerCase();
  const password = config.auth.adminPassword;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`Invalid ADMIN_EMAIL in .env: ${email}`);
  }
  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  }
  const passwordHash = await hashPassword(password);
  await pool.query('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)', [email, passwordHash, 'admin']);
}

export async function ensureOwnershipBackfill(): Promise<void> {
  const pool = getPool();
  const [rows] = await pool.query(`SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`);
  const adminId = (rows as { id: number }[])[0]?.id;
  if (!adminId) return;
  await pool.query('UPDATE websites SET user_id = ? WHERE user_id IS NULL', [adminId]);
}

export function ownerScope(req: FastifyRequest): number | null {
  const u = authUser(req);
  if (!u || u.role === 'admin') return null;
  return u.id;
}

export function actingUserId(req: FastifyRequest): number | null {
  return authUser(req)?.id ?? null;
}

export type { UserRow };
