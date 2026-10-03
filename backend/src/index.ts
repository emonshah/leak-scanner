import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { config, logConfigSummary } from './config.js';
import { ensureSchema, closePool } from './db/mysql.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { websiteRoutes } from './routes/websites.js';
import { scanRoutes } from './routes/scans.js';
import { outreachRoutes } from './routes/outreach.js';
import { updateRoutes } from './routes/updates.js';
import { setupRoutes } from './routes/setup.js';
import { closeBrowser } from './scanner/browser.js';
import { ensureSeedAdmin, ensureOwnershipBackfill, getSessionUser } from './services/auth.js';
import { requestStop } from './services/queue-state.js';
import { isSetupComplete, isSetupHealthy, invalidateSetupCache, getEnvDbConfig } from './services/setup.js';
import { createLogger } from './utils/logger.js';
import { logActivity } from './services/scans.js';

const logger = createLogger();
logConfigSummary(logger);

const frontendDist = path.resolve(process.cwd(), '../frontend/dist');

const app = Fastify({
  loggerInstance: logger as never as import('fastify').FastifyBaseLogger,
  trustProxy: ['127.0.0.1/8', '::1/128'],
});

async function main(): Promise<void> {
  const allowedOrigins = new Set<string>([
    '',
    config.publicAppUrl,
    'http://localhost:3000',
    'http://localhost:5173',
  ]);

  // LAN access (phone/laptop on same wifi via 192.168.x.x etc.) sends a
  // different Origin than localhost — accept private-network origins so
  // POST/PUT/DELETE preflights don't die with a browser NetworkError.
  function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin || allowedOrigins.has(origin)) return true;
    let host = '';
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    return false;
  }

  await app.register(cors, {
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin ?? '')) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
    credentials: true,
  });

  await app.register(websocket);

  const serveStatic = fs.existsSync(frontendDist);
  if (serveStatic) {
    await app.register(fastifyStatic, {
      root: frontendDist,
      prefix: '/',
      index: ['index.html'],
      decorateReply: true,
    });
  } else {
    logger.warn(`frontend/dist not found at ${frontendDist} — static serving disabled`);
  }

  const PUBLIC_API = new Set<string>([
    '/api/health',
    '/api/version',
    '/api/updates/status',
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/seed-admin',
    '/api/setup/status',
    '/api/setup/validate-db',
    '/api/setup',
    '/api/setup/restart',
  ]);

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const url = (req.url.split('?')[0] ?? '').slice(0);
    const isPublic = PUBLIC_API.has(url);
    const isApi = url.startsWith('/api/');
    if (!isApi) return;
    if (isPublic) return;
    if (!(await isSetupHealthy())) {
      return reply.code(503).send({ ok: false, error: 'Server not configured. Run setup first.' });
    }
    try {
      const u = await getSessionUser(req);
      if (!u) {
        await reply.code(401).send({ ok: false, error: 'Not logged in. Please log in.' });
        return;
      }
      (req as unknown as { authUser: typeof u }).authUser = u;
    } catch (err) {
      req.log.error(err);
      await reply.code(503).send({ ok: false, error: 'Database unavailable. Check MySQL + .env.' });
    }
  });

  await app.register(setupRoutes);
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(websiteRoutes);
  await app.register(scanRoutes);
  await app.register(outreachRoutes);
  await app.register(updateRoutes);

  app.setNotFoundHandler(async (req, reply) => {
    const url = (req.url.split('?')[0] ?? '').slice(0);
    if (url.startsWith('/api/')) {
      return reply.code(404).send({ ok: false, error: 'Not found' });
    }
    if (serveStatic) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ ok: false, error: 'Not found' });
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    app.log.error(err);
    const status = err.statusCode ?? 500;
    return reply.code(status).send({ ok: false, error: err.message ?? 'Internal error' });
  });

  try {
    let healthy = await isSetupHealthy();
    if (!healthy && getEnvDbConfig()) {
      // Env-based deploy: no wizard, no flag file. When
      // DB credentials come from the environment, self-configure on boot:
      // create schema + seed admin from ADMIN_* env, then re-check.
      try {
        await ensureSchema();
        await ensureSeedAdmin();
        await ensureOwnershipBackfill();
        invalidateSetupCache();
        healthy = await isSetupHealthy();
        if (healthy) {
          void logActivity(null, 'system', 'boot', { adminEmail: config.auth.adminEmail });
          logger.info(`Self-configured from environment. Seed admin ready: ${config.auth.adminEmail}`);
        }
      } catch (err) {
        logger.warn(`Env self-configure failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (healthy) {
      await ensureSchema();
      await ensureSeedAdmin();
      await ensureOwnershipBackfill();
      void logActivity(null, 'system', 'boot', { adminEmail: config.auth.adminEmail });
      logger.info(`Seed admin ready: ${config.auth.adminEmail}`);
    } else {
      logger.warn('Server is in SETUP mode — DB not configured. Complete setup via the frontend wizard.');
    }
  } catch (err) {
    logger.warn(`Startup DB check skipped: ${err instanceof Error ? err.message : err}`);
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info(`Backend listening on http://0.0.0.0:${config.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal} — draining scan queue…`);
    requestStop();
    await app.close().catch(() => undefined);
    await closeBrowser();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
