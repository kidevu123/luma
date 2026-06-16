# Manual-cutover plan — Phase 1: enable manual commit-now ONLY

**STATUS: PROPOSED — DO NOT EXECUTE WITHOUT EXPLICIT APPROVAL.**

This plan flips the live-write gates so operators can click
`Approve & commit now` / `Push to Zoho now` and the request actually
lands at the Zoho gateway. Auto-commit (cron) stays a no-op.

The plan is structured as: pre-checks → env flip → smoke a single
known-safe row → wait → post-checks → decision. Total wall time ~10
min for one safe row.

---

## Decision gates (must be true before flipping)

- [ ] Observation runbook (`deploy/OBSERVATION-zoho-staging-buffer.md`) all
      7 checks GREEN on at least one freshly-seeded raw-bag row and one
      freshly-seeded production-output op.
- [ ] No NEEDS_REVIEW or NEEDS_MAPPING surprises in the queue that
      haven't been triaged.
- [ ] One operator is on the floor or on call to manually trigger the
      first commit-now and watch it.
- [ ] An admin user has the Zoho gateway dashboard open
      (`http://192.168.1.205:8000` or whatever the gateway exposes for
      operators) so we can see the commit land in real time.
- [ ] Rollback commands (below) are pasted into a terminal and ready.
- [ ] **`ZOHO_WAREHOUSE_ID` is set in `/etc/luma/.env`** with an
      authoritative Zoho warehouse ID.

  This was an unmet blocker on the 2026-06-16 controlled-observation
  attempt: every historical row in `zoho_production_output_ops` has
  `zoho_warehouse_id = NULL` (the 2 committed ops used the
  consolidated/auto-finalize path which does not include a
  `warehouse_id` field in its payload). The operator-preview path
  (`buildProductionOutputPreviewPayload`) requires `warehouse_id` and
  short-circuits with `PAYLOAD_BLOCKED { field: "warehouse_id" }`
  when both the env default and the form value are empty.

  **Preferred source for the value:**
   1. Once the Zoho gateway exposes `/zoho/cached/warehouses/list`
      (planned for gateway v1.23.0), query that and let the operator
      pick from the response. Cached = no live Zoho call cost per
      preview.
   2. Until then, query the live `/zoho/warehouses/list` endpoint on
      the gateway IF the gateway exposes it AND the call is safe (no
      side effects). Cache the response in a small Luma-side table
      so we're not hitting Zoho on every preview.
   3. As a manual fallback, the operator/admin opens Zoho Inventory
      → Settings → Warehouses, copies the canonical warehouse ID,
      and sets `ZOHO_WAREHOUSE_ID=<id>` in `/etc/luma/.env`.

  Do NOT guess. An invalid warehouse ID will produce
  `NEEDS_MAPPING` rather than a useful test result, and a wrong-org
  warehouse ID could land the staged op against the wrong Zoho
  tenant if writes are ever enabled.

---

## Step 1 — pick the known-safe test candidates

Run these queries on LXC 122. Pick ONE row from each.

### Raw-bag receive — known-safe candidate

A "known-safe" raw-bag receive has:
- a real Zoho PO ID + line item ID (not legacy null)
- a tablet type with a Zoho item ID
- declared quantity > 0
- status PREVIEWED (already validated via preview)
- not held, not voided, not already committed
- `auto_commit_eligible_at` set (= seeded after v1.1.0)
- `commit_request_payload` frozen with notes

```sql
SELECT
  zrbr.id                                   AS op_id,
  zrbr.inventory_bag_id                     AS bag_id,
  zrbr.zoho_receive_status                  AS status,
  zrbr.zoho_purchaseorder_id                AS po_id,
  zrbr.zoho_purchaseorder_line_item_id      AS po_line,
  zrbr.zoho_received_quantity               AS qty,
  zrbr.auto_commit_eligible_at,
  (zrbr.commit_request_payload IS NOT NULL) AS frozen,
  length(zrbr.commit_request_payload->>'notes') AS notes_len,
  ib.internal_receipt_number                AS receipt
FROM zoho_raw_bag_receives zrbr
JOIN inventory_bags ib ON ib.id = zrbr.inventory_bag_id
WHERE zrbr.zoho_receive_status = 'PREVIEWED'
  AND zrbr.held_at IS NULL
  AND zrbr.voided_at IS NULL
  AND zrbr.committed_at IS NULL
  AND zrbr.zoho_purchaseorder_id IS NOT NULL
  AND zrbr.zoho_purchaseorder_line_item_id IS NOT NULL
  AND zrbr.zoho_received_quantity > 0
  AND zrbr.auto_commit_eligible_at IS NOT NULL
  AND zrbr.commit_request_payload IS NOT NULL
ORDER BY zrbr.created_at DESC
LIMIT 5;
```

