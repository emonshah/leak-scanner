import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: envInt('PORT', 3000),
  nodeEnv: env('NODE_ENV', 'development'),
  publicAppUrl: env('PUBLIC_APP_URL', 'http://localhost:3000'),
  db: {
    host: env('DB_HOST', 'localhost'),
    port: envInt('DB_PORT', 3306),
    user: env('DB_USER', 'leak_scanner'),
    password: env('DB_PASS', ''),
    database: env('DB_NAME', 'leak_scanner'),
  },
  scan: {
    concurrency: envInt('SCAN_CONCURRENCY', 3),
    timeoutMs: envInt('SCAN_TIMEOUT_MS', 300000),
    maxPages: envInt('SCAN_MAX_PAGES', 12),
  },
  headful: env('HEADFUL', '0') === '1',
  allowPrivate: env('SCAN_ALLOW_PRIVATE', '0') === '1',
  auth: {
    secret: env('AUTH_SECRET', 'change-me-in-dot-env-auth'),
    adminEmail: env('ADMIN_EMAIL', 'admin@local.test'),
    adminPassword: env('ADMIN_PASSWORD', 'change-me-now'),
    sessionDays: 7,
    cookieSecure: env('COOKIE_SECURE', '0') === '1',
  },
  qwen: {
    baseUrl: env('QWEN_BASE_URL', 'https://qwen.emonshah.com').replace(/\/$/, ''),
    model: env('QWEN_MODEL', 'qwen2.5:3b'),
    timeoutMs: envInt('QWEN_TIMEOUT_MS', 60000),
  },
} as const;

export function logConfigSummary(logger: { warn: (m: string) => void }): void {
  if (!process.env['DB_PASS']) {
    logger.warn('DB_PASS is empty. MySQL will be wired in — set it in .env then.');
  }
  if (!process.env['AUTH_SECRET']) {
    logger.warn('AUTH_SECRET is not set — using an insecure default. Set a long random value in .env.');
  }
  if (!process.env['ADMIN_PASSWORD']) {
    logger.warn('ADMIN_PASSWORD is not set — seed admin uses an insecure default. Change it after first login.');
  }
}
