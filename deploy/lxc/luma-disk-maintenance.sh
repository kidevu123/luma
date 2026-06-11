#!/usr/bin/env bash
# P5-OPS — disk pressure check + safe Docker cache pruning for LXC 122.
#
# Run manually or via a daily timer. Behavior:
#   1. Report disk usage for / and the Docker data root.
#   2. When usage exceeds WARN_PCT, prune SAFE Docker caches:
#      - dangling images (untagged build layers)
#      - stopped containers older than PRUNE_AGE
#      - unused build cache older than PRUNE_AGE
#      NEVER prunes volumes (Postgres data) or tagged images in use.
#   3. When usage still exceeds CRIT_PCT after pruning, exit 2 so a
#      monitoring hook can alert BEFORE a mid-day "no space left on
#      device" kills a build.
#
# Install (optional timer):
#   cp luma-disk-maintenance.sh /usr/local/bin/
#   systemd-run --on-calendar=daily /usr/local/bin/luma-disk-maintenance.sh

set -euo pipefail

WARN_PCT="${WARN_PCT:-75}"
CRIT_PCT="${CRIT_PCT:-90}"
PRUNE_AGE="${PRUNE_AGE:-72h}"

usage_pct() {
  df -P "$1" | awk 'NR==2 { gsub("%",""); print $5 }'
}

root_usage=$(usage_pct /)
docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo "/var/lib/docker")
docker_usage=$(usage_pct "$docker_root" 2>/dev/null || echo "$root_usage")

echo "disk usage: / = ${root_usage}%  ${docker_root} = ${docker_usage}%"
docker system df 2>/dev/null || true

worst=$(( root_usage > docker_usage ? root_usage : docker_usage ))

if [ "$worst" -lt "$WARN_PCT" ]; then
  echo "below ${WARN_PCT}% — no pruning needed"
  exit 0
fi

echo "usage ${worst}% >= ${WARN_PCT}% — pruning safe Docker caches (age > ${PRUNE_AGE})"
docker image prune -f --filter "dangling=true" || true
docker container prune -f --filter "until=${PRUNE_AGE}" || true
docker builder prune -f --filter "unused-for=${PRUNE_AGE}" || true

root_usage=$(usage_pct /)
docker_usage=$(usage_pct "$docker_root" 2>/dev/null || echo "$root_usage")
worst=$(( root_usage > docker_usage ? root_usage : docker_usage ))
echo "after prune: / = ${root_usage}%  ${docker_root} = ${docker_usage}%"

if [ "$worst" -ge "$CRIT_PCT" ]; then
  echo "ERROR: usage still ${worst}% >= ${CRIT_PCT}% after pruning — manual cleanup required" >&2
  exit 2
fi