Record the chosen `op_id`, `receipt`, and `qty` here:

```
RB_OP_ID    = __________________________________________
RB_RECEIPT  = __________________________________________
RB_QTY      = __________________________________________
```

### Production-output op — known-safe candidate

A "known-safe" production-output op has:
- status `APPROVED` or `QUEUED` (already through the preview/approve gate)
- products.zoho_live_commit_enabled = true (operator has trusted this product for live commit)
- a request_payload frozen with notes
- a commit_idempotency_key set
- not voided, not held

```sql
SELECT
  zop.id                                  AS op_id,
  zop.finished_lot_id                     AS lot_id,
  zop.status                              AS status,
  zop.luma_operation_id                   AS luma_op,
  zop.quantity_good                       AS units,
  zop.zoho_composite_item_id              AS unit_zoho_id,
  (zop.request_payload IS NOT NULL)       AS frozen,
  length(zop.request_payload->>'notes')   AS notes_len,
  zop.commit_idempotency_key IS NOT NULL  AS has_key,
  p.zoho_live_commit_enabled              AS product_live_commit_on,
  p.sku                                   AS product_sku
FROM zoho_production_output_ops zop
JOIN products p ON p.id = zop.product_id
WHERE zop.status IN ('APPROVED', 'QUEUED')
  AND zop.voided_at IS NULL
  AND zop.held_at IS NULL
  AND zop.committed_at IS NULL
  AND p.zoho_live_commit_enabled = true
  AND zop.request_payload IS NOT NULL
  AND zop.commit_idempotency_key IS NOT NULL
ORDER BY zop.created_at DESC
LIMIT 5;
```

Record the chosen `op_id`, `lot_id`, and `units` here:

```
PO_OP_ID    = __________________________________________
PO_LOT_ID   = __________________________________________
PO_UNITS    = __________________________________________
PO_SKU      = __________________________________________
```

**If either query returns 0 rows**, the cutover is BLOCKED. Either:
- wait for new intake / new finished lot that meets the criteria, or
- the operator must flip `products.zoho_live_commit_enabled = true`
  on at least one product before a production-output op can qualify.

---

## Step 2 — pre-check SQL (capture pre-state)

Run with the chosen op IDs substituted in.

```sql
\set RB_OP_ID '<paste op_id>'
\set PO_OP_ID '<paste op_id>'

-- Pre-state: raw-bag candidate
SELECT
  id, zoho_receive_status, commit_attempt_count,
  committed_at, zoho_purchase_receive_id,
  commit_idempotency_key,
  (commit_request_payload->>'notes') AS frozen_notes
FROM zoho_raw_bag_receives WHERE id = :'RB_OP_ID';

-- Pre-state: production-output candidate
SELECT
  id, status, commit_attempt_count,
  committed_at, external_reference_id,
  commit_idempotency_key,
  (request_payload->>'notes') AS frozen_notes
FROM zoho_production_output_ops WHERE id = :'PO_OP_ID';

-- Global guardrail: no live-write commits in last 30 min on either table
SELECT 'raw_bag' AS surface, count(*) FROM zoho_raw_bag_receives
  WHERE committed_at > now() - interval '30 minutes'
UNION ALL
SELECT 'production_output', count(*) FROM zoho_production_output_ops
  WHERE committed_at > now() - interval '30 minutes';
```

Expected pre-state:
- `commit_attempt_count = 0` (or whatever the buffer-tick history says)
- `committed_at IS NULL`
- `zoho_purchase_receive_id IS NULL` / `external_reference_id IS NULL`
- Global guardrail counts = `0`

---

## Step 3 — env flip (manual commit only; cron stays off)

**Run on LXC 122:**

