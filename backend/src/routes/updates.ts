import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { appVersion } from './health.js';
import { requireAdmin } from '../services/auth.js';
import { scanQueue } from '../services/queue.js';
import { logActivity } from '../services/scans.js';

const REPO = process.env['GITHUB_REPO'] ?? '';
const UPDATER_ON = process.env['ENABLE_UPDATER'] === '1';
const REPO_DIR = process.env['UPDATE_REPO_DIR'] ?? process.cwd();

interface ReleaseCache {
  at: number;
  tag: string;
  notes: string;
}
let releaseCache: ReleaseCache | null = null;

function newerThan(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** Newest semver-looking tag from a tag-name list (skips garbage like "junk"). */
export function pickNewestTag(names: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const n of names) {
    if (typeof n !== 'string' || !/^v?\d+(\.\d+)*$/.test(n)) continue;
    if (!best || newerThan(n, best)) best = n;
  }
  return best;
}

async function latestTag(): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=30`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'leak-scanner-updater', Accept: 'application/vnd.github+json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { name?: string }[];
    if (!Array.isArray(data)) return null;
    return pickNewestTag(data.map((t) => t?.name));
  } catch {
    return null;
  }
}

export async function latestRelease(fresh = false): Promise<{ tag: string; notes: string } | null> {
  if (!REPO) return null;
  if (!fresh && releaseCache && Date.now() - releaseCache.at < 24 * 3600 * 1000) {
    return { tag: releaseCache.tag, notes: releaseCache.notes };
  }
  // 1. Real GitHub Release (carries notes). 404 = nobody published one yet.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'leak-scanner-updater', Accept: 'application/vnd.github+json' },
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string; body?: string };
      if (data.tag_name) {
        releaseCache = { at: Date.now(), tag: data.tag_name, notes: (data.body ?? '').slice(0, 2000) };
        return { tag: data.tag_name, notes: releaseCache.notes };
      }
    }
  } catch {
    /* fall through to the tag fallback below */
  }
  // 2. Fallback: newest git tag — pushed tags alone drive updates, no
  //    manual Release needed (notes stay empty in that case).
  const tag = await latestTag();
  if (tag) {
    releaseCache = { at: Date.now(), tag, notes: '' };
    return { tag, notes: '' };
  }
  return releaseCache ? { tag: releaseCache.tag, notes: releaseCache.notes } : null;
}

// ─── One-click update job (in-process single flight) ─────────────────────
// Runs exactly two allowlisted commands, no shell, no user arguments:
//   git -C <repo> pull --ff-only
//   npm run build   (cwd = repo: builds backend + frontend workspaces)
// Progress lives in memory + ./logs/update-<ts>.log. DB is never touched
// (migrations are idempotent CREATE TABLE IF NOT EXISTS).

type JobState = 'idle' | 'running' | 'done' | 'failed';

interface UpdateJob {
  id: string;
  state: JobState;
  startedAt: string;
  finishedAt: string | null;
  lines: string[];
  exitCode: number | null;
}

let job: UpdateJob = { id: '', state: 'idle', startedAt: '', finishedAt: null, lines: [], exitCode: null };

function pushLine(text: string): void {
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${text}`.slice(0, 500);
  job.lines.push(stamped);
  if (job.lines.length > 300) job.lines = job.lines.slice(-300);
  if (job.id) {
    fs.appendFile(path.resolve(process.cwd(), 'logs', `update-${job.id}.log`), `${stamped}\n`).catch(() => undefined);
  }
}

function runCmd(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout: 20 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 }, (err) => {
      resolve(typeof err?.code === 'number' ? err.code : err ? 1 : 0);
    });
    child.stdout?.on('data', (d: unknown) => {
      for (const ln of String(d).split('\n')) {
        const t = ln.trim();
        if (t) pushLine(t.slice(0, 200));
      }
    });
    child.stderr?.on('data', (d: unknown) => {
      for (const ln of String(d).split('\n')) {
        const t = ln.trim();
        if (t) pushLine(t.slice(0, 200));
      }
    });
    child.on('error', (e) => {
      pushLine(`spawn failed: ${(e as Error).message.slice(0, 200)}`);
      resolve(127);
    });
  });
}

async function runUpdateJob(userId: number): Promise<void> {
  job = {
    id: new Date().toISOString().replace(/[:.]/g, '-'),
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lines: [],
    exitCode: null,
  };
  pushLine(`Update started by user ${userId}. Backend will restart near the end — keep this dialog open.`);
  try {
    pushLine('$ git pull --ff-only');
    const pullCode = await runCmd('git', ['-C', REPO_DIR, 'pull', '--ff-only'], REPO_DIR);
    if (pullCode !== 0) {
      pushLine(`git pull failed (exit ${pullCode}). Fix locally (git status) if you edited files.`);
      job.state = 'failed';
      job.exitCode = pullCode;
      return;
    }
    pushLine('Code updated. Rebuilding (npm run build — takes minutes on code changes)...');
    pushLine('$ npm run build');
    const upCode = await runCmd('npm', ['run', 'build'], REPO_DIR);
    pushLine(upCode === 0 ? 'Rebuild done. Restart the backend to serve the new version — this dialog will detect it.' : `Rebuild failed (exit ${upCode}). Old build keeps running.`);
    job.state = upCode === 0 ? 'done' : 'failed';
    job.exitCode = upCode;
  } catch (err) {
    pushLine(`Update crashed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    job.state = 'failed';
    job.exitCode = 1;
  } finally {
    job.finishedAt = new Date().toISOString();
    void logActivity(userId, 'system', 'self-update', { jobId: job.id, state: job.state });
  }
}

async function adminOnly(req: FastifyRequest, reply: FastifyReply): Promise<number | null> {
  await requireAdmin(req, reply);
  if (reply.sent) return null;
  const u = (req as unknown as { authUser?: { id: number } }).authUser;
  return u?.id ?? null;
}

export async function updateRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { refresh?: string } }>('/api/updates/status', async (req) => {
    const current = appVersion();
    const rel = await latestRelease(req.query.refresh === '1');
    const latest = rel?.tag ?? null;
    return {
      ok: true,
      current,
      latest,
      notes: rel?.notes ?? '',
      needsUpdate: !!(latest && newerThan(latest, current)),
      updaterEnabled: UPDATER_ON,
      repo: REPO || null,
    };
  });

  app.post('/api/admin/update/start', async (req, reply) => {
    const me = await adminOnly(req, reply);
    if (me == null) return;
    if (!UPDATER_ON) {
      return reply.code(400).send({ ok: false, error: 'One-click update is disabled on this machine (ENABLE_UPDATER=0). Run git pull then npm run build.' });
    }
    if (job.state === 'running') {
      return reply.code(409).send({ ok: false, error: 'An update is already running.' });
    }
    const scansActive = scanQueue.runningCount + scanQueue.queuedCount;
    job.state = 'running'; // reserve synchronously (single flight)
    void runUpdateJob(me).catch(() => undefined);
    // runUpdateJob re-inits job immediately; fetch fresh id
    return { ok: true, jobId: job.id, scansActive, warning: scansActive > 0 ? `${scansActive} scan(s) running — the backend restart may interrupt them.` : null };
  });

  app.get('/api/admin/update/log', async (req, reply) => {
    const me = await adminOnly(req, reply);
    if (me == null) return;
    return { ok: true, jobId: job.id, state: job.state, startedAt: job.startedAt, finishedAt: job.finishedAt, exitCode: job.exitCode, lines: job.lines.slice(-120) };
  });
}
