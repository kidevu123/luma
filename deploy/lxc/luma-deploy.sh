#!/usr/bin/env bash
# Pull main and re-up the Luma docker stack. Rebuilds when git HEAD or the
# running container SHA (health / .git-sha) diverges from the checkout.
#
# Installed by deploy/lxc/install.sh as the luma-deploy.service entrypoint.

set -euo pipefail

LUMA_DIR="${LUMA_DIR:-/opt/luma}"
LUMA_BRANCH="${LUMA_BRANCH:-main}"
APP_PORT="${APP_PORT:-3000}"

cd "$LUMA_DIR"

/usr/bin/git fetch --quiet origin "$LUMA_BRANCH"
before=$(/usr/bin/git rev-parse HEAD)
/usr/bin/git reset --hard --quiet "origin/$LUMA_BRANCH"
after=$(/usr/bin/git rev-parse HEAD)

export BUILD_GIT_SHA="$after"
export BUILD_GIT_BRANCH="$LUMA_BRANCH"

# Running container SHA: prefer baked stamp, fall back to /api/health (runtime truth).
read_running_sha() {
  local sha=""
  sha=$(/usr/bin/docker compose exec -T app cat /app/.git-sha 2>/dev/null | tr -d "[:space:]" || true)
  if [ -n "$sha" ] && [ "$sha" != "dev" ] && [ "$sha" != "unknown" ]; then
    echo "$sha"
    return 0
  fi
  if command -v curl >/dev/null 2>&1; then
    sha=$(
      curl -sf "http://127.0.0.1:${APP_PORT}/api/health" 2>/dev/null \
        | tr -d '\n' \
        | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -1 \
        || true
    )
    if [ -n "$sha" ] && [ "$sha" != "dev" ] && [ "$sha" != "local" ]; then
      echo "$sha"
      return 0
    fi
  fi
  return 1
}

running=""
if running=$(read_running_sha); then
  :
else
  running=""
fi

needs_build=false
if [ "$before" != "$after" ]; then
  echo "git head changed: ${before} -> ${after}"
  needs_build=true
elif [ -z "$running" ]; then
  echo "running SHA unknown — rebuilding to avoid source/container drift"
  needs_build=true
elif [ "$running" != "$after" ]; then
  echo "container drift: running=${running} head=${after} — rebuilding"
  needs_build=true
else
  echo "checkout and running container agree on ${after}"
fi

if [ "$needs_build" = true ]; then
  echo "docker compose up -d --build (Next.js app image must rebuild on code changes)"
  /usr/bin/docker compose up -d --build

  # Fail the unit if health never reports the new SHA (catches silent stale containers).
  for _ in $(seq 1 90); do
    if health=$(read_running_sha 2>/dev/null || true) && [ "$health" = "$after" ]; then
      echo "deploy verified: /api/health sha=${after}"
      exit 0
    fi
    sleep 5
  done
  echo "ERROR: deploy build finished but /api/health SHA never matched ${after}" >&2
  exit 1
else
  echo "no rebuild needed (${after}); ensuring services are up"
  /usr/bin/docker compose up -d
fi