```bash
ssh root@192.168.1.190
pct enter 122

# Update /etc/luma/.env — flip 3 keys, KEEP auto-commit OFF
sed -i 's/^ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=.*/ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=true/' /etc/luma/.env
sed -i 's/^ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=.*/ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=true/' /etc/luma/.env
sed -i 's/^ZOHO_DRY_RUN_WRITES_ENABLED=.*/ZOHO_DRY_RUN_WRITES_ENABLED=true/' /etc/luma/.env
# Confirm ZOHO_AUTO_COMMIT_ENABLED is STILL false
grep '^ZOHO_AUTO_COMMIT_ENABLED' /etc/luma/.env

# Recreate the container so the new env is picked up
cd /opt/luma
docker compose down
docker compose up -d
# Wait for health
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf http://localhost:3000/api/health >/dev/null; then break; fi
  sleep 5
done
curl -s http://localhost:3000/api/health

# Verify the flip
for v in ZOHO_AUTO_COMMIT_ENABLED ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED \
         ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED ZOHO_DRY_RUN_WRITES_ENABLED; do
  echo "$v = $(docker exec luma-app-1 sh -c "printenv $v")"
done
```

Expected env post-flip:
```
ZOHO_AUTO_COMMIT_ENABLED                  = false  ← KEEP OFF
ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED     = true   ← FLIPPED
ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED    = true   ← FLIPPED
ZOHO_DRY_RUN_WRITES_ENABLED               = true   ← FLIPPED
```

---

## Step 4 — fire one raw-bag commit-now by hand

1. Open `https://luma.<domain>/partial-bags/<RB_BAG_ID>/zoho-receive`
   in a browser (logged in as a LEAD or ADMIN).
