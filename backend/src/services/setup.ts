import fs from 'node:fs';
import path from 'node:path';
import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';
import { hashPassword } from '../utils/password.js';
import { ensureSchemaWithPool, createPoolWithConfig, resetPool, closePool as closeGlobalPool } from '../db/mysql.js';

export const SETUP_FLAG_FILE = '.setup-complete';
export const ENV_FILE = '.env';

export interface SetupPayload {
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  adminEmail: string;
  adminName: string;
  adminPassword: string;
  authSecret: string;
  appUrl?: string;
}

export interface SetupProgress {
  step: string;
  ok: boolean;
  error?: string;
}

export function isSetupComplete(): boolean {
  return fs.existsSync(path.resolve(process.cwd(), SETUP_FLAG_FILE));
}

/**
 * Read the persisted DB config from .env (best-effort). Falls back to
 * process environment (env vars pass DB_* directly without mounting
 * a .env file). Returns null when neither source has the required keys.
 */
export function getEnvDbConfig(): SetupPayload | null {
  const envPath = path.resolve(process.cwd(), ENV_FILE);
  if (fs.existsSync(envPath)) {
    const get = (k: string): string | undefined => {
      const m = new RegExp(`^${k}=(.*)$`, 'm').exec(fs.readFileSync(envPath, 'utf8'));
      return m?.[1]?.trim();
    };
    const host = get('DB_HOST');
    const name = get('DB_NAME');
    const user = get('DB_USER');
    if (host && name && user) {
      return {
        dbHost: host,
        dbPort: get('DB_PORT') ? Number(get('DB_PORT')) : 3306,
        dbName: name,
        dbUser: user,
        dbPassword: get('DB_PASS') ?? '',
        adminEmail: get('ADMIN_EMAIL') ?? 'admin@local.test',
        adminName: get('ADMIN_NAME') ?? 'Admin',
        adminPassword: get('ADMIN_PASSWORD') ?? '',
        authSecret: get('AUTH_SECRET') ?? '',
        appUrl: get('PUBLIC_APP_URL') ?? undefined,
      };
    }
  }
  const host = process.env['DB_HOST'];
  const name = process.env['DB_NAME'];
  const user = process.env['DB_USER'];
  if (!host || !name || !user) return null;
  return {
    dbHost: host,
    dbPort: process.env['DB_PORT'] ? Number(process.env['DB_PORT']) : 3306,
    dbName: name,
    dbUser: user,
    dbPassword: process.env['DB_PASS'] ?? '',
    adminEmail: process.env['ADMIN_EMAIL'] ?? 'admin@local.test',
    adminName: process.env['ADMIN_NAME'] ?? 'Admin',
    adminPassword: process.env['ADMIN_PASSWORD'] ?? '',
    authSecret: process.env['AUTH_SECRET'] ?? '',
    appUrl: process.env['PUBLIC_APP_URL'] ?? undefined,
  };
}

/**
 * True setup health check — simple logic, exactly as it should be:
 *   DB (.env config) connects AND required tables exist → configured (login)
 *   anything else → not configured (setup wizard)
 *
 * A dedicated pool is opened from the persisted .env every time (never the
 * stale global pool), so a just-completed setup is detected correctly even
 * before the process restarts with the new config.
 */
export async function checkSetupHealth(): Promise<{ configured: boolean; reason?: string }> {
  if (!isSetupComplete()) {
    // Env-based deploy: no wizard, no flag file. If the
    // environment DB is usable AND a seeded admin exists, boot already did
    // everything — count as configured so login works immediately.
    const cfg = getEnvDbConfig();
    if (!cfg) return { configured: false, reason: 'flag-missing' };
    const usable = await checkDbUsable(cfg);
    if (!usable.configured) return usable;
    let pool: Pool | null = null;
    try {
      pool = mysql.createPool({
        host: cfg.dbHost,
        port: cfg.dbPort,
        user: cfg.dbUser,
        password: cfg.dbPassword,
        database: cfg.dbName,
        connectionLimit: 1,
      });
      const [rows] = await pool.query('SELECT COUNT(*) AS n FROM users');
      if (Number((rows as { n: number }[])[0]?.n ?? 0) > 0) return { configured: true };
    } catch {
      /* fall through to not-configured */
    } finally {
      await pool?.end().catch(() => undefined);
    }
    return { configured: false, reason: 'flag-missing' };
  }
  const cfg = getEnvDbConfig();
  if (!cfg) return { configured: false, reason: 'env-missing' };
  return checkDbUsable(cfg);
}

