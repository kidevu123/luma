# Luma Zoho auto-commit cron — deploy + operations runbook

## Files in this directory

- `luma-zoho-auto-commit.service` — systemd service unit (one-shot curl)
- `luma-zoho-auto-commit.timer`   — systemd timer (every 5 min, persistent)

## What the cron does

Every 5 minutes, the timer triggers the service, which `POST`s to
`http://localhost:3000/api/cron/zoho-auto-commit` with a bearer
token. The route:

1. Validates the bearer against `LUMA_CRON_SECRET`.
2. Reads the live-write gates (`ZOHO_AUTO_COMMIT_ENABLED`,
   `ZOHO_DRY_RUN_WRITES_ENABLED`,
   `ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED` chain).
3. Loads eligible rows (`auto_commit_eligible_at <= now()`, not held,
   not voided, in a committable status).
4. For each row:
   - If the surface's writes-gate is OFF → logs `skipped_guard_blocked`,
     **no claim**, no state change, no retry-budget burn.
   - Else → calls the shared idempotent commit function
     (`sharedCommitRawBagReceive` / `sharedCommitProductionOutputOp`)
     with `source: "auto"`. Same fn the manual UI button uses.
5. Writes one umbrella audit row + per-row audit rows from the
   shared fns.
6. Returns a JSON summary; the systemd journal captures it.

## First-deploy posture (v1.1.0)

**Live-WRITE gates OFF; preview/persist ON so the staging system
itself works.** The cron and the manual button will both refuse to
make Zoho writes via the GUARD_BLOCKED path; everything else
(previews, frozen payloads, accounting notes, the operator queue,
hold/void/unhold actions) is fully functional.

Important: **do not turn `ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED` or
`ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED` off** — those gate the
staging system itself. Persist disabled → ops never reach the DB,
queue is empty. Preview disabled → operators can't review what would
be sent. The chain `commit → preview → persist` only refuses
**commits** when commit is off and the others are on.

`/etc/luma/.env` additions (mode 0600, in the luma-app container):

```env
# Cron auth — generate with: openssl rand -base64 32
LUMA_CRON_SECRET=<generate-32-bytes-base64>

# Cron master switch + buffer length
ZOHO_AUTO_COMMIT_ENABLED=false              # cron is a no-op
ZOHO_AUTO_COMMIT_BUFFER_HOURS=24

# Live-write gates (the actual "no Zoho writes" guardrails)
ZOHO_DRY_RUN_WRITES_ENABLED=false           # raw-bag commits refuse
ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=false # production-output commits refuse
ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=false # bag-finish commits refuse

# Staging system — KEEP ON so the queue + previews work
ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED=true
ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED=true
```

### Expected behaviour with this posture

| Action | Result |
|---|---|
| Operator runs preview | ✅ works, gateway preview endpoint returns 2xx, op persists to `zoho_production_output_ops` |
| Operator opens production-output queue | ✅ rows appear with status chips, Hold/Void/Approve buttons visible |
| Operator clicks "Approve for auto-commit" | ✅ row transitions APPROVED → QUEUED, `auto_commit_eligible_at` is stamped (or null if `ZOHO_AUTO_COMMIT_ENABLED=false`) |
| Operator clicks "Approve & commit now" | ❌ refuses with `GUARD_BLOCKED`: *"Live commit disabled by env flag: ..."*. Gateway client never called. `commit_attempt_count` untouched. |
| Operator clicks "Push to Zoho now" on raw-bag receive | ❌ same — `GUARD_BLOCKED` |
| Cron timer fires | ✅ sweep runs, audit row written, every row gets `skipped_master_off` (because `ZOHO_AUTO_COMMIT_ENABLED=false`). When flipped to `true`, every row gets `skipped_guard_blocked` instead. |
| Operator holds / unholds / voids a staged op | ✅ all work; auto-commit eligibility is re-stamped on unhold |
| Operator edits a bag with a staged op | ✅ payload is re-frozen via `regenerateFrozenRawBagReceivePayload`: new idempotency key, fresh `auto_commit_eligible_at` |

`/etc/luma/zoho-cron.env` on the LXC host (NOT in the container —
this is what the systemd service reads, mode 0600 root:root):

```env
LUMA_CRON_SECRET=<same-secret-as-above>
```

## Install commands (on LXC 122 `luma`)

```bash
# 1. Drop the unit files into systemd's load path
sudo cp /opt/luma/deploy/luma-zoho-auto-commit.service /etc/systemd/system/
sudo cp /opt/luma/deploy/luma-zoho-auto-commit.timer   /etc/systemd/system/

# 2. Drop the host-side env file with the bearer secret
sudo install -o root -g root -m 0600 /dev/null /etc/luma/zoho-cron.env
sudo sh -c 'echo "LUMA_CRON_SECRET=<paste-secret>" > /etc/luma/zoho-cron.env'
sudo chmod 0600 /etc/luma/zoho-cron.env

# 3. Reload systemd, enable and start the timer
sudo systemctl daemon-reload
sudo systemctl enable --now luma-zoho-auto-commit.timer
```

