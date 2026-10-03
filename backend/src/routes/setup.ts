import type { FastifyInstance } from 'fastify';
import {
  type SetupPayload,
  isSetupComplete,
  validateDbConnection,
  runFullSetup,
  requestRestart,
  checkSetupHealth,
  invalidateSetupCache,
} from '../services/setup.js';

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/setup/status', async () => {
    const health = await checkSetupHealth();
    return { ok: true, configured: health.configured, reason: health.reason ?? null };
  });

  app.post<{ Body: SetupPayload }>('/api/setup/validate-db', async (req, reply) => {
    const body = req.body ?? {};
    const payload: SetupPayload = {
      dbHost: body.dbHost ?? '',
      dbPort: typeof body.dbPort === 'number' ? body.dbPort : 3306,
      dbName: body.dbName ?? '',
      dbUser: body.dbUser ?? '',
      dbPassword: body.dbPassword ?? '',
      adminEmail: 'validate@local.test',
      adminName: 'Validate',
      adminPassword: 'validate-password',
      authSecret: 'validate-secret',
    };

    if (!payload.dbHost || !payload.dbName || !payload.dbUser) {
      return reply.code(400).send({ ok: false, error: 'dbHost, dbName, and dbUser are required.' });
    }

    const result = await validateDbConnection(payload);
    if (!result.ok) {
      return reply.code(400).send({ ok: false, error: `Connection failed: ${result.error}` });
    }
    return { ok: true };
  });

  app.post<{ Body: SetupPayload }>('/api/setup', async (req, reply) => {
    // Re-running setup is allowed and idempotent: CREATE DATABASE / CREATE TABLE
    // are all IF NOT EXISTS, and the admin seed is a SELECT-then-UPDATE/INSERT
    // keyed on email. Blocking re-runs with 409 only stranded the wizard on
    // step 2 with "Setup already completed" and no way forward. The
    // .setup-complete flag still gates *routing into* the wizard (see index.ts
    // onRequest hook + /api/setup/status), not re-execution.
    const isRerun = isSetupComplete();

    const body = req.body ?? {};
    const payload: SetupPayload = {
      dbHost: body.dbHost ?? '',
      dbPort: typeof body.dbPort === 'number' ? body.dbPort : 3306,
      dbName: body.dbName ?? '',
      dbUser: body.dbUser ?? '',
      dbPassword: body.dbPassword ?? '',
      adminEmail: (body.adminEmail ?? '').trim().toLowerCase(),
      adminName: body.adminName ?? '',
      adminPassword: body.adminPassword ?? '',
      authSecret: body.authSecret ?? '',
      appUrl: body.appUrl,
    };

    if (!payload.dbHost || !payload.dbName || !payload.dbUser) {
      return reply.code(400).send({ ok: false, error: 'dbHost, dbName, and dbUser are required.' });
    }
    if (!payload.adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.adminEmail)) {
      return reply.code(400).send({ ok: false, error: 'A valid admin email is required.' });
    }
    if (!payload.adminName) {
      return reply.code(400).send({ ok: false, error: 'Admin name is required.' });
    }
    if (!payload.adminPassword || payload.adminPassword.length < 8) {
      return reply.code(400).send({ ok: false, error: 'Admin password must be at least 8 characters.' });
    }
    if (!payload.authSecret || payload.authSecret.length < 16) {
      return reply.code(400).send({ ok: false, error: 'AUTH_SECRET must be at least 16 characters.' });
    }

    const progress: string[] = [];
    const result = await runFullSetup(payload, (p) => {
      progress.push(`${p.step}: ${p.ok ? 'OK' : `FAILED${p.error ? ' - ' + p.error : ''}`}`);
    });

    if (!result.ok) {
      // Every failure here originates from the submitted configuration (bad
      // credentials, missing privilege, unwritable path) — that is a client
      // error, not a server fault. 500 was masking it as "the app is broken".
      return reply.code(400).send({ ok: false, error: result.error, progress });
    }

    requestRestart('Setup complete. Server must restart to load new configuration.');

    invalidateSetupCache();

    reply.header('X-Setup-Complete', 'true');
    return { ok: true, configured: true, reconfigured: isRerun, progress, needsRestart: true };
  });

  app.post('/api/setup/restart', (_req, reply) => {
    reply.send({ ok: true, message: 'Restarting server…' });
    setImmediate(() => {
      process.exit(0);
    });
  });
}
