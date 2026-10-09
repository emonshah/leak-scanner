# Leak Scanner

Full-stack conversion-leak scanner. Scans a website, finds money leaks
(missing phone/call CTA, dead contact forms, slow pages, …) and scores the
opportunity. Runs fully local: Fastify backend + React frontend + MySQL.

## Requirements (once)

| Needed | Version | Notes |
|--------|---------|-------|
| Node.js | 20+ | LTS from https://nodejs.org |
| XAMPP | any recent | Control Panel → **MySQL → Start** (port 3306) |
| Git | any | or download the ZIP from GitHub |

## Get the project

```cmd
git clone https://github.com/emonshah/leak-scanner.git
cd leak-scanner
```

ZIP download: extract, open a terminal inside the folder.

## Run (every time)

```cmd
npm run start:win
```

Or double-click **`Start-LeakScanner.bat`** in the project root.

First run (5–15 min, one time): installs dependencies, builds backend +
frontend, downloads the scan browser (~170 MB). Later runs start in ~30 s.
The app opens at **http://localhost:3000**. Keep the terminal window open
(Ctrl+C stops the server).

## First run — Setup Wizard

The browser lands on `/setup`. Fill in:

1. **Database** — host `localhost`, port `3306`, your MySQL database name,
   user and password. The schema is created automatically.
2. **Admin account** — email, name, password (8+ chars), then press
   **Generate** for the auth secret.
3. **Run Setup** → **Restart Server** → you are sent to the login page.

Sign in with the admin email + password you just created. The wizard writes
`backend/.env` on this machine only — never commit or share it.

## Development mode (optional, hot reload)

```cmd
npm run dev
```

Backend on `:3000`, Vite dev server on `:5173` (proxies `/api`).
Dependencies install automatically on a fresh clone.

## Troubleshooting

- **Preflight checks**: `node scripts/start-win.js --check-only`
  verifies Node, npm, MySQL (`:3306`) and port `:3000` and prints an
  English fix hint for whatever fails.
- **“Cannot reach the backend”** in the UI: the backend is down. Open
  http://localhost:3000/api/health — it must return JSON — and restart the
  server in the terminal.
- **Port 3000 busy**: close the other program
  (`netstat -ano | findstr :3000` → kill that PID in Task Manager).
- **MySQL not running**: start it in the XAMPP Control Panel.
- **Broken/half-finished install**: delete `node_modules` and run
  `npm install`, or just run `npm run start:win` again (it re-installs).

## Update (team members)

```cmd
git pull
npm run build
```

Then restart with `npm run start:win`.
