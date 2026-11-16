#!/usr/bin/env bash
#
# Deploys budget-bot as a Docker image to the netcup host (replaces scripts/deploy.sh + PM2).
# No registry: GitHub Actions is unavailable (billing), so the image travels over SSH.
#
#   scripts/deploy-docker.sh [--host ALIAS] [--allow-dirty]
#
# The host alias (default: $DEPLOY_HOST or `netcup`) must log in as a user that can run docker.
# Build: linux/amd64 on this machine. Switch: /srv/budget-bot/tag.env + `docker compose up -d --wait`.
# On a failed health check the previous tag is restored. The last 3 images are kept.
# Server side: ops repo, hosts/netcup/srv/budget-bot/compose.yml.
set -euo pipefail

HOST=${DEPLOY_HOST:-netcup}
ALLOW_DIRTY=0
while [ $# -gt 0 ]; do
  case $1 in
    --host) HOST=${2:?--host needs an alias}; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."
if [ "$ALLOW_DIRTY" = 0 ] && [ -n "$(git status --porcelain)" ]; then
  echo "working tree is dirty: commit first or pass --allow-dirty" >&2
  exit 1
fi
TAG=$(git rev-parse --short=12 HEAD)
IMAGE=budget-bot:$TAG
SSH=(ssh -o BatchMode=yes -o ServerAliveInterval=15)

echo "==> build $IMAGE (linux/amd64)"
docker buildx build --platform linux/amd64 --load --label "org.opencontainers.image.revision=$TAG" -t "$IMAGE" .

echo "==> send to $HOST"
docker save "$IMAGE" | gzip | "${SSH[@]}" "$HOST" 'gunzip | docker load'

echo "==> switch on $HOST"
"${SSH[@]}" "$HOST" "TAG=$TAG bash -s" <<'REMOTE'
set -euo pipefail
cd /srv/budget-bot
exec 9>.deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

compose() { docker compose -f /srv/budget-bot/compose.yml --env-file tag.env "$@"; }
prev=$(sed -n 's/^BUDGET_BOT_TAG=//p' tag.env 2>/dev/null || true)

# rename is atomic: tag.env is never half-written.
set_tag() { printf 'BUDGET_BOT_TAG=%s\n' "$1" >tag.env.new && mv -f tag.env.new tag.env; }

set_tag "$TAG"
# Long polling has no URL to curl: --wait covers the container healthcheck, and the extra
# pause catches a bot that exits right after start (restart counter or non-running state).
healthy() {
  compose up -d --wait --wait-timeout 90 || return 1
  sleep 8
  [ "$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$(compose ps -q bot)")" = "running 0" ]
}

if healthy; then
  echo "up: budget-bot:$TAG"
else
  echo "health check failed" >&2
  if [ -n "$prev" ]; then
    set_tag "$prev"
    healthy && echo "rolled back to budget-bot:$prev" >&2
  fi
  exit 1
fi

# Newest first; keep three, never remove the running tag or the previous one.
docker image ls budget-bot --format '{{.Tag}}' | tail -n +4 | while read -r old; do
  [ "$old" = "$TAG" ] || [ "$old" = "$prev" ] || docker rmi "budget-bot:$old" >/dev/null || true
done
REMOTE

echo "done: $IMAGE on $HOST"
