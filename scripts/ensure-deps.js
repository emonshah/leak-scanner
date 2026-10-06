/*
 * Self-bootstrap for `npm run dev` on a fresh clone (Windows members hit
 * "'concurrently' is not recognized" when root node_modules is missing).
 * Stdlib only — runs before any npm install. Invoked automatically by the
 * npm `predev` hook.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const marker = path.join(ROOT, 'node_modules', '.package-lock.json');

if (fs.existsSync(marker)) {
  process.exit(0);
}

process.stdout.write('[setup] Dependencies not installed yet — running npm install (first time only, 5-10 min)...\n');
const r = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.error || r.status !== 0) {
  process.stderr.write('[setup] npm install failed. Run "npm install" manually and fix any errors, then retry.\n');
  process.exit(1);
}
process.stdout.write('[setup] Dependencies installed.\n');
