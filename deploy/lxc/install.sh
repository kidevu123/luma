#!/usr/bin/env bash
# Provisioning script — run once inside LXC 122 to install Luma.
# Idempotent: re-runnable safely.

set -euo pipefail

REPO_URL="${LUMA_REPO_URL:-https://github.com/kidevu123/luma.git}"
BRANCH="${LUMA_BRANCH:-main}"
DIR="/opt/luma"

echo "[install] cloning ${REPO_URL} into ${DIR}…"
if [ -d "${DIR}/.git" ]; then
  cd "${DIR}"
  git fetch --quiet origin "${BRANCH}"
  git reset --hard --quiet "origin/${BRANCH}"
else
  git clone --quiet --branch "${BRANCH}" "${REPO_URL}" "${DIR}"
fi

echo "[install] writing /etc/luma/.env (mode 0600)…"
mkdir -p /etc/luma
if [ ! -f /etc/luma/.env ]; then
  python3 -c 'import secrets; print("AUTH_SECRET=" + secrets.token_urlsafe(48))' > /etc/luma/.env
  python3 -c 'import secrets; print("POSTGRES_PASSWORD=" + secrets.token_urlsafe(24))' >> /etc/luma/.env
  cat >> /etc/luma/.env <<EOF
APP_URL=http://192.168.1.134:3000
APP_PORT=3000
OTEL_PROM_HOST_PORT=9464
ZOHO_INTEGRATION_URL=http://192.168.1.190:9503
NODE_ENV=production
EOF
  chmod 0600 /etc/luma/.env
  echo "[install] generated /etc/luma/.env"
else
  echo "[install] /etc/luma/.env exists; leaving alone"
fi

# Symlink .env into the project so docker-compose picks it up.
ln -sf /etc/luma/.env "${DIR}/.env"

echo "[install] enabling deploy timer…"
cp "${DIR}/deploy/lxc/luma-deploy.service" /etc/systemd/system/luma-deploy.service
cp "${DIR}/deploy/lxc/luma-deploy.timer"   /etc/systemd/system/luma-deploy.timer
systemctl daemon-reload
systemctl enable --now luma-deploy.timer
systemctl start luma-deploy.service || true

echo "[install] done. Health: curl -s http://localhost:3000/api/health"
