#!/usr/bin/env bash
# scripts/deploy.sh — ручной деплой на хосте (запускать от пользователя work).
# .env должен уже существовать. Этот скрипт его НЕ перезаписывает.
# CI-деплой (GitHub Actions) сначала пишет .env из Secrets, потом вызывает этот скрипт.
set -euo pipefail

REPO_DIR="/home/work/projects/budget-bot"
APP_NAME="budget-bot"
export PATH="/home/work/.yarn/bin:/home/linuxbrew/.linuxbrew/opt/node@24/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Preconditions
command -v node >/dev/null 2>&1 || { log "ERROR: node not found. Is Homebrew on PATH?"; exit 1; }
command -v yarn >/dev/null 2>&1 || { log "ERROR: yarn not found."; exit 1; }
command -v pm2  >/dev/null 2>&1 || { log "ERROR: pm2 not found. Run: yarn global add pm2"; exit 1; }
[ -f "${REPO_DIR}/.env" ]       || { log "ERROR: .env not found at ${REPO_DIR}/.env"; exit 1; }

cd "${REPO_DIR}"

log "Pulling origin/main..."
git fetch origin main
git reset --hard origin/main
log "HEAD: $(git rev-parse --short HEAD)"

log "Installing dependencies..."
yarn install --frozen-lockfile --production=false

log "Building TypeScript..."
yarn build

log "Restarting PM2 process..."
# pm2 reload = graceful restart: посылает SIGTERM → grammY вызывает bot.stop()
# Если процесс не найден в PM2 — запускаем через ecosystem-файл
pm2 reload "${APP_NAME}" --update-env || pm2 start ecosystem.config.cjs

sleep 2
if pm2 show "${APP_NAME}" | grep -q "online"; then
  log "SUCCESS: ${APP_NAME} is running."
  pm2 show "${APP_NAME}"
else
  log "FAILED to start ${APP_NAME}. Last logs:"
  pm2 logs "${APP_NAME}" --lines 30 --nostream
  exit 1
fi