## Verification commands

```bash
# Timer enabled + when it next fires
sudo systemctl status luma-zoho-auto-commit.timer
sudo systemctl list-timers luma-zoho-auto-commit.timer

# Last service run
sudo systemctl status luma-zoho-auto-commit.service
sudo journalctl -u luma-zoho-auto-commit.service -n 50 --no-pager

# Trigger a one-off run by hand (auth via host env file)
sudo systemctl start luma-zoho-auto-commit.service

# Direct curl test (uses the env file's secret)
sudo bash -c 'set -a; source /etc/luma/zoho-cron.env; set +a; \
  curl -s -X POST \
    -H "Authorization: Bearer $LUMA_CRON_SECRET" \
    -H "Content-Type: application/json" \
    http://localhost:3000/api/cron/zoho-auto-commit'
```

Expected first-deploy response (master switch off):

```json
{
  "ok": true,
  "summary": {
    "gates": {
      "autoCommitEnabled": false,
      "rawBagWritesAllowed": false,
      "productionOutputWritesAllowed": false,
      "reasons": {
        "autoCommit": "ZOHO_AUTO_COMMIT_ENABLED is not 'true'.",
        "rawBag": "ZOHO_DRY_RUN_WRITES_ENABLED is not 'true'.",
        "productionOutput": "ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED chain is not satisfied."
      }
    },
    "rawBagEligibleConsidered": 0,
    "productionOutputEligibleConsidered": 0,
    "rows": [],
    "totals": { "committed": 0, "skipped_master_off": 0, ... }
  }
}
```

If you flip only `ZOHO_AUTO_COMMIT_ENABLED=true` to exercise the
claim/skip path (without enabling writes), expected response:

```json
{
  "ok": true,
  "summary": {
    "gates": { "autoCommitEnabled": true, "rawBagWritesAllowed": false, ... },
    "rawBagEligibleConsidered": <N>,
    "productionOutputEligibleConsidered": <M>,
    "rows": [
      {
        "surface": "raw_bag_receive",
        "opId": "...",
        "outcome": "skipped_guard_blocked",
        "detail": "ZOHO_DRY_RUN_WRITES_ENABLED is not 'true'."
      }
    ],
    "totals": { "skipped_guard_blocked": <N + M>, "committed": 0, ... }
  }
}
```

## Smoke test the auth path

These should ALL return non-200 — proof the route is locked:

```bash
# 1. No header → 401
curl -sw '\n%{http_code}\n' -X POST http://localhost:3000/api/cron/zoho-auto-commit
# Expected: 401

# 2. Wrong secret → 401
curl -sw '\n%{http_code}\n' -X POST \
  -H "Authorization: Bearer wrong-secret" \
  http://localhost:3000/api/cron/zoho-auto-commit
# Expected: 401

# 3. Wrong scheme → 401
curl -sw '\n%{http_code}\n' -X POST \
  -H "Authorization: Basic ZHVtbXk=" \
  http://localhost:3000/api/cron/zoho-auto-commit
# Expected: 401

# 4. GET → 405
curl -sw '\n%{http_code}\n' http://localhost:3000/api/cron/zoho-auto-commit
# Expected: 405
```

## Rollback / disable

If anything goes sideways, stop the timer immediately:

```bash
# Stop + disable the timer (instant)
sudo systemctl disable --now luma-zoho-auto-commit.timer

# Confirm it's gone
sudo systemctl status luma-zoho-auto-commit.timer

# If you want to keep the unit files but disable auto-runs:
sudo systemctl stop luma-zoho-auto-commit.timer
sudo systemctl mask luma-zoho-auto-commit.timer
```

Or kill the master switch by flipping `ZOHO_AUTO_COMMIT_ENABLED=false`
in `/etc/luma/.env` and `docker compose up -d luma-app`. The cron
will still run and audit, but every row gets `skipped_master_off`.

## Phased cutover after first deploy

Once the first-deploy posture is verified:

1. **Phase 1 — enable manual commit-now only:**
   `ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=true`, all three
   persist/preview/commit on, `ZOHO_DRY_RUN_WRITES_ENABLED=true`,
   `ZOHO_AUTO_COMMIT_ENABLED=false`. Operators can push by hand;
   cron stays a no-op.

2. **Phase 2 — enable auto-commit:**
   `ZOHO_AUTO_COMMIT_ENABLED=true`. Cron now pushes eligible rows.
   Confirm at least one full buffer cycle (24h) without surprises.

3. **Phase 3 — tighten as needed:** reduce buffer hours, adjust the
   per-pass limit (`PER_PASS_LIMIT` in
   `lib/zoho/auto-commit-sweep.ts`), etc.
