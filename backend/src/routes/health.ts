import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { checkDb } from '../db/mysql.js';

let cachedVersion: string | null = null;

/** App version: backend/package.json (works in tsx-dev and dist builds). */
export function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    cachedVersion = typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const db = await checkDb();
    return {
      ok: true,
      service: 'leak-scanner-backend',
      version: appVersion(),
      timestamp: new Date().toISOString(),
      db,
    };
  });

  // Update channel: the frontend banner compares this against the latest
  // GitHub release. No auth needed — version is not sensitive.
  app.get('/api/version', async () => ({ ok: true, version: appVersion() }));
}
