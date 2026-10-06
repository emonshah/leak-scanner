#!/usr/bin/env bash
#
# One-shot bootstrap for leak-scanner behind a Cloudflare Tunnel
# on a single Linux (Debian/Ubuntu) server. Run AS ROOT (sudo) on the target host.
#
# What this script does:
#   1. Creates the service user + app dir + clones the repo.
#   2. Installs deps, Playwright's browser, builds backend + frontend
#      (single-port mode: backend serves the built UI on :3000).
#   3. Writes a production .env from env vars (no hardcoding secrets).
#   4. Creates the MySQL DB + user, installs and starts the app systemd service.
#   5. Installs cloudflared, creates the tunnel, routes the domain,
#      installs and starts the cloudflared systemd service.
#
# The ONLY interactive step is the Cloudflare login (cloudflared opens a browser
# or prints a URL you must approve). Everything else is automated.
# Re-running is safe: an existing .env and an existing tunnel are kept.
#
# Usage (set your real values):
#   DOMAIN=app.emonshah.com \
#   ADMIN_EMAIL=admin@emonshah.com \
#   DB_PASS=<strong-mysql-pass> AUTH_SECRET=<64-hex> ADMIN_PASSWORD=<strong> \
#   sudo bash deploy/deploy.sh
#
# Generate AUTH_SECRET:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#
set -euo pipefail

DOMAIN="${DOMAIN:-app.emonshah.com}"
APP_DIR="${APP_DIR:-/opt/leak-scanner}"
REPO_URL="${REPO_URL:-https://github.com/emonshah/leak-scanner.git}"
TUNNEL_NAME="${TUNNEL_NAME:-leak-scanner-prod}"
SERVICE_USER="${SERVICE_USER:-leak_scanner}"
CF_REPO_URL="https://pkg.cloudflare.com/packages/cloudflared-apt-source"
RUN_USER="$(id -un)"

# --- preflight: required secrets + binaries ---
: "${DB_PASS:?set DB_PASS}"
: "${AUTH_SECRET:?set AUTH_SECRET (64 hex chars)}"
: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD (>=12 chars)}"
command -v node >/dev/null || { echo "Node 20+ is required."; exit 1; }
command -v mysql >/dev/null || { echo "MySQL client is required (mysql-server)."; exit 1; }

echo "==> [1/5] app dir + service user"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd -r -m -d "/home/$SERVICE_USER" -s /usr/sbin/nologin "$SERVICE_USER"
fi
if [ ! -d "$APP_DIR" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

echo "==> [2/5] build (npm ci -> browser -> backend + frontend)"
command -v npm >/dev/null || curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
command -v npm >/dev/null || apt-get update >/dev/null && apt-get install -y nodejs
cd "$APP_DIR"
sudo -u "$SERVICE_USER" npm ci
# Playwright's Chromium (the scanner falls back to it when Chrome is absent)
# + the OS libs it needs. Binaries go to the service user's home, libs to apt.
sudo -u "$SERVICE_USER" npx playwright install chromium
npx playwright install-deps chromium
# prebuild hook (ensure-deps) + tsc + vite -> backend/dist + frontend/dist
sudo -u "$SERVICE_USER" npm run build

echo "==> [3/5] production .env + runtime dirs"
ENV_FILE="$APP_DIR/backend/.env"
if [ -f "$ENV_FILE" ]; then
  echo "    $ENV_FILE already exists — keeping it (delete it to regenerate)"
else
  cat > "$ENV_FILE" <<EOF
# Database
DB_HOST=localhost
DB_PORT=3306
DB_NAME=leak_scanner
DB_USER=${SERVICE_USER}
DB_PASS=${DB_PASS}

# Auth
AUTH_SECRET=${AUTH_SECRET}
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_NAME=Admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}

# Server
PUBLIC_APP_URL=https://${DOMAIN}
COOKIE_SECURE=1
PORT=3000
NODE_ENV=production

# Scan settings
SCAN_CONCURRENCY=3
SCAN_TIMEOUT_MS=300000
SCAN_MAX_PAGES=12
HEADFUL=0
SCAN_ALLOW_PRIVATE=0

# Qwen API (optional)
QWEN_BASE_URL=https://qwen.emonshah.com
QWEN_MODEL=qwen2.5:3b
QWEN_TIMEOUT_MS=60000