/** Every table ensureSchema() creates — all must exist for the app to run. */
const REQUIRED_TABLES = [
  'users',
  'websites',
  'scans',
  'scan_logs',
  'pages',
  'findings',
  'security_checks',
  'ui_checks',
  'technologies',
  'email_verifications',
  'research_jobs',
  'outreach_campaigns',
  'outreach_emails',
  'activity_log',
];

/**
 * Single fresh-pool check: connect + SELECT 1 + all tables present.
 * Dropping the tables (or pointing at an empty DB) → not configured,
 * so the frontend auto-redirects to the setup wizard.
 */
export async function checkDbUsable(payload: SetupPayload): Promise<{ configured: boolean; reason?: string }> {
  let pool: Pool | null = null;
  try {
    pool = mysql.createPool({
      host: payload.dbHost,
      port: payload.dbPort,
      user: payload.dbUser,
      password: payload.dbPassword,
      database: payload.dbName,
      waitForConnections: true,
      connectionLimit: 1,
      queueLimit: 0,
      connectTimeout: 10000,
    });
    await pool.query('SELECT 1 AS ok');
    const [rows] = await pool.query('SHOW TABLES');
    const names = new Set(
      (rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0] ?? '').toLowerCase()),
    );
    const missing = REQUIRED_TABLES.filter((t) => !names.has(t));
    if (missing.length > 0) {
      return { configured: false, reason: `schema-missing: ${missing.join(', ')}` };
    }
    return { configured: true };
  } catch (err) {
    return { configured: false, reason: `db-unreachable: ${err instanceof Error ? err.message : 'unknown'}` };
  } finally {
    if (pool) {
      await pool.end().catch(() => undefined);
    }
  }
}

/** Cached health result, refreshed at most every TTL_MS. */
let cachedHealth: { configured: boolean; reason?: string; at: number } | null = null;
const HEALTH_TTL_MS = 10_000;

export async function isSetupHealthy(): Promise<boolean> {
  const now = Date.now();
  if (cachedHealth && now - cachedHealth.at < HEALTH_TTL_MS) return cachedHealth.configured;
  cachedHealth = { ...(await checkSetupHealth()), at: now };
  return cachedHealth.configured;
}

export function invalidateSetupCache(): void {
  cachedHealth = null;
}

