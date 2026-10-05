/*
 * Leak Scanner - one-click Windows starter (prod, single port).
 * Double-click Start-LeakScanner.bat, or:  npm run start:win
 *
 * What it does:
 *   1. Checks Node 20+, npm, MySQL on :3306 (XAMPP), :3000 free.
 *   2. First run only: npm ci, backend+frontend build, Playwright Chrome.
 *   3. Starts backend (which also serves frontend/dist) on :3000
 *      and opens http://localhost:3000 in the browser.
 *      First ever run lands on the Setup Wizard page (DB + admin).
 *
 * Flags:  node scripts/start-win.js --check-only   (checks only, no changes)
 *
 * Stdlib only - runs before any npm install.
 */
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT, 'backend');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const BACKEND_ENTRY = path.join(BACKEND_DIR, 'dist', 'index.js');
const FRONTEND_INDEX = path.join(FRONTEND_DIR, 'dist', 'index.html');
const APP_URL = 'http://localhost:3000';
const CHECK_ONLY = process.argv.includes('--check-only');

function log(msg) {
  process.stdout.write(`${msg}\n`);
}
function fail(hint, details) {
  log('');
  log(`[ERROR] ${hint}`);
  if (details) log(`        ${details}`);
  process.exit(1);
}
function run(cmd, args, cwd, label) {
  log(`[RUN] ${label || [cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: cwd || ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error) fail(`${label || cmd} could not start.`, String(r.error.message || r.error));
  if (r.status !== 0) fail(`${label || cmd} failed (exit ${r.status}).`, 'Read the lines above, fix it, then double-click Start again.');
}
function portOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs || 3000);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, host);
  });
}

async function isBackendHealthy(host, port) {
  return new Promise((resolve) => {
    const http = require('node:http');
    const req = http.get(`http://${host}:${port}/api/health`, (res) => {
      resolve(res.statusCode === 200);
      req.destroy();
    });
    req.setTimeout(3000, () => {
      resolve(false);
      req.destroy();
    });
    req.on('error', () => resolve(false));
  });
}
function browsersPresent() {
  // 1. Playwright bundled browsers (default cache locations).
  const cacheDirs = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH)) {
    cacheDirs.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    cacheDirs.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  } else {
    cacheDirs.push(path.join(os.homedir(), '.cache', 'ms-playwright'));
  }
  for (const dir of cacheDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    if (entries.some((e) => /^chromium-/.test(e) || /^chrome-/.test(e))) return true;
  }
  // 2. Real Chrome/Chromium on PATH (scanner prefers channel:'chrome').
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const names = process.platform === 'win32' ? ['chrome.exe'] : ['google-chrome', 'chromium', 'chromium-browser'];
  for (const n of names) {
    const r = spawnSync(probe, [n], { stdio: 'ignore', shell: process.platform === 'win32' });
    if (r.status === 0) return true;
  }
  return false;
}
function openBrowser(url) {
  const plat = process.platform;
  const cmd = plat === 'win32' ? 'cmd' : plat === 'darwin' ? 'open' : 'xdg-open';
  const args = plat === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(cmd, args, { stdio: 'ignore', shell: false, detached: true });
  child.unref();
}

async function main() {
  log('===== Leak Scanner - starting (prod, http://localhost:3000) =====');

  // 1. Node 20+
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 20) {
    fail(`Node.js 20+ required (found ${process.versions.node}).`, 'Install LTS from https://nodejs.org then run again.');
  }
  log(`[OK] Node ${process.versions.node}`);

  // 2. npm present
  const npmProbe = spawnSync('npm', ['--version'], { stdio: 'pipe', shell: process.platform === 'win32' });
  if (npmProbe.status !== 0) fail('npm not found.', 'Reinstall Node.js LTS (includes npm) from https://nodejs.org');
  log('[OK] npm found');

  // 3. MySQL :3306 (XAMPP)
  const mysqlUp = await portOpen('127.0.0.1', 3306, 3000);
  if (!mysqlUp) {
    fail('MySQL is not running on port 3306.', 'Open XAMPP Control Panel and press Start on MySQL, then run again.');
  }
  log('[OK] MySQL on :3306');

  // 4. Check if backend is healthy on :3000
  const backendHealthy = await isBackendHealthy('127.0.0.1', 3000);
  if (backendHealthy) {
    log('[OK] Backend already running on :3000 - opening browser.');
    openBrowser(APP_URL);
    return;
  }
  log('[OK] Backend not running on :3000 - will start it.');

  if (CHECK_ONLY) {
    log('[CHECK-ONLY] All checks passed. Nothing was installed or started.');
    return;
  }

  // 5. Dependencies (first run)
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    log('[INFO] First run: installing dependencies (5-10 min, one time only)...');
    run('npm', ['ci'], ROOT, 'npm ci');
  } else {
    log('[OK] Dependencies installed');
  }

  // 6. Backend build
  if (!fs.existsSync(BACKEND_ENTRY)) {
    log('[INFO] Building backend...');
    run('npm', ['run', 'build:backend'], ROOT, 'npm run build:backend');
  } else {
    log('[OK] Backend built');
  }

  // 7. Frontend build (backend serves frontend/dist on :3000)
  if (!fs.existsSync(FRONTEND_INDEX)) {
    log('[INFO] Building frontend...');
    run('npm', ['run', 'build:frontend'], ROOT, 'npm run build:frontend');
  } else {
    log('[OK] Frontend built');
  }

  // 8. Browser for scans (first run)
  if (!browsersPresent()) {
    log('[INFO] First run: downloading browser for scans (~170MB, one time only)...');
    run('npx', ['playwright', 'install', 'chrome'], BACKEND_DIR, 'npx playwright install chrome');
  } else {
    log('[OK] Scan browser present');
  }

  // 9. Start backend (serves API + frontend on :3000)
  log('[RUN] Starting server on http://localhost:3000 (this window must stay open, Ctrl+C to stop)...');
  openBrowser(APP_URL);
  const child = spawn(process.execPath, [BACKEND_ENTRY], {
    cwd: BACKEND_DIR,
    stdio: 'inherit',
    windowsHide: false,
  });
  child.on('exit', (code) => {
    log(`Server stopped (exit ${code ?? 'null'}).`);
    process.exit(code ?? 0);
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

main().catch((err) => fail('Unexpected failure.', err && err.message ? err.message : String(err)));