2. Confirm the page shows the staging buttons.
3. Click **`Push to Zoho now`**.
4. Watch for:
   - Toast: *"Committed to Zoho."*  (✓ success)
   - Toast: *"Live commit disabled by env flag: ..."* (✗ env didn't take)
   - Toast: *"Needs business-decision review: ..."* (✗ over-receive; pick a different candidate)
   - Toast: *"Mapping fix required on the product: ..."* (✗ pick a different candidate)

---

## Step 5 — post-check SQL (raw-bag)

```sql
\set RB_OP_ID '<paste op_id>'

SELECT
  id,
  zoho_receive_status                  AS status,
  commit_attempt_count                 AS attempts,
  committed_at,
  zoho_purchase_receive_id,
  zoho_receive_number,
  commit_error,
  commit_response_payload IS NOT NULL  AS has_response
FROM zoho_raw_bag_receives
WHERE id = :'RB_OP_ID';
```

Expected post-commit state:
- `status = 'COMMITTED'`
- `attempts = 1` (one real attempt)
- `committed_at` populated
- `zoho_purchase_receive_id` populated (real Zoho ID)
- `commit_error IS NULL`
- `has_response = true`

Verify the **commit notes were appended** (contains the trigger line):

```sql
SELECT
  commit_response_payload->>'notes_echo' AS notes_echo  -- if the gateway echoes
FROM zoho_raw_bag_receives WHERE id = :'RB_OP_ID';
```

(If the gateway doesn't echo notes, check the gateway's audit log directly.)

---

## Step 6 — Zoho gateway log check (raw-bag)

```bash
ssh root@192.168.1.205    # the Zoho gateway LXC
# Tail the gateway logs for the commit that just landed
journalctl -u zoho-integration-service.service --since "5 minutes ago" \
  | grep -E "purchase_receive|bag-receive/commit"
```

Expected:
- Exactly ONE `POST /zoho/luma/bag-receive/commit` for the chosen op
- Idempotency key matches `commit_idempotency_key` from pre-check
- HTTP 200 / 201
- Gateway logs a `purchase_receive_id` returned

---

## Step 7 — fire one production-output commit-now by hand

1. Open `https://luma.<domain>/zoho-production-operations`.
2. Find the chosen `PO_OP_ID` row (status `APPROVED` or `QUEUED`).
3. Click **`Approve & commit now`**.
4. Watch for same toast outcomes as Step 4.

## Step 8 — post-check SQL (production-output)

```sql
\set PO_OP_ID '<paste op_id>'

SELECT
  id,
  status,
  commit_attempt_count                 AS attempts,
  committed_at,
  external_reference_id,
  zoho_receive_id,
  zoho_bundle_ids,
  commit_error,
  partial_failure,
  human_review_required,
  commit_response IS NOT NULL          AS has_response
FROM zoho_production_output_ops
WHERE id = :'PO_OP_ID';
```

Expected post-commit state:
- `status = 'COMMITTED'`
- `attempts = 1`
- `committed_at` populated
- `external_reference_id` populated
- `commit_error IS NULL`
- `partial_failure = false`
- `human_review_required = false`

## Step 9 — Zoho gateway log check (production-output)

```bash
ssh root@192.168.1.205
journalctl -u zoho-integration-service.service --since "5 minutes ago" \
  | grep -E "production-output|assemblies"
```

Expected:
- Exactly ONE `POST /zoho/luma/production-output/commit` for the
  chosen op
- Idempotency key matches `commit_idempotency_key` from pre-check
- HTTP 200 / 201

---

## Step 10 — global no-double-write check

```sql
-- Should be exactly 2 commits in the last 30 min (one per surface)
SELECT 'raw_bag' AS surface, count(*) FROM zoho_raw_bag_receives
  WHERE committed_at > now() - interval '30 minutes'
UNION ALL
SELECT 'production_output', count(*) FROM zoho_production_output_ops
  WHERE committed_at > now() - interval '30 minutes';

-- Idempotency replay sanity — try the same UI click again on either
-- row. The state machine should refuse with STATE_BLOCKED ("already
-- committed"). The gateway should never see a second POST.
```

Expected: `raw_bag = 1`, `production_output = 1`. A second click on
either row's commit button returns *"Op is already committed."* in
the UI toast.

---

## Step 11 — cron sanity (it MUST stay a no-op)

```bash
ssh root@192.168.1.190 'pct exec 122 -- journalctl -u luma-zoho-auto-commit.service --since "10 minutes ago" --no-pager' \
  | grep -E '"committed":[^0]'
```

Expected: **no lines match.** Cron's `gates.autoCommitEnabled` is
still `false`; sweep body still has `"committed":0` on every run.

If a cron sweep committed anything, the env flip leaked into the
cron path — STOP, rollback (Step 12), investigate.

---

## Step 12 — rollback commands

Use these the moment something looks wrong. They're idempotent.

### Hard stop (no live writes, no cron)

```bash
ssh root@192.168.1.190
pct enter 122

# 1. Flip the env back to OFF
sed -i 's/^ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=.*/ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=false/' /etc/luma/.env
sed -i 's/^ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=.*/ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=false/' /etc/luma/.env
sed -i 's/^ZOHO_DRY_RUN_WRITES_ENABLED=.*/ZOHO_DRY_RUN_WRITES_ENABLED=false/' /etc/luma/.env

# 2. Stop the cron timer (defence in depth)
systemctl stop luma-zoho-auto-commit.timer

# 3. Recreate container to load disabled env
cd /opt/luma && docker compose down && docker compose up -d

# 4. Verify
for v in ZOHO_AUTO_COMMIT_ENABLED ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED \
         ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED ZOHO_DRY_RUN_WRITES_ENABLED; do
  echo "$v = $(docker exec luma-app-1 sh -c "printenv $v")"
done
# All four should be false.

# 5. Re-enable the timer once env is confirmed off
systemctl start luma-zoho-auto-commit.timer
```

### If a bad commit DID land at Zoho

```sql
-- Find the bad row
SELECT id, zoho_purchase_receive_id, committed_at
FROM zoho_raw_bag_receives
WHERE committed_at > now() - interval '1 hour';

-- The next compensating step is to VOID it via the operator UI
-- (which sets voided_at + void_reason) AND to issue a void on the
-- Zoho side via the gateway. Do not delete the DB row — that breaks
-- the audit trail.
```

(Voiding-on-Zoho is the future overs-PO workflow's neighbour. For
v1.1.0 we don't have an automated void-on-Zoho yet — operator must
go to Zoho UI and void the purchase receive by hand.)

### Code-level rollback (worst case)

```bash
ssh root@192.168.1.190
pct exec 122 -- bash -c '
  cd /opt/luma
  git revert a697ad0 91509a1
  git push origin main  # NOTE: requires push access from the LXC; otherwise revert from your laptop
'
```

LXC deploy timer picks up the revert within 60s and rebuilds. The
v1.1.0 migrations are additive — the new columns and enum values
stay in place but become unused.

---

## Decision after Step 12

If all 12 steps GREEN:
- Two real Zoho commits landed (one per surface), no double-writes,
  cron unchanged, rollback rehearsed.
- **PROPOSE Phase 2** — flip `ZOHO_AUTO_COMMIT_ENABLED=true` so the
  cron starts auto-committing eligible rows.

If anything was RED:
- Roll back to observation mode (Step 12).
- Capture the failure in a follow-up task before any further cutover.
