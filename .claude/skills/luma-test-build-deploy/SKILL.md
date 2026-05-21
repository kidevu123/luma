---
name: luma-test-build-deploy
description: Standardize the closeout of every Luma code phase. Run typecheck, vitest, next build, auth smoke. Verify staging. Report in the canonical shape.
---

# Luma test / build / deploy

## When this skill applies

Every code phase. Before declaring a phase complete, every one of
these commands must pass.

## Required commands

```bash
npx tsc --noEmit
npx vitest run
npx next build
# auth smoke runs INSIDE the container:
docker compose exec -T -e ALLOW_STAGING_QA_DATA=true app \
  sh -c 'node_modules/.bin/tsx scripts/smoke-authenticated-routes.ts'
```

Order matters: tsc first (fast), vitest second (catches logic),
next build third (catches route + bundle issues), auth smoke last
(needs a running app on staging).

## Staging verification checklist

1. Push the commit to `production-intelligence-command-center`.
2. Pull on LX122, run `docker compose up -d --build`. If the rename-
   conflict trap fires (orphan container with `<hash>_luma-app-1`
   name), recover via `docker compose down && docker compose up -d`.
3. Poll `http://192.168.1.134:3000/api/health` until the new SHA
   appears in the response.
4. Hit the affected route(s) — confirm they render under admin auth
   or return the documented error code without auth.
5. For schema changes: run the relevant `psql` query against the
   container's database.
6. For QA scripts: confirm the script exits 0 and cleans up its
   fixtures. Sweep for survivors.
7. Auth smoke: `PASS=N  REDIR=0  FAIL=0` with the expected route
   count.

## Final report shape

Every phase final report must answer, in order:

1. **Files changed** — table or bullet list.
2. **Behavior changed** — what the user / API now does differently.
3. **Tests added** — count + groups.
4. **Build / test / smoke results** — `tsc clean`, `vitest N/N`,
   `next build clean`, `auth smoke N/N PASS`.
5. **Staging verification** — SHA, route checks, DB checks, QA
   cleanup proof.
6. **Remaining gaps** — honest list of what's still unfinished.
7. **Next unchecked phase** — name + whether it's ready to start.

## Common traps

- The Luma LXC deploy script has a "build fail then skip" trap —
  always verify the running SHA matches the commit SHA before
  declaring success.
- Container rename conflicts on `docker compose up -d --build`
  require `docker compose down && docker compose up -d`. Standard
  pattern.
- Out-of-order `_journal.json` `when` timestamps silently skip
  migrations on populated DBs.
- `ALTER TYPE ADD VALUE` must be in its own migration file (see
  `luma-drizzle-migration`).

## What "passes" means

- `npx tsc --noEmit` → exit code 0, no error lines.
- `npx vitest run` → all tests pass, no skips that weren't already
  skipped.
- `npx next build` → exit 0, the new route appears in the route list
  if applicable.
- Auth smoke → `FAIL=0` with the expected `PASS=` count for the
  current route list.
- Staging health → JSON contains the new commit SHA.

Anything less than this is not a passing close-out.
