# Luma Versioning Policy

## Version scheme

`0.MINOR.PATCH` — where 0 means the platform is in active development and not yet at a stable public API.

| Change | Bump |
|--------|------|
| New feature, non-breaking | PATCH (`0.2.N+1`) |
| Breaking schema migration or major UX restructure | MINOR (`0.N+1.0`) |
| Bug fix / copy / polish | PATCH |
| Multi-feature release | PATCH (batch it) |

We do **not** use `1.0.0` until the platform is handed off and considered stable.

## How to bump

1. Edit `package.json` → `"version"`:  `"0.2.N"` → `"0.2.N+1"`
2. Add a `## [0.2.N+1] — YYYY-MM-DD` section to `CHANGELOG.md` before the previous entry.
3. Commit: `git commit -m "chore: bump to v0.2.N+1"`
4. Push: `git push` — the deploy timer picks up main within 60 s.

## Deployment verification

After pushing, confirm the container has swapped:

```bash
npm run verify:deploy
# or with a custom host:
LUMA_HOST=http://192.168.1.134:3000 npm run verify:deploy
```

The script calls `/api/health`, which returns the `sha` baked into the image at build time, and compares it against `git rev-parse HEAD`. A SHA mismatch means the deploy is still in progress (normal — allow up to 5 minutes for the timer to fire and `docker compose build` to complete).

## How the deploy works

1. **systemd timer** (`luma-deploy.timer`) fires every 60 s on LXC 122 (`192.168.1.134`).
2. `luma-deploy.service` runs `git pull` on `/opt/luma`.
3. It compares the new HEAD (`$after`) against the SHA baked into the running container (`docker exec app cat /app/.git-sha`).
4. If they differ (or if the stamp file drifted), it exports `BUILD_GIT_SHA` and `BUILD_GIT_BRANCH` then runs `docker compose up -d --build`.
5. The Dockerfile bakes `BUILD_GIT_SHA`, `BUILD_GIT_BRANCH`, and `BUILD_AT` into the image via `ENV` statements in the run stage. These values surface in `/api/health` (sha field) and the admin footer.

## Build metadata in the footer

| Env var | Source | Displayed when |
|---------|--------|----------------|
| `BUILD_GIT_SHA` | `--build-arg` from deploy service | Always; shows first 7 chars ("local" in dev) |
| `BUILD_GIT_BRANCH` | `--build-arg` from deploy service | When set (omitted in dev) |
| `BUILD_AT` | `--build-arg` from deploy service | When set and not "unknown" |

`BUILD_AT` is derived from `git log -1 --format=%ci HEAD` at build time. Because `.git` is excluded from the Docker build context (`.dockerignore`), this often yields "unknown" — which the footer suppresses. The SHA and branch are passed explicitly by the deploy script so they are always accurate.
