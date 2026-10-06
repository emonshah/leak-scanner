# AGENTS.md — instructions for ANY AI coding agent working in this repo

This file is the standing workflow. Read it before touching code, regardless
of which LLM you are (Muse, GPT, Gemini, Qwen). The owner says "koro/update
koro" meaning: implement + verify + push + tag, per the flow below.

## 1. Project map

- `backend/src/scanner/` — detection engine (money-leak catalog in
  `money-leaks.ts` M1–M14; verdicts in `visibility.ts`; scoring in
  `intelligence.ts`). Pure + deterministic, no network except probes.
- `backend/src/services/pipeline.ts` — scan orchestration (crawl → content
  → browser → findings → score). Order matters: suppress → gate → enrich.
- `backend/src/services/scans.ts` — DB layer (websites, scans, findings,
  lead_status). `scoreCapped()` in `intelligence.ts` is the ONE scoring math
  (pipeline and manual-delete both use it — never duplicate it).
- `backend/src/routes/` — API (`websites.ts`, `scans.ts`, `outreach.ts`,
  `health.ts`, `setup.ts`). Auth: session cookie → `authUser(req)`;
  admin-only routes use `preHandler: [requireAdmin]`.
- `frontend/src/` — React + Vite + Tailwind-ish custom classes (`panel`,
  `btn-primary`, `btn-ghost`, `field`). API via `@/api/client` (same-origin,
  cookies included). Version banner: `components/UpdateBanner.tsx`.
- Run mode is XAMPP/npm only (no Docker): backend `npm run build + start`
  (`:3000`), frontend `npm run build`, MySQL via XAMPP/localhost (`:3306`).
  First run goes through the Setup Wizard page (`/setup`) which takes
  DB name/user/pass + admin account and writes `.env` + schema itself.
- `VERSION` + `*/package.json` — release version, always in sync (x.y.z).

## 2. The update flow (EVERY change ships this way)

1. **Implement** the feature/fix (minimal diff, existing patterns only).
2. **Verify before commit** (all must pass):
   - `backend`: `tsc --noEmit -p tsconfig.json` + `npm run verify:leaks` +
     `npm run verify:ws` (websocket stream handler shapes).
   - `frontend`: `tsc --noEmit -p tsconfig.json` + `npm run build`
   - New behavior gets a targeted check (tsx script or harness case).
   - Never break: fail-closed catalog (`leakFor`), no false-positive
     regressions (tracking numbers, hit-test ancestors, fragments, dupes).
3. **Version bump**: fix → patch (1.1.x), feature → minor (1.2.x).
   Update root `VERSION` AND `package.json` + `backend/package.json` +
   `frontend/package.json` (all four, same number).
4. **Commit** as `Emon Shah <md.shah3738@gmail.com>`, message starts with
   the version (`v1.2.0: short description`).
5. **Push** `main` + tag (`git tag vX.Y.Z && git push origin vX.Y.Z`).
   Deploy key: `~/.ssh/leak_deploy`
   (`GIT_SSH_COMMAND="ssh -i /home/emon/.ssh/leak_deploy -o IdentitiesOnly=yes"`).
6. **Report**: what changed, tag number, members run `git pull` then
   `npm run build` (backend + frontend) and restart. Scores may shift when detection changes —
   say so explicitly with before/after on a known site.

## 3. Hard rules (never break)

- **Never commit secrets**: `.env`, passwords, tokens, SMTP creds.
  `.gitignore` covers them — verify with `git status` before every commit.
- **Never touch user data**: no migrations that drop/alter member data;
  boot DDL stays idempotent (`IF NOT EXISTS`); volumes are sacred.
- **No claims without evidence**: every finding needs corroborated
  measurement; uncertain = MEDIUM verify-note (silent) or soft-claim HIGH
  with `soft_claim` + confidence, never absolutes in user-facing text.
- **Error messages in English only**: every user-facing string (frontend
  alerts, confirm dialogs, backend error payloads, start-script logs) is
  English — no Bengali/transliterated text.
- **Never bypass bot protection**: no CAPTCHA/challenge solvers, no
 FlareSolverr-type tools. Fingerprint hardening (UA/locale/webdriver) is
  fine; solving challenges is forbidden.
- **No direct edits on GitHub web UI** (causes push conflicts). All changes
  flow through code here.
- **Deploy key**: never print the private key, never commit it, never
  delete `opencode-push` from GitHub (pushes stop without it).
- **Windows members**: XAMPP + Node 20 required (`npx playwright install
  chrome` once). One-click run: double-click `Start-LeakScanner.bat`
  (or `npm run start:win`) — prod single-port `:3000`, first run opens the
  Setup Wizard. Never fight the owner's local dev ports (3000/3306/5173).

## 4. Release checklist (before every tag)

- [ ] tsc clean (backend + frontend), frontend build passes
- [ ] `verify:leaks` green (T1–T18)
- [ ] `verify:ws` green (stream handler T1–T4)
- [ ] VERSION + 3× package.json in sync
- [ ] `git status` shows no secrets (`.env`, keys, tokens)
- [ ] Score impact noted (which sites move, which direction, why)
- [ ] Tag pushed; `git ls-remote --tags` confirms
