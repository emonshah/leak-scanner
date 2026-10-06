/*
 * ensure-frontend-deps.js — frontend predev/prebuild guard.
 *
 * Known Windows failure (npm/cli#4828): a nested frontend/node_modules with
 * a rollup copy missing the platform binary (@rollup/rollup-win32-x64-msvc).
 * Vite then dies with "Cannot find module @rollup/rollup-win32-x64-msvc".
 * That broken copy shadows the healthy workspace install at the project root.
 *
 * Fix: if loading rollup from the frontend folder fails, delete the nested
 * frontend/node_modules and reinstall once from the workspace root, then
 * verify. Prints English instructions on every outcome so members know
 * exactly what happened.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FE = path.join(ROOT, 'frontend');
const NESTED_NM = path.join(FE, 'node_modules');

function rollupOk() {
  const r = spawnSync(process.execPath, ['-e', "require('rollup')"], { cwd: FE, stdio: 'ignore' });
  return r.status === 0;
}

function npmInstall() {
  const r = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  return !r.error && r.status === 0;
}

function fail(msg) {
  process.stderr.write(`[setup] ${msg}\n`);
  process.exit(1);
}

if (rollupOk()) process.exit(0);

if (fs.existsSync(NESTED_NM)) {
  process.stdout.write('[setup] Broken nested frontend/node_modules detected (rollup platform binary missing).\n');
  process.stdout.write('[setup] Removing it and reinstalling from the project root (one time)...\n\n');
  fs.rmSync(NESTED_NM, { recursive: true, force: true });
} else {
  process.stdout.write('[setup] Rollup not installed yet — installing from the project root...\n\n');
}

if (!npmInstall()) {
  fail('npm install failed. Run "npm install" manually in the project root and fix the errors shown.');
}
if (!rollupOk()) {
  fail(
    'Rollup still not loading after reinstall. Manual fix: delete the frontend\\node_modules folder, ' +
      'run "npm install" in the project root, then retry.',
  );
}
process.stdout.write('[setup] Frontend dependencies fixed.\n');