export async function validateDbConnection(payload: SetupPayload): Promise<{ ok: boolean; error?: string }> {
  let pool: Pool | null = null;
  try {
    pool = mysql.createPool({
      host: payload.dbHost,
      port: payload.dbPort,
      user: payload.dbUser,
      password: payload.dbPassword,
      database: payload.dbName,
      waitForConnections: true,
      connectionLimit: 1,
      queueLimit: 0,
      connectTimeout: 10000,
    });
    const [rows] = await pool.query('SELECT 1 AS ok');
    const arr = rows as { ok: number }[];
    if (!arr[0] || arr[0].ok !== 1) {
      return { ok: false, error: 'Unexpected DB response' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
  } finally {
    if (pool) {
      await pool.end().catch(() => undefined);
    }
  }
}

export async function validateRootDbConnection(payload: SetupPayload): Promise<{ ok: boolean; error?: string }> {
  let pool: Pool | null = null;
  try {
    pool = mysql.createPool({
      host: payload.dbHost,
      port: payload.dbPort,
      user: payload.dbUser,
      password: payload.dbPassword,
      waitForConnections: true,
      connectionLimit: 1,
      queueLimit: 0,
      connectTimeout: 10000,
    });
    const [rows] = await pool.query('SELECT 1 AS ok');
    const arr = rows as { ok: number }[];
    if (!arr[0] || arr[0].ok !== 1) {
      return { ok: false, error: 'Unexpected DB response' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
  } finally {
    if (pool) {
      await pool.end().catch(() => undefined);
    }
  }
}

export async function createDatabase(payload: SetupPayload): Promise<{ ok: boolean; error?: string }> {
  let pool: Pool | null = null;
  try {
    pool = mysql.createPool({
      host: payload.dbHost,
      port: payload.dbPort,
      user: payload.dbUser,
      password: payload.dbPassword,
      waitForConnections: true,
      connectionLimit: 1,
      queueLimit: 0,
      connectTimeout: 10000,
    });
    const escaped = `\`${payload.dbName.replace(/`/g, '``')}\``;
    await pool.query(`CREATE DATABASE IF NOT EXISTS ${escaped} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Create database failed' };
  } finally {
    if (pool) {
      await pool.end().catch(() => undefined);
    }
  }
}

export function writeEnvFile(payload: SetupPayload): void {
  const appUrl = payload.appUrl ?? 'http://localhost:3000';
  // HTTPS origins (e.g. a Cloudflare Tunnel) require the Secure cookie flag,
  // otherwise the browser drops the session cookie after login.
  const cookieSecure = appUrl.startsWith('https://') ? '1' : '0';
  const lines = [
    '# Database',
    `DB_HOST=${payload.dbHost}`,
    `DB_PORT=${payload.dbPort}`,
    `DB_NAME=${payload.dbName}`,
    `DB_USER=${payload.dbUser}`,
    `DB_PASS=${payload.dbPassword}`,
    '',
    '# Auth',
    `AUTH_SECRET=${payload.authSecret}`,
    `ADMIN_EMAIL=${payload.adminEmail.trim().toLowerCase()}`,
    `ADMIN_NAME=${payload.adminName}`,
    `ADMIN_PASSWORD=${payload.adminPassword}`,
    '',
    '# Server',
    `PUBLIC_APP_URL=${appUrl}`,
    `COOKIE_SECURE=${cookieSecure}`,
    'PORT=3000',
    'NODE_ENV=production',
    '',
    '# Scan settings (adjust as needed)',
    'SCAN_CONCURRENCY=3',
    'SCAN_TIMEOUT_MS=300000',
    'SCAN_MAX_PAGES=12',
    'HEADFUL=0',
    'SCAN_ALLOW_PRIVATE=0',
    '',
    '# Qwen API (optional)',
    'QWEN_BASE_URL=https://qwen.emonshah.com',
    'QWEN_MODEL=qwen2.5:3b',
    'QWEN_TIMEOUT_MS=60000',
  ];
  const envPath = path.resolve(process.cwd(), ENV_FILE);
  fs.writeFileSync(envPath, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
}

export async function runFullSetup(payload: SetupPayload, onProgress: (p: SetupProgress) => void): Promise<{ ok: boolean; error?: string }> {
  let setupPool: Pool | null = null;
  try {
    const rootCheck = await validateRootDbConnection(payload);
    onProgress({ step: 'Validating database connection', ok: rootCheck.ok, error: rootCheck.error });
    if (!rootCheck.ok) {
      return { ok: false, error: `Database connection failed: ${rootCheck.error}` };
    }

    const dbResult = await createDatabase(payload);
    onProgress({ step: 'Creating database', ok: dbResult.ok, error: dbResult.error });
    if (!dbResult.ok) {
      return { ok: false, error: `Database creation failed: ${dbResult.error}` };
    }

    writeEnvFile(payload);
    onProgress({ step: 'Writing configuration', ok: true });

    resetPool();
    const poolOpts: PoolOptions = {
      host: payload.dbHost,
      port: payload.dbPort,
      user: payload.dbUser,
      password: payload.dbPassword,
      database: payload.dbName,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    };
    setupPool = await createPoolWithConfig(poolOpts);
    await ensureSchemaWithPool(setupPool);
    onProgress({ step: 'Initializing database schema', ok: true });


    const passwordHash = await hashPassword(payload.adminPassword);
    const email = payload.adminEmail.trim().toLowerCase();
    const [existing] = await setupPool.query('SELECT id FROM users WHERE email = ?', [email]);
    const existingRows = existing as { id: number }[];
    if (existingRows.length > 0) {
      await setupPool.query('UPDATE users SET password_hash = ?, display_name = ?, role = ? WHERE email = ?', [
        passwordHash,
        payload.adminName || null,
        'admin',
        email,
      ]);
    } else {
      await setupPool.query(
        'INSERT INTO users (email, password_hash, role, display_name) VALUES (?, ?, ?, ?)',
        [email, passwordHash, 'admin', payload.adminName || null],
      );
    }

    onProgress({ step: 'Seeding admin user', ok: true });

    const flagPath = path.resolve(process.cwd(), SETUP_FLAG_FILE);
    fs.writeFileSync(flagPath, `Setup completed at ${new Date().toISOString()}\n`, { encoding: 'utf8' });
    onProgress({ step: 'Finalizing', ok: true });

    onProgress({ step: 'Complete', ok: true });
    return { ok: true };
  } catch (err) {
    onProgress({ step: 'Error', ok: false, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (setupPool) {
      await setupPool.end().catch(() => undefined);
    }
    resetPool();
    void closeGlobalPool;
  }
}

export function requestRestart(reason: string): void {
  const logger = console;
  logger.log(`[setup] ${reason}`);
}

export function triggerRestart(): void {
  console.log('[setup] Server restart triggered by /api/setup/restart');
  process.exit(0);
}