# Updates: one-click stays OFF on the server. Update with:
#   git pull && npm run build && systemctl restart leak-scanner
ENABLE_UPDATER=0
GITHUB_REPO=emonshah/leak-scanner
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
# Runtime data dirs the hardened service may write (see deploy/leak-scanner.service).
mkdir -p "$APP_DIR/backend/screenshots" "$APP_DIR/backend/screenshots-research" "$APP_DIR/backend/logs"
chown -R "$SERVICE_USER:$SERVICE_USER" \
  "$APP_DIR/backend/screenshots" "$APP_DIR/backend/screenshots-research" "$APP_DIR/backend/logs"

echo "==> [4/5] app service"
# Create the MySQL DB + user (idempotent) if not present. Local-only account:
# the tunnel never exposes :3306.
mysql -uroot -e "CREATE DATABASE IF NOT EXISTS \`leak_scanner\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -uroot <<EOF
CREATE USER IF NOT EXISTS '${SERVICE_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`leak_scanner\`.* TO '${SERVICE_USER}'@'localhost';
FLUSH PRIVILEGES;
EOF
cp "$APP_DIR/deploy/leak-scanner.service" /etc/systemd/system/leak-scanner.service
systemctl daemon-reload
systemctl enable --now leak-scanner
systemctl restart leak-scanner

echo "==> [5/5] cloudflared tunnel + ${DOMAIN}"
# Install cloudflared (skip if already installed).
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -L "$CF_REPO_URL" | gpg --dearmor > /usr/share/keyrings/cloudflared-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflared-archive-keyring.gpg] https://pkg.cloudflare.com/cloudflared-debian/ $(. /etc/os-release && echo "$ID") main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update >/dev/null
  apt-get install -y cloudflared jq
fi

if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  # Quickstart (dashboard) flow: the token encodes the tunnel + route.
  # `cloudflared service install` writes /etc/cloudflared/config.yml, installs a
  # systemd unit, and starts the tunnel — no separate create/route-dns step.
  echo "    using Cloudflare Tunnel connector token (dashboard quickstart flow)"
  cloudflared service install "$CLOUDFLARE_TUNNEL_TOKEN"
  systemctl daemon-reload
  systemctl restart cloudflared
else
  # Named-tunnel flow: create tunnel + route DNS (first run opens a browser).
  if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
    echo "    cloudflared login — approve the URL printed below in your browser."
    cloudflared tunnel login
  fi
  if ! cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
    cloudflared tunnel create "$TUNNEL_NAME"
  fi
  TUNNEL_ID="$(cloudflared tunnel list --output json | jq -r '.[] | select(.name=="'"$TUNNEL_NAME"'") | .id')"
  [ -n "$TUNNEL_ID" ] || { echo "ERROR: tunnel $TUNNEL_NAME not found."; exit 1; }
  mkdir -p /etc/cloudflared
  cp "$HOME/.cloudflared/${TUNNEL_ID}.json" /etc/cloudflared/credentials.json
  cat > /etc/cloudflared/config.yml <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: /etc/cloudflared/credentials.json
ingress:
  - hostname: ${DOMAIN}
    service: http://localhost:3000
  - service: http_status:404
EOF
  if ! cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN"; then
    echo "    route dns failed — ${DOMAIN} probably already has a DNS record."
    echo "    Delete the old ${DOMAIN} record in the Cloudflare dashboard (DNS),"
    echo "    then re-run: cloudflared tunnel route dns ${TUNNEL_NAME} ${DOMAIN}"
  fi
  id cloudflared >/dev/null 2>&1 || useradd -r -m -d /home/cloudflared -s /usr/sbin/nologin cloudflared
  chown -R cloudflared:cloudflared /etc/cloudflared
  chmod 600 /etc/cloudflared/credentials.json /etc/cloudflared/config.yml
  cp "$APP_DIR/deploy/cloudflared.service" /etc/systemd/system/cloudflared.service
  sed -i "s#ExecStart=/usr/bin/cloudflared.*#ExecStart=/usr/bin/cloudflared --config /etc/cloudflared/config.yml tunnel run ${TUNNEL_NAME}#" /etc/systemd/system/cloudflared.service
  systemctl daemon-reload
  systemctl enable --now cloudflared
  systemctl restart cloudflared
fi

echo
echo "==> DONE. Verifying..."
systemctl status --no-pager leak-scanner || true
systemctl status --no-pager cloudflared || true
curl -sS --max-time 15 "https://${DOMAIN}/api/health" || echo "(health check via tunnel may lag DNS by a few seconds)"
echo
echo "Login at https://${DOMAIN} with ADMIN_EMAIL / ADMIN_PASSWORD (change the password after first login)."
